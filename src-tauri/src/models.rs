use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// The vault data model (envelope, header, KDF/cipher, entries, status) lives in
// passdroid-core; these are re-exported for the types that wrap them.
pub use passdroid_core::models::{VaultEntry, VaultStatus};

/// A status plus the serialized vault file the frontend should persist. File I/O
/// lives in the frontend (Tauri fs plugin) so the vault can be a real path or an
/// Android `content://` URI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub status: VaultStatus,
    pub contents: String,
}

/// The visible entries plus the serialized vault file to persist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntriesSnapshot {
    pub entries: Vec<VaultEntry>,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewEntry {
    pub title: String,
    pub username: String,
    pub url: String,
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub import_id: String,
    pub count: usize,
    pub entries: Vec<ImportPreviewEntry>,
}

/// Remote sync configuration. Stored ENCRYPTED inside the vault payload
/// (under `settings.sync`), so the FTP credentials are protected by the master
/// password and travel with the vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ftp_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub remote_dir: String,
    #[serde(default)]
    pub remote_file: String,
}

fn default_ftp_port() -> u16 {
    21
}

/// Lightweight remote check used on unlock: compares the remote vault's revision
/// to the local one so the UI can offer to download a newer remote copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCheck {
    pub configured: bool,
    pub remote_revision: Option<u64>,
    pub local_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub pulled: bool,
    pub revision: u64,
    pub entry_count: usize,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub language: String,
    #[serde(default)]
    pub recent_vaults: Vec<String>,
    /// Per-vault icon keys (vault path/URI -> icon name), kept here rather than
    /// inside the vault so the icon can be shown while the vault is still locked.
    #[serde(default)]
    pub vault_icons: HashMap<String, String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            language: "system".to_string(),
            recent_vaults: Vec::new(),
            vault_icons: HashMap::new(),
        }
    }
}

