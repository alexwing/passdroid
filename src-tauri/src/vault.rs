use std::{collections::HashMap, sync::Mutex};

use passdroid_core::{
    change_password as core_change_password, merge_entries, new_vault, now_iso, open_envelope,
    open_payload, reseal_envelope as core_reseal_envelope, seal_envelope as core_seal_envelope,
    validate_password, vault_status, visible_entries, GeneratePasswordOptions, NewVault, VaultData,
    VaultEnvelope, VaultHeader,
};
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    legacy,
    models::{
        EntriesSnapshot, ImportPreview, ImportPreviewEntry, SyncCheck, SyncConfig, SyncResult,
        VaultEntry, VaultSnapshot, VaultStatus,
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
        let NewVault { header, key, data } = new_vault(&master_password)?;

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
        let opened = open_envelope(&contents, &master_password)?;

        self.session = Some(VaultSession {
            base_entries: opened.data.entries.clone(),
            loaded_revision: opened.data.revision,
            header: opened.header,
            key: opened.key,
            data: opened.data,
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
        session.key =
            core_change_password(&mut session.header, &session.key[..], &old_password, &new_password)?;

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

    /// Read-only check of the remote vault's revision (no merge, no push), so the
    /// UI can offer to download a newer remote copy when opening.
    pub fn sync_check(&self) -> Result<SyncCheck, String> {
        let session = self.session.as_ref().ok_or_else(|| "vault_locked".to_string())?;
        let local_revision = session.data.revision;
        let config = match read_sync_config(&session.data) {
            Some(config) if config.enabled => config,
            _ => {
                return Ok(SyncCheck {
                    configured: false,
                    remote_revision: None,
                    local_revision,
                })
            }
        };

        let remote_revision = match sync::download(&config)? {
            Some(bytes) => {
                let envelope: VaultEnvelope =
                    serde_json::from_slice(&bytes).map_err(|_| "sync_remote_invalid".to_string())?;
                if envelope.header.vault_id != session.header.vault_id {
                    return Err("sync_vault_mismatch".to_string());
                }
                let remote: VaultData =
                    open_payload(&envelope.payload, &envelope.header, &session.key[..])
                        .map_err(|_| "sync_decrypt_failed".to_string())?;
                Some(remote.revision)
            }
            None => None,
        };

        Ok(SyncCheck {
            configured: true,
            remote_revision,
            local_revision,
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
        // Local and remote now match: this is the new merge baseline.
        session.base_entries = session.data.entries.clone();

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

/// Bump the revision and seal the current data with the session key, returning
/// the serialized envelope JSON.
///
/// IMPORTANT: this does NOT touch `base_entries`. The base is the last state
/// that was in sync with the remote (set on unlock and after a successful
/// sync); advancing it on every local save would make the next 3-way merge
/// treat brand-new local entries as "already known", dropping them.
fn seal_envelope(session: &mut VaultSession) -> Result<String, String> {
    let contents = core_seal_envelope(&mut session.header, &mut session.data, &session.key[..])?;
    session.loaded_revision = session.data.revision;
    Ok(contents)
}

/// Seal the current data WITHOUT advancing the revision (used for export copies).
fn current_envelope(session: &mut VaultSession) -> Result<String, String> {
    core_reseal_envelope(&mut session.header, &session.data, &session.key[..])
}

impl VaultSession {
    fn status(&self) -> VaultStatus {
        vault_status(&self.header, &self.data)
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
pub fn download_ftp_vault(config: SyncConfig) -> Result<String, String> {
    let bytes = sync::download(&config)?
        .ok_or_else(|| "sync_download_failed".to_string())?;
    String::from_utf8(bytes).map_err(|_| "vault_file_invalid".to_string())
}

#[tauri::command]
pub fn sync_check(state: State<'_, SharedVaultManager>) -> Result<SyncCheck, String> {
    manager!(state).sync_check()
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
pub fn is_android() -> bool {
    cfg!(target_os = "android")
}

#[tauri::command]
pub fn generate_password(options: GeneratePasswordOptions) -> Result<String, String> {
    passdroid_core::generate_password(options)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn local_save_keeps_sync_baseline() {
        // Regression: seal_envelope must NOT advance base_entries on a local save,
        // otherwise the next 3-way sync merge treats a brand-new local entry as
        // "already known" and drops it (entry appears then disappears).
        let mut manager = VaultManager::default();
        manager.create("master-pass-123".to_string()).unwrap();
        assert!(manager.session.as_ref().unwrap().base_entries.is_empty());

        manager
            .upsert(VaultEntry::imported(
                "Mail".to_string(),
                "user".to_string(),
                "secret".to_string(),
                String::new(),
                String::new(),
            ))
            .unwrap();

        let session = manager.session.as_ref().unwrap();
        assert_eq!(session.data.entries.len(), 1);
        assert!(
            session.base_entries.is_empty(),
            "a local save must not advance the merge baseline"
        );

        // And the merge against a remote that lacks the new entry keeps it.
        let merged = merge_entries(&session.base_entries, &[], &session.data.entries);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].title, "Mail");
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
