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
    /// Fields this build does not know (written by a newer client). Kept as they
    /// were read so saving from an older client does not drop them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
            extra: Default::default(),
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
    /// Top-level fields this build does not know; see `VaultEntry::extra`.
    /// `VaultHeader` deliberately has none: its JSON is the AAD of the payload.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
    pub vault_id: String,
    pub revision: u64,
    pub entry_count: usize,
    /// Icon key stored inside the vault (settings.icon); empty if unset.
    pub icon: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_survive_parse_and_serialize() {
        let json = r#"{
            "revision": 2,
            "deviceId": "device",
            "entries": [{
                "id": "1", "title": "Mail", "username": "", "password": "", "url": "",
                "notes": "", "createdAt": "", "updatedAt": "", "deletedAt": null,
                "conflict": false, "favorite": true, "tags": ["x"]
            }],
            "settings": {},
            "futureField": {"a": 1}
        }"#;
        let data: VaultData = serde_json::from_str(json).unwrap();
        assert_eq!(data.entries[0].extra["favorite"], true);
        assert_eq!(data.entries[0].extra["tags"], serde_json::json!(["x"]));
        assert_eq!(data.extra["futureField"], serde_json::json!({"a": 1}));
        assert!(data.entries[0].deleted_at.is_none());

        let serialized: serde_json::Value = serde_json::to_value(&data).unwrap();
        let original: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(serialized, original);
    }

    #[test]
    fn no_unknown_fields_serialize_nothing_extra() {
        let entry = VaultEntry::imported("T".into(), String::new(), String::new(), String::new(), String::new());
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 10);
    }
}
