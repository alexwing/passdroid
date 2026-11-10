use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::models::VaultEntry;

pub fn merge_entries(base: &[VaultEntry], disk: &[VaultEntry], local: &[VaultEntry]) -> Vec<VaultEntry> {
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

/// Entries that are not soft-deleted, sorted by title then username
/// (case-insensitive).
pub fn visible_entries(entries: &[VaultEntry]) -> Vec<VaultEntry> {
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
            extra: Default::default(),
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
}
