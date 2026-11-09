//! Golden vector fixtures (Phase 0): real-format desktop (64 MiB) and Android
//! (32 MiB) vaults sealed by the code BEFORE the core extraction. The core must
//! open them and reproduce the expected data. Uses only the public core API.
//!
//! The fixtures and their generator live in the app crate
//! (`src-tauri/src/golden_tests.rs`); see `fixtures/golden/README.md`.
//!
//! TEST-ONLY data: the password below is a dummy.

use std::{fs, path::PathBuf};

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305,
};
use passdroid_core::{
    change_password, check_kdf_bounds, decode_b64, derive_key, encode_b64, open_envelope,
    open_envelope_with_key, parse_envelope, reseal_envelope, seal_envelope, vault_status,
    visible_entries, VaultData, VaultEnvelope, VAULT_MAGIC,
};

const TEST_PASSWORD: &str = "phase0-golden-vectors";

fn read_fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/golden").join(name);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// Decrypt the payload to the exact cleartext bytes that were sealed. Same
/// cipher and AAD (the serialized header) as `crypto::open_payload`, but the
/// public API only returns the deserialized `VaultData`, not the bytes.
fn decrypt_payload_bytes(envelope: &VaultEnvelope, key: &[u8]) -> Vec<u8> {
    let nonce = decode_b64(&envelope.header.nonce).unwrap();
    let aad = serde_json::to_vec(&envelope.header).unwrap();
    let encrypted = decode_b64(&envelope.payload).unwrap();
    XChaCha20Poly1305::new_from_slice(key)
        .unwrap()
        .decrypt(nonce.as_slice().into(), Payload { msg: &encrypted, aad: &aad })
        .expect("golden payload must decrypt with its own key and header")
}

/// The format did not change: parsing the golden cleartext into `VaultData` and
/// serializing it back yields the same bytes that were sealed.
#[test]
fn golden_plaintext_reserializes_byte_for_byte() {
    for file in ["desktop-64mib.pdvault", "android-32mib.pdvault", "android-real-32mib.pdvault"] {
        let envelope = parse_envelope(&read_fixture(file)).unwrap();
        let key = derive_key(TEST_PASSWORD, &envelope.header.kdf).unwrap();
        let plaintext = decrypt_payload_bytes(&envelope, &key[..]);
        assert!(!plaintext.is_empty(), "{file}");

        let data: VaultData = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(serde_json::to_vec(&data).unwrap(), plaintext, "{file}");
    }
}

fn check_fixture(file: &str, expected_file: &str, memory_kib: u32) {
    let contents = read_fixture(file);
    let expected: serde_json::Value = serde_json::from_str(&read_fixture(expected_file)).unwrap();

    // Header carries the params the fixture was sealed with.
    let envelope = parse_envelope(&contents).unwrap();
    let header = &envelope.header;
    assert_eq!(header.magic, VAULT_MAGIC);
    assert_eq!(header.version, 1);
    assert_eq!(header.kdf.algorithm, "Argon2id");
    assert_eq!(header.kdf.memory_kib, memory_kib);
    assert_eq!(header.kdf.iterations, 3);
    assert_eq!(header.kdf.parallelism, 1);
    assert_eq!(header.kdf.output_len, 32);
    assert_eq!(header.cipher.algorithm, "XChaCha20-Poly1305");

    // Split path (injectable KDF): derive, then open with the derived key.
    let key = derive_key(TEST_PASSWORD, &header.kdf).unwrap();
    let data = open_envelope_with_key(&envelope, &key[..]).unwrap();
    assert_eq!(serde_json::to_value(&data).unwrap(), expected);

    // Convenience path gives the same result.
    let opened = open_envelope(&contents, TEST_PASSWORD).unwrap();
    assert_eq!(serde_json::to_value(&opened.data).unwrap(), expected);
    assert_eq!(opened.key[..], key[..]);

    let status = vault_status(&opened.header, &opened.data);
    assert_eq!(status.entry_count, 3);
    assert_eq!(status.icon, "shield");
    assert_eq!(status.revision, opened.data.revision);
    assert_eq!(visible_entries(&opened.data.entries).len(), 3);
    assert_eq!(opened.data.settings["sync"]["protocol"], "ftps");
    assert_eq!(opened.data.settings["sync"]["host"], "ftp.example.invalid");

    // A wrong password is rejected.
    assert_eq!(
        open_envelope(&contents, "not-the-password").err(),
        Some("master_password_incorrect".to_string())
    );

    // Tampering with the header (AAD) or the ciphertext is rejected.
    let mut tampered = envelope.clone();
    tampered.header.vault_id = "other".to_string();
    assert!(open_envelope_with_key(&tampered, &key[..]).is_err());
    let mut raw = decode_b64(&envelope.payload).unwrap();
    let last = raw.len() - 1;
    raw[last] ^= 0x01;
    let mut tampered = envelope.clone();
    tampered.payload = encode_b64(&raw);
    assert!(open_envelope_with_key(&tampered, &key[..]).is_err());

    // Reseal without advancing the revision: fresh nonce, identical data.
    let mut opened = opened;
    let resealed = reseal_envelope(&mut opened.header, &opened.data, &opened.key[..]).unwrap();
    assert_ne!(resealed, contents);
    let reopened = open_envelope(&resealed, TEST_PASSWORD).unwrap();
    assert_eq!(reopened.header.kdf.memory_kib, memory_kib);
    assert_ne!(reopened.header.nonce, envelope.header.nonce);
    assert_eq!(serde_json::to_value(&reopened.data).unwrap(), expected);

    // Seal (advancing) bumps the revision by one and updates the header time.
    let mut reopened = reopened;
    let revision = reopened.data.revision;
    let sealed = seal_envelope(&mut reopened.header, &mut reopened.data, &reopened.key[..]).unwrap();
    let again = open_envelope(&sealed, TEST_PASSWORD).unwrap();
    assert_eq!(again.data.revision, revision + 1);
    assert_eq!(again.data.entries, reopened.data.entries);

    // Serialization is stable: pretty JSON, header fields in declaration order.
    let parsed: VaultEnvelope = serde_json::from_str(&sealed).unwrap();
    assert_eq!(serde_json::to_string_pretty(&parsed).unwrap(), sealed);
    let header_json = sealed.split("\"payload\"").next().unwrap();
    let order = [
        "magic", "version", "vaultId", "kdf", "cipher", "nonce", "createdAt", "updatedAt",
    ]
    .map(|field| header_json.find(&format!("\"{field}\"")).unwrap());
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "header field order changed");

    // Re-keying: old password is checked, new KDF params are installed.
    let mut again = again;
    assert_eq!(
        change_password(&mut again.header, &again.key[..], "wrong-old-pass", "new-pass-1234").err(),
        Some("master_password_incorrect".to_string())
    );
    let new_key = change_password(&mut again.header, &again.key[..], TEST_PASSWORD, "new-pass-1234").unwrap();
    let rekeyed = seal_envelope(&mut again.header, &mut again.data, &new_key[..]).unwrap();
    assert!(open_envelope(&rekeyed, TEST_PASSWORD).is_err());
    assert_eq!(open_envelope(&rekeyed, "new-pass-1234").unwrap().data.entries, again.data.entries);
}

#[test]
fn desktop_fixture_opens_with_core() {
    check_fixture("desktop-64mib.pdvault", "expected-desktop.json", 64 * 1024);
}

#[test]
fn android_fixture_opens_with_core() {
    check_fixture("android-32mib.pdvault", "expected-android.json", 32 * 1024);
}

/// Created on a real Android device (POCO X7 Pro, debug build of branch
/// `fix/android-export`), exported through the fixed MediaStore path. Unlike the
/// synthetic `android-32mib.pdvault`, the Android KDF params, ids and timestamps
/// come straight from the Android build. No icon or sync settings were set.
#[test]
fn android_real_fixture_opens_with_core() {
    let contents = read_fixture("android-real-32mib.pdvault");
    let expected: serde_json::Value =
        serde_json::from_str(&read_fixture("expected-android-real.json")).unwrap();

    let envelope = parse_envelope(&contents).unwrap();
    let header = &envelope.header;
    assert_eq!(header.magic, VAULT_MAGIC);
    assert_eq!(header.version, 1);
    assert_eq!(header.kdf.algorithm, "Argon2id");
    assert_eq!(header.kdf.memory_kib, 32 * 1024);
    assert_eq!(header.kdf.iterations, 3);
    assert_eq!(header.kdf.parallelism, 1);
    assert_eq!(header.kdf.output_len, 32);
    assert_eq!(header.cipher.algorithm, "XChaCha20-Poly1305");

    let opened = open_envelope(&contents, TEST_PASSWORD).unwrap();
    assert_eq!(serde_json::to_value(&opened.data).unwrap(), expected);
    let titles: Vec<&str> = opened.data.entries.iter().map(|e| e.title.as_str()).collect();
    assert_eq!(titles, ["Café 😅 Ñandú", "Fixture Login", "Minimal"]);
    assert_eq!(opened.data.entries[0].notes, "Notas café mañana");
    assert_eq!(opened.data.entries[1].username, "fixture-user");
    assert_eq!(opened.data.entries[1].url, "https://example.invalid/login");
    assert_eq!(visible_entries(&opened.data.entries).len(), 3);
    assert_eq!(vault_status(&opened.header, &opened.data).entry_count, 3);

    assert_eq!(
        open_envelope(&contents, "not-the-password").err(),
        Some("master_password_incorrect".to_string())
    );

    // Reseal + reopen round-trips with the Android params kept.
    let mut opened = opened;
    let resealed = reseal_envelope(&mut opened.header, &opened.data, &opened.key[..]).unwrap();
    assert_ne!(resealed, contents);
    let reopened = open_envelope(&resealed, TEST_PASSWORD).unwrap();
    assert_eq!(reopened.header.kdf.memory_kib, 32 * 1024);
    assert_ne!(reopened.header.nonce, envelope.header.nonce);
    assert_eq!(serde_json::to_value(&reopened.data).unwrap(), expected);
}

/// The KDF params in every golden fixture header are inside the accepted bounds.
#[test]
fn golden_fixture_headers_pass_kdf_bounds() {
    for file in ["desktop-64mib.pdvault", "android-32mib.pdvault", "android-real-32mib.pdvault"] {
        let envelope = parse_envelope(&read_fixture(file)).unwrap();
        assert_eq!(check_kdf_bounds(&envelope.header.kdf), Ok(()), "{file}");
    }
}
