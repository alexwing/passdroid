use std::{
    collections::{HashMap, HashSet},
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
        EntriesSnapshot, GeneratePasswordOptions, ImportPreview, ImportPreviewEntry, SyncConfig,
        SyncResult, VaultData, VaultEntry, VaultEnvelope, VaultHeader, VaultSnapshot, VaultStatus,
    },
    sync,
};

pub type SharedVaultManager = Mutex<VaultManager>;

#[derive(Default)]
pub struct VaultManager {
    session: Option<VaultSession>,
    pending_imports: HashMap<String, Vec<VaultEntry>>,
}

struct VaultSession {
    header: VaultHeader,
    key: Zeroizing<[u8; 32]>,
    data: VaultData,
    base_entries: Vec<VaultEntry>,
    loaded_revision: u64,
}

// ---------------------------------------------------------------------------
// Core vault logic. Rust owns crypto and state but NOT file I/O: every mutating
// method returns the serialized vault (`contents`) for the frontend to persist
// via the Tauri fs plugin. This lets the vault live at a real path or an Android
// `content://` URI, which Rust's std::fs cannot open.
// ---------------------------------------------------------------------------
impl VaultManager {
    pub fn create(&mut self, master_password: String) -> Result<VaultSnapshot, String> {
        validate_password(&master_password)?;
        let now = now_iso();
        let kdf = default_kdf_params();
        let key = derive_key(&master_password, &kdf)?;
        let header = VaultHeader {
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

        self.session = Some(VaultSession {
            header,
            key,
            data,
            base_entries: Vec::new(),
            loaded_revision: 0,
        });

        let session = self.session.as_mut().unwrap();
        let contents = seal_envelope(session)?;
        Ok(VaultSnapshot {
            status: session.status(),
            contents,
        })
    }

    pub fn unlock(&mut self, contents: String, master_password: String) -> Result<VaultStatus, String> {
        let envelope: VaultEnvelope =
            serde_json::from_str(&contents).map_err(|_| "vault_file_invalid".to_string())?;
        validate_header(&envelope.header)?;
        let key = derive_key(&master_password, &envelope.header.kdf)?;
        let data: VaultData = open_payload(&envelope.payload, &envelope.header, &key[..])
            .map_err(|_| "master_password_incorrect".to_string())?;

        self.session = Some(VaultSession {
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

    pub fn upsert(&mut self, mut entry: VaultEntry) -> Result<EntriesSnapshot, String> {
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

        let contents = seal_envelope(session)?;
        Ok(EntriesSnapshot {
            entries: visible_entries(&session.data.entries),
            contents,
        })
    }

    pub fn delete(&mut self, id: String) -> Result<EntriesSnapshot, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let now = now_iso();

        if let Some(entry) = session.data.entries.iter_mut().find(|item| item.id == id) {
            entry.deleted_at = Some(now.clone());
            entry.updated_at = now;
        }

        let contents = seal_envelope(session)?;
        Ok(EntriesSnapshot {
            entries: visible_entries(&session.data.entries),
            contents,
        })
    }

    pub fn change_password(
        &mut self,
        old_password: String,
        new_password: String,
    ) -> Result<VaultSnapshot, String> {
        validate_password(&new_password)?;
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let old_key = derive_key(&old_password, &session.header.kdf)?;
        if old_key[..] != session.key[..] {
            return Err("master_password_incorrect".to_string());
        }

        let new_kdf = default_kdf_params();
        session.key = derive_key(&new_password, &new_kdf)?;
        session.header.kdf = new_kdf;

        let contents = seal_envelope(session)?;
        Ok(VaultSnapshot {
            status: session.status(),
            contents,
        })
    }

    pub fn save(&mut self) -> Result<VaultSnapshot, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let contents = current_envelope(session)?;
        Ok(VaultSnapshot {
            status: session.status(),
            contents,
        })
    }

    /// Return a freshly-sealed copy of the current vault for the frontend to
    /// write to a user-chosen location.
    pub fn export_copy(&mut self) -> Result<String, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        current_envelope(session)
    }

    /// Export the visible entries as legacy-compatible (UNENCRYPTED) Passdroid XML.
    pub fn export_legacy_xml(&self) -> Result<String, String> {
        let session = self.session.as_ref().ok_or_else(|| "vault_locked".to_string())?;
        let entries = visible_entries(&session.data.entries);
        Ok(legacy::entries_to_legacy_xml(&entries, env!("CARGO_PKG_VERSION")))
    }

    pub fn import_preview(
        &mut self,
        name: String,
        contents: Vec<u8>,
        legacy_password: Option<String>,
    ) -> Result<ImportPreview, String> {
        let entries = legacy::import_legacy_entries_from_bytes(&name, &contents, legacy_password)?;
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

    pub fn import_commit(&mut self, import_id: String) -> Result<EntriesSnapshot, String> {
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
        let contents = seal_envelope(session)?;
        Ok(EntriesSnapshot {
            entries: visible_entries(&session.data.entries),
            contents,
        })
    }

    pub fn set_vault_icon(&mut self, icon: String) -> Result<VaultSnapshot, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        if !session.data.settings.is_object() {
            session.data.settings = serde_json::json!({});
        }
        session.data.settings["icon"] = serde_json::Value::String(icon);
        let contents = seal_envelope(session)?;
        Ok(VaultSnapshot {
            status: session.status(),
            contents,
        })
    }

    pub fn get_sync_config(&self) -> Result<Option<SyncConfig>, String> {
        let session = self.session.as_ref().ok_or_else(|| "vault_locked".to_string())?;
        Ok(read_sync_config(&session.data))
    }

    pub fn set_sync_config(&mut self, config: SyncConfig) -> Result<VaultSnapshot, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        if !session.data.settings.is_object() {
            session.data.settings = serde_json::json!({});
        }
        session.data.settings["sync"] =
            serde_json::to_value(&config).map_err(|e| e.to_string())?;
        let contents = seal_envelope(session)?;
        Ok(VaultSnapshot {
            status: session.status(),
            contents,
        })
    }

    /// Pull the remote vault, merge it by id/updated_at, re-seal, then push.
    /// Returns the merged vault so the frontend can persist it locally too.
    pub fn sync_now(&mut self) -> Result<SyncResult, String> {
        let session = self.session.as_mut().ok_or_else(|| "vault_locked".to_string())?;
        let config = read_sync_config(&session.data).ok_or_else(|| "sync_not_configured".to_string())?;
        if !config.enabled {
            return Err("sync_disabled".to_string());
        }

        let pulled = match sync::download(&config)? {
            Some(bytes) => {
                let envelope: VaultEnvelope =
                    serde_json::from_slice(&bytes).map_err(|_| "sync_remote_invalid".to_string())?;
                if envelope.header.vault_id != session.header.vault_id {
                    return Err("sync_vault_mismatch".to_string());
                }
                let remote: VaultData =
                    open_payload(&envelope.payload, &envelope.header, &session.key[..])
                        .map_err(|_| "sync_decrypt_failed".to_string())?;
                let merged =
                    merge_entries(&session.base_entries, &remote.entries, &session.data.entries);
                session.data.entries = merged;
                session.data.revision = session.data.revision.max(remote.revision);
                true
            }
            None => false,
        };

        let contents = seal_envelope(session)?;
        sync::upload(&config, contents.as_bytes())?;

        Ok(SyncResult {
            pulled,
            revision: session.data.revision,
            entry_count: session.data.entries.iter().filter(|e| e.deleted_at.is_none()).count(),
            contents,
        })
    }
}

fn read_sync_config(data: &VaultData) -> Option<SyncConfig> {
    data.settings
        .get("sync")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

/// Bump the revision, seal the current data with the session key, update the
/// in-memory baseline, and return the serialized envelope JSON.
fn seal_envelope(session: &mut VaultSession) -> Result<String, String> {
    session.data.revision = session.data.revision.saturating_add(1);
    session.header.updated_at = now_iso();
    let payload = seal_payload(&session.data, &mut session.header, &session.key[..])?;
    session.loaded_revision = session.data.revision;
    session.base_entries = session.data.entries.clone();
    let envelope = VaultEnvelope {
        header: session.header.clone(),
        payload,
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

/// Seal the current data WITHOUT advancing the revision (used for export copies).
fn current_envelope(session: &mut VaultSession) -> Result<String, String> {
    let payload = seal_payload(&session.data, &mut session.header, &session.key[..])?;
    let envelope = VaultEnvelope {
        header: session.header.clone(),
        payload,
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
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
            vault_id: self.header.vault_id.clone(),
            revision: self.data.revision,
            entry_count: self.data.entries.iter().filter(|entry| entry.deleted_at.is_none()).count(),
            icon: self
                .data
                .settings
                .get("icon")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
        }
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
    master_password: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultSnapshot, String> {
    manager!(state).create(master_password)
}

#[tauri::command]
pub fn unlock_vault(
    contents: String,
    master_password: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultStatus, String> {
    manager!(state).unlock(contents, master_password)
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
) -> Result<EntriesSnapshot, String> {
    manager!(state).upsert(entry)
}

#[tauri::command]
pub fn delete_entry(
    id: String,
    state: State<'_, SharedVaultManager>,
) -> Result<EntriesSnapshot, String> {
    manager!(state).delete(id)
}

#[tauri::command]
pub fn change_master_password(
    old_password: String,
    new_password: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultSnapshot, String> {
    manager!(state).change_password(old_password, new_password)
}

#[tauri::command]
pub fn save_vault(state: State<'_, SharedVaultManager>) -> Result<VaultSnapshot, String> {
    manager!(state).save()
}

#[tauri::command]
pub fn export_vault_copy(state: State<'_, SharedVaultManager>) -> Result<String, String> {
    manager!(state).export_copy()
}

#[tauri::command]
pub fn export_legacy_xml(state: State<'_, SharedVaultManager>) -> Result<String, String> {
    manager!(state).export_legacy_xml()
}

#[tauri::command]
pub fn set_vault_icon(
    icon: String,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultSnapshot, String> {
    manager!(state).set_vault_icon(icon)
}

#[tauri::command]
pub fn get_sync_config(state: State<'_, SharedVaultManager>) -> Result<Option<SyncConfig>, String> {
    manager!(state).get_sync_config()
}

#[tauri::command]
pub fn set_sync_config(
    config: SyncConfig,
    state: State<'_, SharedVaultManager>,
) -> Result<VaultSnapshot, String> {
    manager!(state).set_sync_config(config)
}

#[tauri::command]
pub fn test_sync(config: SyncConfig) -> Result<(), String> {
    sync::test_connection(&config)
}

#[tauri::command]
pub fn sync_now(state: State<'_, SharedVaultManager>) -> Result<SyncResult, String> {
    manager!(state).sync_now()
}

#[tauri::command]
pub fn import_legacy_preview(
    name: String,
    contents: Vec<u8>,
    legacy_password: Option<String>,
    state: State<'_, SharedVaultManager>,
) -> Result<ImportPreview, String> {
    manager!(state).import_preview(name, contents, legacy_password)
}

#[tauri::command]
pub fn import_legacy_commit(
    import_id: String,
    state: State<'_, SharedVaultManager>,
) -> Result<EntriesSnapshot, String> {
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
        let mut manager = VaultManager::default();

        // Create loads the session and returns the serialized vault.
        let created = manager.create("first-master-pass".to_string()).unwrap();
        assert_eq!(created.status.entry_count, 0);

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
        assert_eq!(after_add.entries.len(), 2);

        let mail_id = after_add.entries.iter().find(|e| e.title == "Mail").unwrap().id.clone();
        let after_delete = manager.delete(mail_id).unwrap();
        assert_eq!(after_delete.entries.len(), 1);
        assert_eq!(after_delete.entries[0].title, "Bank");

        // Rotate the master password; capture the re-keyed vault bytes.
        let changed = manager
            .change_password("first-master-pass".to_string(), "second-master-pass".to_string())
            .unwrap();

        // Lock and reopen from the serialized bytes: old password rejected, new ok.
        manager.lock();
        assert!(manager.list().is_err());
        assert_eq!(
            manager.unlock(changed.contents.clone(), "first-master-pass".to_string()),
            Err("master_password_incorrect".to_string())
        );
        let reopened = manager.unlock(changed.contents.clone(), "second-master-pass".to_string()).unwrap();
        assert_eq!(reopened.entry_count, 1);

        let entries = manager.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Bank");
        assert_eq!(entries[0].password, "v3rys3cret");
    }

    #[test]
    fn change_password_rejects_wrong_old_password() {
        let mut manager = VaultManager::default();
        let created = manager.create("correct-old-pass".to_string()).unwrap();

        assert_eq!(
            manager
                .change_password("wrong-old-pass".to_string(), "new-pass-1234".to_string())
                .err(),
            Some("master_password_incorrect".to_string())
        );

        // The original vault bytes still unlock with the original password.
        manager.lock();
        assert!(manager.unlock(created.contents, "correct-old-pass".to_string()).is_ok());
    }

    #[test]
    fn create_rejects_short_password() {
        let mut manager = VaultManager::default();
        assert_eq!(
            manager.create("short".to_string()).err(),
            Some("master_password_too_short".to_string())
        );
    }
}
