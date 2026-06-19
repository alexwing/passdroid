use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub conflict: bool,
}

impl VaultEntry {
    pub fn imported(title: String, username: String, password: String, notes: String, url: String) -> Self {
        Self {
            id: String::new(),
            title,
            username,
            password,
            url,
            notes,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            conflict: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub entries: Vec<VaultEntry>,
    #[serde(default = "empty_settings")]
    pub settings: serde_json::Value,
}

fn empty_settings() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algorithm: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String,
    pub output_len: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CipherInfo {
    pub algorithm: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultHeader {
    pub magic: String,
    pub version: u32,
    pub vault_id: String,
    pub kdf: KdfParams,
    pub cipher: CipherInfo,
    pub nonce: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEnvelope {
    pub header: VaultHeader,
    pub payload: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub path: String,
    pub vault_id: String,
    pub revision: u64,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePasswordOptions {
    pub length: usize,
    pub uppercase: bool,
    pub lowercase: bool,
    pub numbers: bool,
    pub symbols: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub pulled: bool,
    pub revision: u64,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub language: String,
    #[serde(default)]
    pub recent_vaults: Vec<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            language: "system".to_string(),
            recent_vaults: Vec::new(),
        }
    }
}

