use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rand_core::{OsRng, RngCore};
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    crypto::{
        default_cipher_info, default_kdf_params, derive_key, now_iso, open_payload, seal_payload,
        VAULT_MAGIC,
    },
    legacy,
    models::{
        GeneratePasswordOptions, ImportPreview, ImportPreviewEntry, VaultData, VaultEntry,
        VaultEnvelope, VaultHeader, VaultStatus,
    },
};

pub type SharedVaultManager = Mutex<VaultManager>;

#[derive(Default)]
pub struct VaultManager {
    session: Option<VaultSession>,
    pending_imports: HashMap<String, Vec<VaultEntry>>,
}

struct VaultSession {
    path: String,
    header: VaultHeader,
    key: Zeroizing<[u8; 32]>,
    data: VaultData,
    base_entries: Vec<VaultEntry>,
    loaded_revision: u64,
}

// ---------------------------------------------------------------------------
// Core vault logic. These inherent methods hold the real behaviour so they can
// be unit-tested directly against a `VaultManager`; the `#[tauri::command]`
// functions below are thin wrappers that lock the shared state and delegate.
// ---------------------------------------------------------------------------
impl VaultManager {
    pub fn create(&mut self, path: String, master_password: String) -> Result<VaultStatus, String> {
        validate_password(&master_password)?;
        let now = now_iso();
        let kdf = default_kdf_params();
        let key = derive_key(&master_password, &kdf)?;
        let mut header = VaultHeader {
            magic: VAULT_MAGIC.to_string(),
            version: 1,
            vault_id: Uuid::new_v4().to_string(),
            kdf,
            cipher: default_cipher_info(),
            nonce: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        let data = VaultData {
            revision: 0,
            device_id: Uuid::new_v4().to_string(),
            entries: Vec::new(),
            settings: serde_json::json!({}),
        };

        let payload = seal_payload(&data, &mut header, &key[..])?;
        write_envelope(
            &path,
            &VaultEnvelope {
                header: header.clone(),
                payload,
            },
        )?;

        self.session = Some(VaultSession {
            path,
            header,
            key,
            data,
            base_entries: Vec::new(),
            loaded_revision: 0,
        });

        Ok(self.session.as_ref().unwrap().status())
    }

    pub fn unlock(&mut self, path: String, master_password: String) -> Result<VaultStatus, String> {
        let envelope = read_envelope(&path)?;
        validate_header(&envelope.header)?;
        let key = derive_key(&master_password, &envelope.header.kdf)?;
        let data: VaultData = open_payload(&envelope.payload, &envelope.header, &key[..])
            .map_err(|_| "master_password_incorrect".to_string())?;

        self.session = Some(VaultSession {
            path,
            header: envelope.header,
            key,
            base_entries: data.entries.clone(),
            loaded_revision: data.revision,
            data,
        });

        Ok(self.session.as_ref().unwrap().status())
    }

    pub fn lock(&mut self) {
        self.session = None;
    }

    pub fn list(&self) -> Result<Vec<VaultEntry>, String> {
        let session = self.session.as_ref().ok_or_else(|| "vault_locked".to_string())?;
        Ok(visible_entries(&session.data.entries))
    }

    pub fn upsert(&mut self, mut entry: VaultEntry) -> Result<Vec<VaultEntry>, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let now = now_iso();

        entry.title = entry.title.trim().to_string();
        if entry.title.is_empty() {
            return Err("entry_title_required".to_string());
        }

        if entry.id.trim().is_empty() {
            entry.id = Uuid::new_v4().to_string();
            entry.created_at = now.clone();
        } else if entry.created_at.is_empty() {
            entry.created_at = now.clone();
        }
        entry.updated_at = now;
        entry.deleted_at = None;

        if let Some(existing) = session.data.entries.iter_mut().find(|item| item.id == entry.id) {
            *existing = entry;
        } else {
            session.data.entries.push(entry);
        }

        save_session(session)?;
        Ok(visible_entries(&session.data.entries))
    }

    pub fn delete(&mut self, id: String) -> Result<Vec<VaultEntry>, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let now = now_iso();

        if let Some(entry) = session.data.entries.iter_mut().find(|item| item.id == id) {
            entry.deleted_at = Some(now.clone());
            entry.updated_at = now;
        }

        save_session(session)?;
        Ok(visible_entries(&session.data.entries))
    }

    pub fn change_password(
        &mut self,
        old_password: String,
        new_password: String,
    ) -> Result<VaultStatus, String> {
        validate_password(&new_password)?;
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let old_key = derive_key(&old_password, &session.header.kdf)?;
        if old_key[..] != session.key[..] {
            return Err("master_password_incorrect".to_string());
        }

        // Absorb any concurrent remote edits while we still hold the OLD key,
        // so a change made on another device is not lost during rotation.
        merge_remote_changes(session)?;

        // Re-key with a fresh salt + derived key. We persist directly instead of
        // going through `save_session`, because that would call
        // `merge_remote_changes` again and try to decrypt the on-disk file (still
        // sealed with the OLD key) using the NEW key, which always fails.
        let new_kdf = default_kdf_params();
        let new_key = derive_key(&new_password, &new_kdf)?;
        let prev_kdf = session.header.kdf.clone();
        let prev_key = session.key.clone();
        session.header.kdf = new_kdf;
        session.key = new_key;

        match persist_session(session) {
            Ok(status) => Ok(status),
            Err(error) => {
                // Roll back so the in-memory session stays consistent with disk.
                session.header.kdf = prev_kdf;
                session.key = prev_key;
                Err(error)
            }
        }
    }

    pub fn save(&mut self) -> Result<VaultStatus, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        save_session(session)
    }

    pub fn export_copy(&mut self, path: String) -> Result<VaultStatus, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let status = save_session(session)?;
        ensure_parent_dir(&path)?;
        fs::copy(&session.path, &path).map_err(|e| e.to_string())?;
        Ok(status)
    }

    pub fn import_preview(
        &mut self,
        path: String,
        legacy_password: Option<String>,
    ) -> Result<ImportPreview, String> {
        let entries = legacy::import_legacy_entries(&path, legacy_password)?;
        let import_id = Uuid::new_v4().to_string();
        let preview_entries = entries
            .iter()
            .take(50)
            .map(|entry| ImportPreviewEntry {
                title: entry.title.clone(),
                username: entry.username.clone(),
                url: entry.url.clone(),
                has_password: !entry.password.is_empty(),
            })
            .collect::<Vec<_>>();

        let count = entries.len();
        self.pending_imports.insert(import_id.clone(), entries);

        Ok(ImportPreview {
            import_id,
            count,
            entries: preview_entries,
        })
    }

    pub fn import_commit(&mut self, import_id: String) -> Result<Vec<VaultEntry>, String> {
        let mut entries = self
            .pending_imports
            .remove(&import_id)
            .ok_or_else(|| "import_not_found".to_string())?;
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let now = now_iso();

        for entry in entries.iter_mut() {
            entry.id = Uuid::new_v4().to_string();
            entry.created_at = now.clone();
            entry.updated_at = now.clone();
            entry.deleted_at = None;
            entry.conflict = false;
        }

        session.data.entries.extend(entries);
        save_session(session)?;
        Ok(visible_entries(&session.data.entries))
    }
}

// ---------------------------------------------------------------------------
// Tauri command wrappers.
// ---------------------------------------------------------------------------
macro_rules! manager {
    ($state:expr) => {
        $state.lock().map_err(|_| "vault_state_poisoned".to_string())?
    };
}

#[tauri::command]
pub fn create_vault(
    path: String,
    master_password: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultStatus, String> {
    manager!(state).create(path, master_password)
}

#[tauri::command]
pub fn unlock_vault(
    path: String,
    master_password: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultStatus, String> {
    manager!(state).unlock(path, master_password)
}

#[tauri::command]
pub fn lock_vault(state: State<'_, SharedVaultManager>) -> Result<(), String> {
    manager!(state).lock();
    Ok(())
}

#[tauri::command]
pub fn list_entries(state: State<'_, SharedVaultManager>) -> Result<Vec<VaultEntry>, String> {
    manager!(state).list()
}

#[tauri::command]
pub fn upsert_entry(
    entry: VaultEntry,
    state: State<'_, SharedVaultManager>,
) -> Result<Vec<VaultEntry>, String> {
    manager!(state).upsert(entry)
}

#[tauri::command]
pub fn delete_entry(
    id: String,
    state: State<'_, SharedVaultManager>,
) -> Result<Vec<VaultEntry>, String> {
    manager!(state).delete(id)
}

#[tauri::command]
pub fn change_master_password(
    old_password: String,
    new_password: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultStatus, String> {
    manager!(state).change_password(old_password, new_password)
}

#[tauri::command]
pub fn save_vault(state: State<'_, SharedVaultManager>) -> Result<VaultStatus, String> {
    manager!(state).save()
}

#[tauri::command]
pub fn export_vault_copy(
    path: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultStatus, String> {
    manager!(state).export_copy(path)
}

#[tauri::command]
pub fn import_legacy_preview(
    path: String,
    legacy_password: Option<String>,
    state: State<'_, SharedVaultManager>,
) -> Result<ImportPreview, String> {
    manager!(state).import_preview(path, legacy_password)
}

#[tauri::command]
pub fn import_legacy_commit(
    import_id: String,
    state: State<'_, SharedVaultManager>,
) -> Result<Vec<VaultEntry>, String> {
    manager!(state).import_commit(import_id)
}

#[tauri::command]
pub fn generate_password(options: GeneratePasswordOptions) -> Result<String, String> {
    let length = options.length.clamp(8, 256);
    let mut groups: Vec<&[u8]> = Vec::new();
    if options.uppercase {
        groups.push(b"ABCDEFGHJKLMNPQRSTUVWXYZ");
    }
    if options.lowercase {
        groups.push(b"abcdefghijkmnopqrstuvwxyz");
    }
    if options.numbers {
        groups.push(b"23456789");
    }
    if options.symbols {
        groups.push(b"!@#$%^&*()-_=+[]{};:,.?");
    }
    if groups.is_empty() {
        return Err("password_generator_empty_charset".to_string());
    }

    let mut chars = Vec::new();
    for group in &groups {
        chars.push(random_pick(group));
    }

    let all = groups.concat();
    while chars.len() < length {
        chars.push(random_pick(&all));
    }
    shuffle(&mut chars);
    String::from_utf8(chars).map_err(|_| "password_generator_failed".to_string())
}

fn save_session(session: &mut VaultSession) -> Result<VaultStatus, String> {
    merge_remote_changes(session)?;
    persist_session(session)
}

/// Seal the current in-memory data with the session key and write it atomically.
/// Does NOT merge from disk first — callers that need a merge use `save_session`.
fn persist_session(session: &mut VaultSession) -> Result<VaultStatus, String> {
    session.data.revision = session.data.revision.saturating_add(1);
    session.header.updated_at = now_iso();
    let payload = seal_payload(&session.data, &mut session.header, &session.key[..])?;
    let envelope = VaultEnvelope {
        header: session.header.clone(),
        payload,
    };
    write_envelope(&session.path, &envelope)?;

    session.loaded_revision = session.data.revision;
    session.base_entries = session.data.entries.clone();
    Ok(session.status())
}

fn merge_remote_changes(session: &mut VaultSession) -> Result<(), String> {
    if !Path::new(&session.path).exists() {
        return Ok(());
    }

    let envelope = read_envelope(&session.path)?;
    if envelope.header.vault_id != session.header.vault_id {
        return Err("vault_id_mismatch".to_string());
    }

    let disk_data: VaultData = open_payload(&envelope.payload, &envelope.header, &session.key[..])
        .map_err(|_| "vault_changed_and_cannot_merge".to_string())?;
    if disk_data.revision <= session.loaded_revision {
        return Ok(());
    }

    session.data.entries = merge_entries(&session.base_entries, &disk_data.entries, &session.data.entries);
    session.data.settings = disk_data.settings;
    session.data.revision = disk_data.revision.max(session.data.revision);
    session.header = envelope.header;
    Ok(())
}

fn merge_entries(base: &[VaultEntry], disk: &[VaultEntry], local: &[VaultEntry]) -> Vec<VaultEntry> {
    let base_by_id = base.iter().map(|entry| (entry.id.clone(), entry)).collect::<HashMap<_, _>>();
    let mut merged = disk.iter().map(|entry| (entry.id.clone(), entry.clone())).collect::<HashMap<_, _>>();
    let mut conflict_ids = HashSet::new();

    for local_entry in local {
        let base_entry = base_by_id.get(&local_entry.id).copied();
        let disk_entry = merged.get(&local_entry.id).cloned();

        match disk_entry {
            Some(disk_entry) => {
                let local_changed = changed_since_base(base_entry, local_entry);
                let disk_changed = changed_since_base(base_entry, &disk_entry);
                if local_changed && disk_changed && content_differs(local_entry, &disk_entry) {
                    let mut conflict = local_entry.clone();
                    conflict.id = Uuid::new_v4().to_string();
                    conflict.conflict = true;
                    conflict.title = format!("{} (conflict)", conflict.title);
                    conflict_ids.insert(conflict.id.clone());
                    merged.insert(conflict.id.clone(), conflict);
                } else if local_changed || local_entry.updated_at > disk_entry.updated_at {
                    merged.insert(local_entry.id.clone(), local_entry.clone());
                }
            }
            None => {
                if changed_since_base(base_entry, local_entry) {
                    merged.insert(local_entry.id.clone(), local_entry.clone());
                }
            }
        }
    }

    let mut values = merged.into_values().collect::<Vec<_>>();
    values.sort_by(|a, b| {
        let a_key = (!conflict_ids.contains(&a.id), a.title.to_lowercase(), a.username.to_lowercase());
        let b_key = (!conflict_ids.contains(&b.id), b.title.to_lowercase(), b.username.to_lowercase());
        a_key.cmp(&b_key)
    });
    values
}

fn changed_since_base(base: Option<&VaultEntry>, entry: &VaultEntry) -> bool {
    match base {
        Some(base) => base.updated_at != entry.updated_at || base.deleted_at != entry.deleted_at,
        None => true,
    }
}

fn content_differs(a: &VaultEntry, b: &VaultEntry) -> bool {
    a.title != b.title
        || a.username != b.username
        || a.password != b.password
        || a.url != b.url
        || a.notes != b.notes
        || a.deleted_at != b.deleted_at
}

fn visible_entries(entries: &[VaultEntry]) -> Vec<VaultEntry> {
    let mut visible = entries
        .iter()
        .filter(|entry| entry.deleted_at.is_none())
        .cloned()
        .collect::<Vec<_>>();
    visible.sort_by(|a, b| {
        (a.title.to_lowercase(), a.username.to_lowercase())
            .cmp(&(b.title.to_lowercase(), b.username.to_lowercase()))
    });
    visible
}

fn read_envelope(path: &str) -> Result<VaultEnvelope, String> {
    let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|_| "vault_file_invalid".to_string())
}

fn write_envelope(path: &str, envelope: &VaultEnvelope) -> Result<(), String> {
    ensure_parent_dir(path)?;
    let data = serde_json::to_vec_pretty(envelope).map_err(|e| e.to_string())?;
    let target = PathBuf::from(path);
    let tmp = target.with_file_name(format!(
        ".{}.{}.tmp",
        target.file_name().and_then(|v| v.to_str()).unwrap_or("vault"),
        Uuid::new_v4()
    ));

    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    // The temp file lives in the same directory as the target, so the rename is
    // a same-volume atomic replace on both Windows and Unix. If it fails we
    // leave the existing vault untouched rather than risk a torn non-atomic
    // overwrite of a password vault.
    if let Err(error) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(())
}

fn ensure_parent_dir(path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn validate_header(header: &VaultHeader) -> Result<(), String> {
    if header.magic != VAULT_MAGIC || header.version != 1 {
        return Err("unsupported_vault_format".to_string());
    }
    if header.cipher.algorithm != "XChaCha20-Poly1305" {
        return Err("unsupported_cipher".to_string());
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("master_password_too_short".to_string());
    }
    Ok(())
}

/// Uniformly pick one byte from `group` using rejection sampling to avoid the
/// modulo bias of `u32 % len`.
fn random_pick(group: &[u8]) -> u8 {
    group[random_index(group.len())]
}

/// Uniform index in `0..len` via rejection sampling on a fresh u32.
fn random_index(len: usize) -> usize {
    debug_assert!(len > 0);
    let len = len as u32;
    // Largest multiple of `len` that fits in u32; reject draws at or above it.
    let limit = u32::MAX - (u32::MAX % len);
    loop {
        let mut bytes = [0u8; 4];
        OsRng.fill_bytes(&mut bytes);
        let value = u32::from_le_bytes(bytes);
        if value < limit {
            return (value % len) as usize;
        }
    }
}

fn shuffle(chars: &mut [u8]) {
    for idx in (1..chars.len()).rev() {
        let swap_idx = random_index(idx + 1);
        chars.swap(idx, swap_idx);
    }
}

impl VaultSession {
    fn status(&self) -> VaultStatus {
        VaultStatus {
            path: self.path.clone(),
            vault_id: self.header.vault_id.clone(),
            revision: self.data.revision,
            entry_count: self.data.entries.iter().filter(|entry| entry.deleted_at.is_none()).count(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str, updated_at: &str) -> VaultEntry {
        VaultEntry {
            id: id.to_string(),
            title: title.to_string(),
            username: String::new(),
            password: String::new(),
            url: String::new(),
            notes: String::new(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: updated_at.to_string(),
            deleted_at: None,
            conflict: false,
        }
    }

    fn temp_vault_path(tag: &str) -> String {
        let mut dir = std::env::temp_dir();
        dir.push(format!("passdroid-test-{}-{}.pdvault", tag, Uuid::new_v4()));
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn merge_creates_conflict_for_parallel_edits() {
        let base = vec![entry("1", "Mail", "1")];
        let disk = vec![entry("1", "Mail remote", "2")];
        let local = vec![entry("1", "Mail local", "3")];

        let merged = merge_entries(&base, &disk, &local);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|item| item.conflict));
    }

    #[test]
    fn merge_keeps_parallel_additions_without_loss() {
        // Both sides started from the same base and each added a distinct entry.
        let base = vec![entry("shared", "Shared", "1")];
        let disk = vec![entry("shared", "Shared", "1"), entry("remote", "Remote add", "2")];
        let local = vec![entry("shared", "Shared", "1"), entry("local", "Local add", "2")];

        let merged = merge_entries(&base, &disk, &local);
        let ids = merged.iter().map(|e| e.id.as_str()).collect::<HashSet<_>>();
        assert!(ids.contains("shared"));
        assert!(ids.contains("remote"));
        assert!(ids.contains("local"));
        assert!(merged.iter().all(|e| !e.conflict));
    }

    #[test]
    fn merge_identical_edit_does_not_conflict() {
        // The same edit applied on both devices must collapse to one entry.
        let base = vec![entry("1", "Mail", "1")];
        let disk = vec![entry("1", "Mail edited", "2")];
        let local = vec![entry("1", "Mail edited", "2")];

        let merged = merge_entries(&base, &disk, &local);
        assert_eq!(merged.len(), 1);
        assert!(!merged[0].conflict);
        assert_eq!(merged[0].title, "Mail edited");
    }

    #[test]
    fn generated_password_respects_length() {
        let password = generate_password(GeneratePasswordOptions {
            length: 24,
            uppercase: true,
            lowercase: true,
            numbers: true,
            symbols: true,
        })
        .unwrap();
        assert_eq!(password.len(), 24);
    }

    #[test]
    fn generated_password_rejects_empty_charset() {
        let result = generate_password(GeneratePasswordOptions {
            length: 16,
            uppercase: false,
            lowercase: false,
            numbers: false,
            symbols: false,
        });
        assert_eq!(result, Err("password_generator_empty_charset".to_string()));
    }

    #[test]
    fn full_command_lifecycle_round_trips() {
        let path = temp_vault_path("lifecycle");
        let mut manager = VaultManager::default();

        // Create + add two entries.
        let status = manager.create(path.clone(), "first-master-pass".to_string()).unwrap();
        assert_eq!(status.entry_count, 0);
        manager
            .upsert(VaultEntry::imported(
                "Mail".to_string(),
                "user@example.com".to_string(),
                "p4ssword".to_string(),
                String::new(),
                "https://mail.example.com".to_string(),
            ))
            .unwrap();
        let after_add = manager
            .upsert(VaultEntry::imported(
                "Bank".to_string(),
                "client".to_string(),
                "v3rys3cret".to_string(),
                "note".to_string(),
                String::new(),
            ))
            .unwrap();
        assert_eq!(after_add.len(), 2);

        // Soft-delete one entry.
        let mail_id = after_add.iter().find(|e| e.title == "Mail").unwrap().id.clone();
        let after_delete = manager.delete(mail_id).unwrap();
        assert_eq!(after_delete.len(), 1);
        assert_eq!(after_delete[0].title, "Bank");

        // Rotate the master password (the previously-broken path).
        manager
            .change_password("first-master-pass".to_string(), "second-master-pass".to_string())
            .unwrap();

        // Lock and reopen with the NEW password; the old one must be rejected.
        manager.lock();
        assert!(manager.list().is_err());
        assert_eq!(
            manager.unlock(path.clone(), "first-master-pass".to_string()),
            Err("master_password_incorrect".to_string())
        );
        let reopened = manager.unlock(path.clone(), "second-master-pass".to_string()).unwrap();
        assert_eq!(reopened.entry_count, 1);

        let entries = manager.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Bank");
        assert_eq!(entries[0].password, "v3rys3cret");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn change_password_rejects_wrong_old_password() {
        let path = temp_vault_path("change-pw");
        let mut manager = VaultManager::default();
        manager.create(path.clone(), "correct-old-pass".to_string()).unwrap();

        let result = manager.change_password("wrong-old-pass".to_string(), "new-pass-1234".to_string());
        assert_eq!(result, Err("master_password_incorrect".to_string()));

        // Session must remain usable with the original password after the failure.
        manager.lock();
        assert!(manager.unlock(path.clone(), "correct-old-pass".to_string()).is_ok());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn create_rejects_short_password() {
        let path = temp_vault_path("short-pw");
        let mut manager = VaultManager::default();
        assert_eq!(
            manager.create(path, "short".to_string()),
            Err("master_password_too_short".to_string())
        );
    }
}
