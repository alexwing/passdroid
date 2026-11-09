//! Session-free vault envelope operations: strings/bytes in, strings/bytes out.
//!
//! Nothing here holds state, touches the file system or knows about a UI. The
//! caller (VaultManager in the desktop app, a WASM wrapper in the browser) owns
//! the session and decides where the serialized vault is stored.
//!
//! Opening is split so the KDF can be injected: `parse_envelope` ->
//! `derive_key(password, &envelope.header.kdf)` (or any other implementation of
//! the same KDF) -> `open_envelope_with_key`. `open_envelope` composes the three
//! with the built-in `derive_key`.

use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    crypto::{
        default_cipher_info, default_kdf_params, derive_key, now_iso, open_payload, seal_payload,
        VAULT_MAGIC,
    },
    models::{KdfParams, VaultData, VaultEnvelope, VaultHeader, VaultStatus},
};

/// A vault that has been opened: header, derived key and decrypted data.
pub struct OpenedVault {
    pub header: VaultHeader,
    pub key: Zeroizing<[u8; 32]>,
    pub data: VaultData,
}

/// A freshly created, not yet sealed vault (revision 0, no entries).
pub struct NewVault {
    pub header: VaultHeader,
    pub key: Zeroizing<[u8; 32]>,
    pub data: VaultData,
}

pub fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("master_password_too_short".to_string());
    }
    Ok(())
}

pub fn validate_header(header: &VaultHeader) -> Result<(), String> {
    if header.magic != VAULT_MAGIC || header.version != 1 {
        return Err("unsupported_vault_format".to_string());
    }
    if header.cipher.algorithm != "XChaCha20-Poly1305" {
        return Err("unsupported_cipher".to_string());
    }
    Ok(())
}

/// Parse a serialized vault file and check its magic, version and cipher. The
/// header (including the KDF params to feed `derive_key`) is `envelope.header`.
pub fn parse_envelope(contents: &str) -> Result<VaultEnvelope, String> {
    let envelope: VaultEnvelope =
        serde_json::from_str(contents).map_err(|_| "vault_file_invalid".to_string())?;
    validate_header(&envelope.header)?;
    Ok(envelope)
}

/// Decrypt an envelope with an already-derived key. Any failure (wrong key,
/// tampered header or payload, malformed nonce) is reported as
/// `master_password_incorrect`.
pub fn open_envelope_with_key(envelope: &VaultEnvelope, key: &[u8]) -> Result<VaultData, String> {
    open_payload(&envelope.payload, &envelope.header, key)
        .map_err(|_| "master_password_incorrect".to_string())
}

/// Parse, derive the key from the header's KDF params and decrypt.
pub fn open_envelope(contents: &str, password: &str) -> Result<OpenedVault, String> {
    let envelope = parse_envelope(contents)?;
    let key = derive_key(password, &envelope.header.kdf)?;
    let data = open_envelope_with_key(&envelope, &key[..])?;
    Ok(OpenedVault {
        header: envelope.header,
        key,
        data,
    })
}

/// A new header with a random vault id and the given KDF params (the nonce is
/// set when the payload is sealed).
pub fn new_header(kdf: KdfParams) -> VaultHeader {
    let now = now_iso();
    VaultHeader {
        magic: VAULT_MAGIC.to_string(),
        version: 1,
        vault_id: Uuid::new_v4().to_string(),
        kdf,
        cipher: default_cipher_info(),
        nonce: String::new(),
        created_at: now.clone(),
        updated_at: now,
    }
}

/// Empty vault data with a random device id.
pub fn new_vault_data() -> VaultData {
    VaultData {
        revision: 0,
        device_id: Uuid::new_v4().to_string(),
        entries: Vec::new(),
        settings: serde_json::json!({}),
    }
}

/// Validate the password, derive a key with the platform default KDF params and
/// build an empty vault. Seal it with `seal_envelope` to get the file contents.
pub fn new_vault(master_password: &str) -> Result<NewVault, String> {
    validate_password(master_password)?;
    let kdf = default_kdf_params();
    let key = derive_key(master_password, &kdf)?;
    Ok(NewVault {
        header: new_header(kdf),
        key,
        data: new_vault_data(),
    })
}

/// Bump the revision, refresh `header.updated_at` and seal `data` with `key`,
/// returning the serialized envelope JSON. A fresh nonce is written into
/// `header`.
pub fn seal_envelope(
    header: &mut VaultHeader,
    data: &mut VaultData,
    key: &[u8],
) -> Result<String, String> {
    data.revision = data.revision.saturating_add(1);
    header.updated_at = now_iso();
    reseal_envelope(header, data, key)
}

/// Seal `data` WITHOUT advancing the revision or `updated_at` (used for export
/// copies). A fresh nonce is written into `header`.
pub fn reseal_envelope(header: &mut VaultHeader, data: &VaultData, key: &[u8]) -> Result<String, String> {
    let payload = seal_payload(data, header, key)?;
    let envelope = VaultEnvelope {
        header: header.clone(),
        payload,
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

/// Re-key a vault: check `old_password` against the current `key`, derive a new
/// key with fresh default KDF params and install those params in `header`.
/// Returns the new key; the caller re-seals with `seal_envelope`.
pub fn change_password(
    header: &mut VaultHeader,
    key: &[u8],
    old_password: &str,
    new_password: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    validate_password(new_password)?;
    let old_key = derive_key(old_password, &header.kdf)?;
    if old_key[..] != *key {
        return Err("master_password_incorrect".to_string());
    }

    let new_kdf = default_kdf_params();
    let new_key = derive_key(new_password, &new_kdf)?;
    header.kdf = new_kdf;
    Ok(new_key)
}

pub fn vault_status(header: &VaultHeader, data: &VaultData) -> VaultStatus {
    VaultStatus {
        vault_id: header.vault_id.clone(),
        revision: data.revision,
        entry_count: data.entries.iter().filter(|entry| entry.deleted_at.is_none()).count(),
        icon: data
            .settings
            .get("icon")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
    }
}
