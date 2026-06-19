use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305,
};
use chrono::{SecondsFormat, Utc};
use rand_core::{OsRng, RngCore};
use serde::{de::DeserializeOwned, Serialize};
use zeroize::Zeroizing;

use crate::models::{CipherInfo, KdfParams, VaultHeader};

pub const VAULT_MAGIC: &str = "passdroid-vault-v1";

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn encode_b64(data: &[u8]) -> String {
    general_purpose::STANDARD.encode(data)
}

pub fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "invalid_base64".to_string())
}

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

pub fn default_kdf_params() -> KdfParams {
    let memory_kib = if cfg!(target_os = "android") { 32 * 1024 } else { 64 * 1024 };
    KdfParams {
        algorithm: "Argon2id".to_string(),
        memory_kib,
        iterations: 3,
        parallelism: 1,
        salt: encode_b64(&random_bytes(16)),
        output_len: 32,
    }
}

pub fn default_cipher_info() -> CipherInfo {
    CipherInfo {
        algorithm: "XChaCha20-Poly1305".to_string(),
    }
}

pub fn derive_key(password: &str, params: &KdfParams) -> Result<Zeroizing<[u8; 32]>, String> {
    if params.algorithm != "Argon2id" || params.output_len != 32 {
        return Err("unsupported_kdf".to_string());
    }

    let salt = decode_b64(&params.salt)?;
    let argon_params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(params.output_len as usize),
    )
    .map_err(|_| "invalid_kdf_params".to_string())?;

    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params)
        .hash_password_into(password.as_bytes(), &salt, &mut key[..])
        .map_err(|_| "key_derivation_failed".to_string())?;

    Ok(key)
}

pub fn seal_payload<T: Serialize>(
    value: &T,
    header: &mut VaultHeader,
    key: &[u8],
) -> Result<String, String> {
    let nonce = random_bytes(24);
    header.nonce = encode_b64(&nonce);

    let aad = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    // Hold the cleartext in a zeroizing buffer so it is wiped on drop.
    let plaintext = Zeroizing::new(serde_json::to_vec(value).map_err(|e| e.to_string())?);
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| "invalid_key".to_string())?;
    let encrypted = cipher
        .encrypt(
            nonce.as_slice().into(),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "encryption_failed".to_string())?;

    Ok(encode_b64(&encrypted))
}

pub fn open_payload<T: DeserializeOwned>(
    payload: &str,
    header: &VaultHeader,
    key: &[u8],
) -> Result<T, String> {
    let nonce = decode_b64(&header.nonce)?;
    if nonce.len() != 24 {
        return Err("invalid_nonce".to_string());
    }

    let aad = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    let encrypted = decode_b64(payload)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| "invalid_key".to_string())?;
    // Wipe the decrypted cleartext on drop once it has been deserialized.
    let decrypted = Zeroizing::new(
        cipher
            .decrypt(
                nonce.as_slice().into(),
                Payload {
                    msg: &encrypted,
                    aad: &aad,
                },
            )
            .map_err(|_| "decryption_failed".to_string())?,
    );

    serde_json::from_slice(&decrypted).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{VaultData, VaultEntry, VaultHeader};

    fn sample_header(kdf: KdfParams) -> VaultHeader {
        let now = now_iso();
        VaultHeader {
            magic: VAULT_MAGIC.to_string(),
            version: 1,
            vault_id: "test".to_string(),
            kdf,
            cipher: default_cipher_info(),
            nonce: String::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn sample_data() -> VaultData {
        VaultData {
            revision: 1,
            device_id: "device".to_string(),
            entries: vec![VaultEntry::imported(
                "Mail".to_string(),
                "user@example.com".to_string(),
                "p4ssword!".to_string(),
                "note line".to_string(),
                "https://example.com".to_string(),
            )],
            settings: serde_json::json!({ "clearClipboard": 30 }),
        }
    }

    #[test]
    fn vault_payload_round_trips_with_contents() {
        let kdf = default_kdf_params();
        let key = derive_key("correct horse battery staple", &kdf).unwrap();
        let mut header = sample_header(kdf);
        let data = sample_data();

        let payload = seal_payload(&data, &mut header, &key[..]).unwrap();
        let opened: VaultData = open_payload(&payload, &header, &key[..]).unwrap();

        assert_eq!(opened.revision, data.revision);
        assert_eq!(opened.device_id, data.device_id);
        assert_eq!(opened.settings, data.settings);
        assert_eq!(opened.entries.len(), 1);
        assert_eq!(opened.entries[0].title, "Mail");
        assert_eq!(opened.entries[0].password, "p4ssword!");
        assert_eq!(opened.entries[0].notes, "note line");
    }

    #[test]
    fn open_payload_rejects_wrong_password() {
        let kdf = default_kdf_params();
        let key = derive_key("the right password", &kdf).unwrap();
        let mut header = sample_header(kdf.clone());
        let payload = seal_payload(&sample_data(), &mut header, &key[..]).unwrap();

        // A different password derives a different key against the SAME salt.
        let wrong_key = derive_key("the wrong password", &kdf).unwrap();
        assert!(open_payload::<VaultData>(&payload, &header, &wrong_key[..]).is_err());
    }

    #[test]
    fn open_payload_rejects_header_tampering() {
        let kdf = default_kdf_params();
        let key = derive_key("pw", &kdf).unwrap();
        let mut header = sample_header(kdf);
        let payload = seal_payload(&sample_data(), &mut header, &key[..]).unwrap();

        // The header is authenticated as AAD, so changing any field breaks it.
        let mut tampered = header.clone();
        tampered.vault_id = "other".to_string();
        assert!(open_payload::<VaultData>(&payload, &tampered, &key[..]).is_err());
    }

    #[test]
    fn open_payload_rejects_ciphertext_tampering() {
        let kdf = default_kdf_params();
        let key = derive_key("pw", &kdf).unwrap();
        let mut header = sample_header(kdf);
        let payload = seal_payload(&sample_data(), &mut header, &key[..]).unwrap();

        // Flip one byte of the ciphertext body; the AEAD tag must reject it.
        let mut raw = decode_b64(&payload).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        let tampered_payload = encode_b64(&raw);
        assert!(open_payload::<VaultData>(&tampered_payload, &header, &key[..]).is_err());
    }

    #[test]
    fn open_payload_rejects_nonce_tampering_and_bad_length() {
        let kdf = default_kdf_params();
        let key = derive_key("pw", &kdf).unwrap();
        let mut header = sample_header(kdf);
        let payload = seal_payload(&sample_data(), &mut header, &key[..]).unwrap();

        // Mutating the (correct length) nonce makes decryption fail.
        let mut nonce = decode_b64(&header.nonce).unwrap();
        nonce[0] ^= 0xff;
        let mut wrong_nonce = header.clone();
        wrong_nonce.nonce = encode_b64(&nonce);
        assert!(open_payload::<VaultData>(&payload, &wrong_nonce, &key[..]).is_err());

        // A wrong-length nonce is rejected up front.
        let mut short_nonce = header.clone();
        short_nonce.nonce = encode_b64(&[0u8; 12]);
        assert_eq!(
            open_payload::<VaultData>(&payload, &short_nonce, &key[..]).unwrap_err(),
            "invalid_nonce"
        );
    }

    #[test]
    fn derive_key_is_deterministic_for_same_inputs() {
        let kdf = default_kdf_params();
        let a = derive_key("repeatable", &kdf).unwrap();
        let b = derive_key("repeatable", &kdf).unwrap();
        assert_eq!(a[..], b[..]);

        let c = derive_key("different", &kdf).unwrap();
        assert_ne!(a[..], c[..]);
    }

    #[test]
    fn derive_key_rejects_unsupported_kdf() {
        let mut kdf = default_kdf_params();
        kdf.algorithm = "scrypt".to_string();
        assert_eq!(derive_key("pw", &kdf), Err("unsupported_kdf".to_string()));

        let mut kdf = default_kdf_params();
        kdf.output_len = 16;
        assert_eq!(derive_key("pw", &kdf), Err("unsupported_kdf".to_string()));
    }

    #[test]
    fn derive_key_rejects_invalid_params_and_salt() {
        let mut kdf = default_kdf_params();
        kdf.memory_kib = 0;
        assert_eq!(derive_key("pw", &kdf), Err("invalid_kdf_params".to_string()));

        let mut kdf = default_kdf_params();
        kdf.salt = "not valid base64!!!".to_string();
        assert_eq!(derive_key("pw", &kdf), Err("invalid_base64".to_string()));
    }

    #[test]
    fn default_kdf_params_meet_owasp_minimums() {
        let kdf = default_kdf_params();
        assert_eq!(kdf.algorithm, "Argon2id");
        assert!(kdf.memory_kib >= 19 * 1024, "memory below OWASP Argon2id floor");
        assert!(kdf.iterations >= 2);
        assert_eq!(kdf.output_len, 32);
        // 16-byte random salt, base64-encoded.
        assert_eq!(decode_b64(&kdf.salt).unwrap().len(), 16);
    }
}
