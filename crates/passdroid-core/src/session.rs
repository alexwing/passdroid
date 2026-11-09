//! Session-level operations shared by every client that edits a vault in
//! memory and syncs it: entry mutations, the 3-way session merge used after a
//! conflict (the web client's HTTP 412 protocol; desktop/Android `sync_now`
//! can adopt it later) and the rollback guard.
//!
//! Pure functions (no I/O, no clock): the caller passes `now` (use
//! `crypto::now_iso()`), so they are deterministic in tests and identical in
//! native and WASM builds.

use uuid::Uuid;

use crate::{
    merge::merge_entries,
    models::{VaultData, VaultEntry},
};

/// Insert or replace an entry, with the same rules as the desktop app
/// (`src-tauri/src/vault.rs`, `VaultManager::upsert`):
/// - `title` is trimmed; empty -> `Err("entry_title_required")`;
/// - empty/blank `id` -> new UUID v4 and `created_at = now`; an existing id
///   sent with an empty `created_at` keeps the stored one (the desktop sets
///   `now`, which would reset the creation date on every web edit), or gets
///   `now` if the stored one is empty too;
/// - `updated_at = now`, `deleted_at = None`;
/// - replaces the entry with the same id, or appends it.
///
/// Difference with the desktop app, on purpose: when the incoming entry has
/// an empty `extra` (the UI does not know unknown fields) and the replaced
/// entry has some, they are kept, so editing an entry in an older client never
/// drops fields written by a newer one. Returns the entry id.
pub fn apply_upsert(entries: &mut Vec<VaultEntry>, mut entry: VaultEntry, now: &str) -> Result<String, String> {
    entry.title = entry.title.trim().to_string();
    if entry.title.is_empty() {
        return Err("entry_title_required".to_string());
    }

    let blank_id = entry.id.trim().is_empty();
    if blank_id {
        entry.id = Uuid::new_v4().to_string();
    }
    let existing = entries.iter().position(|item| item.id == entry.id);

    // Desktop rule: a new id always starts a fresh created_at. Otherwise an
    // incoming empty created_at keeps the stored one, or takes `now` when the
    // stored one is empty too.
    if blank_id {
        entry.created_at = now.to_string();
    } else if entry.created_at.is_empty() {
        entry.created_at = existing
            .map(|index| entries[index].created_at.clone())
            .filter(|created_at| !created_at.is_empty())
            .unwrap_or_else(|| now.to_string());
    }
    entry.updated_at = now.to_string();
    entry.deleted_at = None;

    let id = entry.id.clone();
    match existing {
        Some(index) => {
            if entry.extra.is_empty() {
                entry.extra = entries[index].extra.clone();
            }
            entries[index] = entry;
        }
        None => entries.push(entry),
    }
    Ok(id)
}

/// Soft delete (tombstone), like the desktop app: `deleted_at = now` and
/// `updated_at = now` on the entry with `id`. Returns whether it existed.
/// Tombstones are never purged here (all clients keep them; purge policy is an
/// open question).
pub fn apply_delete(entries: &mut [VaultEntry], id: &str, now: &str) -> bool {
    match entries.iter_mut().find(|entry| entry.id == id) {
        Some(entry) => {
            entry.deleted_at = Some(now.to_string());
            entry.updated_at = now.to_string();
            true
        }
        None => false,
    }
}

/// Merge after a conflict (the remote changed since `base`):
/// - `entries = merge_entries(base, &remote.entries, &local.entries)`;
/// - `revision = max(remote.revision, local.revision)` (sealing with
///   `envelope::seal_envelope` then bumps it by one, as the desktop does);
/// - `settings`: the remote's, unless `settings_dirty` (then the local ones).
///   The web client never edits settings in v1, so it always adopts the
///   remote's and never overwrites a sync config changed elsewhere;
/// - `device_id`: the remote's if not empty, else the local one (it is a
///   per-vault id nobody reads; just never churn it);
/// - `extra` (unknown top-level fields): the remote's, plus local-only keys.
pub fn merge_session(
    base: &[VaultEntry],
    remote: &VaultData,
    local: &VaultData,
    settings_dirty: bool,
) -> VaultData {
    let mut extra = remote.extra.clone();
    for (key, value) in &local.extra {
        extra.entry(key.clone()).or_insert_with(|| value.clone());
    }

    VaultData {
        revision: remote.revision.max(local.revision),
        device_id: if remote.device_id.is_empty() {
            local.device_id.clone()
        } else {
            remote.device_id.clone()
        },
        entries: merge_entries(base, &remote.entries, &local.entries),
        settings: if settings_dirty {
            local.settings.clone()
        } else {
            remote.settings.clone()
        },
        extra,
    }
}

/// Rollback guard (ARQUITECTURA 3.4): `Err("remote_rollback")` when the remote
/// revision is lower than the revision this session loaded/last saved
/// (`loaded_revision`) or than the highest revision this device has ever
/// confirmed for the vault (`max_seen_revision`, e.g. from the web client's
/// localStorage). Equal revisions are fine (two writers that both did
/// `max + 1` are a conflict, not a rollback). Never merge automatically after
/// a rollback: the user must choose between accepting it and restoring.
pub fn check_rollback(
    remote_revision: u64,
    loaded_revision: u64,
    max_seen_revision: Option<u64>,
) -> Result<(), String> {
    let below_loaded = remote_revision < loaded_revision;
    let below_max_seen = max_seen_revision.is_some_and(|max_seen| remote_revision < max_seen);
    if below_loaded || below_max_seen {
        return Err("remote_rollback".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: &str = "2026-11-09T10:00:00.000Z";
    const T1: &str = "2026-11-09T11:00:00.000Z";
    const T2: &str = "2026-11-09T12:00:00.000Z";
    const CREATED: &str = "2026-01-01T00:00:00.000Z";

    fn entry(id: &str, title: &str, updated_at: &str) -> VaultEntry {
        VaultEntry {
            id: id.to_string(),
            title: title.to_string(),
            username: String::new(),
            password: String::new(),
            url: String::new(),
            notes: String::new(),
            created_at: CREATED.to_string(),
            updated_at: updated_at.to_string(),
            deleted_at: None,
            conflict: false,
            extra: Default::default(),
        }
    }

    fn draft(id: &str, title: &str) -> VaultEntry {
        let mut item = entry(id, title, "");
        item.created_at = String::new();
        item
    }

    fn vault(revision: u64, device_id: &str, entries: Vec<VaultEntry>) -> VaultData {
        VaultData {
            revision,
            device_id: device_id.to_string(),
            entries,
            settings: serde_json::json!({}),
            extra: Default::default(),
        }
    }

    #[test]
    fn upsert_new_entry_gets_id_and_timestamps() {
        let mut entries = Vec::new();
        let id = apply_upsert(&mut entries, draft("", "  Mail  "), T0).unwrap();

        assert!(Uuid::parse_str(&id).is_ok());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].title, "Mail");
        assert_eq!(entries[0].created_at, T0);
        assert_eq!(entries[0].updated_at, T0);
        assert!(entries[0].deleted_at.is_none());
    }

    #[test]
    fn upsert_blank_id_ignores_incoming_created_at() {
        let mut entries = Vec::new();
        let mut item = draft("   ", "Mail");
        item.created_at = CREATED.to_string();
        apply_upsert(&mut entries, item, T0).unwrap();
        assert_eq!(entries[0].created_at, T0);
    }

    #[test]
    fn upsert_existing_entry_is_replaced_and_keeps_created_at() {
        let mut entries = vec![entry("e1", "Mail", T0)];
        let mut edited = entry("e1", "Mail edited", "");
        edited.created_at = String::new();
        edited.password = "new-pass".to_string();

        let id = apply_upsert(&mut entries, edited, T1).unwrap();
        assert_eq!(id, "e1");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Mail edited");
        assert_eq!(entries[0].password, "new-pass");
        assert_eq!(entries[0].created_at, CREATED);
        assert_eq!(entries[0].updated_at, T1);
    }

    #[test]
    fn upsert_fills_created_at_when_stored_one_is_empty() {
        let mut stored = entry("e1", "Mail", T0);
        stored.created_at = String::new();
        let mut entries = vec![stored];

        apply_upsert(&mut entries, draft("e1", "Mail"), T1).unwrap();
        assert_eq!(entries[0].created_at, T1);
    }

    #[test]
    fn upsert_keeps_existing_extra_when_incoming_has_none() {
        let mut stored = entry("e1", "Mail", T0);
        stored.extra.insert("favorite".to_string(), serde_json::json!(true));
        let mut entries = vec![stored];

        apply_upsert(&mut entries, entry("e1", "Mail", T0), T1).unwrap();
        assert_eq!(entries[0].extra["favorite"], true);
    }

    #[test]
    fn upsert_uses_incoming_extra_when_it_has_its_own() {
        let mut stored = entry("e1", "Mail", T0);
        stored.extra.insert("favorite".to_string(), serde_json::json!(true));
        let mut entries = vec![stored];

        let mut incoming = entry("e1", "Mail", T0);
        incoming.extra.insert("tags".to_string(), serde_json::json!(["x"]));
        apply_upsert(&mut entries, incoming, T1).unwrap();
        assert_eq!(entries[0].extra.len(), 1);
        assert_eq!(entries[0].extra["tags"], serde_json::json!(["x"]));
        assert!(!entries[0].extra.contains_key("favorite"));
    }

    #[test]
    fn upsert_rejects_blank_title_and_leaves_entries_alone() {
        let mut entries = vec![entry("e1", "Mail", T0)];
        let before = entries.clone();

        assert_eq!(
            apply_upsert(&mut entries, draft("e1", "   "), T1),
            Err("entry_title_required".to_string())
        );
        assert_eq!(
            apply_upsert(&mut entries, draft("", ""), T1),
            Err("entry_title_required".to_string())
        );
        assert_eq!(entries, before);
    }

    #[test]
    fn upsert_revives_deleted_entry() {
        let mut stored = entry("e1", "Mail", T0);
        stored.deleted_at = Some(T0.to_string());
        let mut entries = vec![stored];

        apply_upsert(&mut entries, entry("e1", "Mail", T0), T1).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].deleted_at.is_none());
        assert_eq!(entries[0].updated_at, T1);
    }

    #[test]
    fn delete_marks_tombstone() {
        let mut entries = vec![entry("e1", "Mail", T0), entry("e2", "Bank", T0)];

        assert!(apply_delete(&mut entries, "e1", T1));
        assert_eq!(entries[0].deleted_at.as_deref(), Some(T1));
        assert_eq!(entries[0].updated_at, T1);
        assert!(entries[1].deleted_at.is_none());
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn delete_unknown_id_returns_false() {
        let mut entries = vec![entry("e1", "Mail", T0)];
        let before = entries.clone();

        assert!(!apply_delete(&mut entries, "missing", T1));
        assert_eq!(entries, before);
    }

    #[test]
    fn merge_session_keeps_parallel_additions() {
        let base = vec![entry("shared", "Shared", T0)];
        let remote = vault(3, "dev-r", vec![entry("shared", "Shared", T0), entry("remote", "Remote add", T1)]);
        let local = vault(2, "dev-l", vec![entry("shared", "Shared", T0), entry("local", "Local add", T1)]);

        let merged = merge_session(&base, &remote, &local, false);
        let ids: Vec<&str> = merged.entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(merged.entries.len(), 3);
        for id in ["shared", "remote", "local"] {
            assert!(ids.contains(&id), "missing {id}");
        }
        assert!(merged.entries.iter().all(|e| !e.conflict));
    }

    #[test]
    fn merge_session_parallel_edit_creates_conflict_entry() {
        let base = vec![entry("1", "Mail", T0)];
        let remote = vault(2, "dev-r", vec![entry("1", "Mail remote", T1)]);
        let local = vault(2, "dev-l", vec![entry("1", "Mail local", T2)]);

        let merged = merge_session(&base, &remote, &local, false);
        assert_eq!(merged.entries.len(), 2);
        assert_eq!(merged.entries.iter().filter(|e| e.conflict).count(), 1);
        assert!(merged.entries.iter().any(|e| e.id == "1" && e.title == "Mail remote"));
    }

    #[test]
    fn merge_session_identical_edit_does_not_conflict() {
        let base = vec![entry("1", "Mail", T0)];
        let remote = vault(2, "dev-r", vec![entry("1", "Mail edited", T1)]);
        let local = vault(2, "dev-l", vec![entry("1", "Mail edited", T1)]);

        let merged = merge_session(&base, &remote, &local, false);
        assert_eq!(merged.entries.len(), 1);
        assert!(!merged.entries[0].conflict);
    }

    #[test]
    fn merge_session_revision_is_the_max() {
        let base: Vec<VaultEntry> = Vec::new();
        assert_eq!(merge_session(&base, &vault(5, "a", vec![]), &vault(7, "a", vec![]), false).revision, 7);
        assert_eq!(merge_session(&base, &vault(9, "a", vec![]), &vault(7, "a", vec![]), false).revision, 9);
    }

    #[test]
    fn merge_session_settings_follow_remote_unless_dirty() {
        let base: Vec<VaultEntry> = Vec::new();
        let mut remote = vault(1, "a", vec![]);
        remote.settings = serde_json::json!({"icon": "remote", "sync": {"host": "r"}});
        let mut local = vault(1, "a", vec![]);
        local.settings = serde_json::json!({"icon": "local"});

        let clean = merge_session(&base, &remote, &local, false);
        assert_eq!(clean.settings, remote.settings);

        let dirty = merge_session(&base, &remote, &local, true);
        assert_eq!(dirty.settings, local.settings);
    }

    #[test]
    fn merge_session_device_id_prefers_remote_then_local() {
        let base: Vec<VaultEntry> = Vec::new();
        let merged = merge_session(&base, &vault(1, "remote-dev", vec![]), &vault(1, "local-dev", vec![]), false);
        assert_eq!(merged.device_id, "remote-dev");

        let merged = merge_session(&base, &vault(1, "", vec![]), &vault(1, "local-dev", vec![]), false);
        assert_eq!(merged.device_id, "local-dev");
    }

    #[test]
    fn merge_session_extra_is_remote_plus_local_only_keys() {
        let base: Vec<VaultEntry> = Vec::new();
        let mut remote = vault(1, "a", vec![]);
        remote.extra.insert("shared".to_string(), serde_json::json!("remote"));
        remote.extra.insert("remoteOnly".to_string(), serde_json::json!(1));
        let mut local = vault(1, "a", vec![]);
        local.extra.insert("shared".to_string(), serde_json::json!("local"));
        local.extra.insert("localOnly".to_string(), serde_json::json!(2));

        let merged = merge_session(&base, &remote, &local, false);
        assert_eq!(merged.extra["shared"], "remote");
        assert_eq!(merged.extra["remoteOnly"], 1);
        assert_eq!(merged.extra["localOnly"], 2);
        assert_eq!(merged.extra.len(), 3);
    }

    #[test]
    fn rollback_guard_rejects_revision_below_loaded() {
        assert_eq!(check_rollback(4, 5, None), Err("remote_rollback".to_string()));
    }

    #[test]
    fn rollback_guard_rejects_revision_below_max_seen() {
        assert_eq!(check_rollback(4, 4, Some(6)), Err("remote_rollback".to_string()));
    }

    #[test]
    fn rollback_guard_accepts_equal_or_higher_revision() {
        assert_eq!(check_rollback(5, 5, Some(5)), Ok(()));
        assert_eq!(check_rollback(6, 5, Some(5)), Ok(()));
        assert_eq!(check_rollback(5, 5, None), Ok(()));
        assert_eq!(check_rollback(0, 0, None), Ok(()));
    }
}
