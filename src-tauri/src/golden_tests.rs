//! Golden vector fixtures for Phase 0 of the passdroid-core extraction.
//!
//! The fixtures in `fixtures/golden/` are sealed by the CURRENT code (before any
//! refactor). The non-ignored test opens them and checks the decrypted data
//! against `expected-*.json`, so any later extraction of the core must stay
//! byte-compatible with real desktop (64 MiB) and Android (32 MiB) vaults.
//!
//! Regenerate (only when the format intentionally changes):
//!   cargo test generate_golden_fixtures -- --ignored --nocapture
//!
//! TEST-ONLY data: the password and sync settings below are dummies.

use std::{fs, path::PathBuf};

use uuid::Uuid;

use passdroid_core::{
    default_cipher_info, derive_key, encode_b64, now_iso, open_payload, random_bytes, seal_payload,
    KdfParams, VaultData, VaultEntry, VaultEnvelope, VaultHeader, VAULT_MAGIC,
};

use crate::{models::SyncConfig, vault::VaultManager};

const TEST_PASSWORD: &str = "phase0-golden-vectors";
const DESKTOP_FILE: &str = "desktop-64mib.pdvault";
const ANDROID_FILE: &str = "android-32mib.pdvault";
const EXPECTED_DESKTOP_FILE: &str = "expected-desktop.json";
const EXPECTED_ANDROID_FILE: &str = "expected-android.json";

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/golden")
}

fn read_fixture(name: &str) -> String {
    let path = golden_dir().join(name);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {} (run the generator): {e}", path.display()))
}

/// Android KDF params, built explicitly: `default_kdf_params()` picks 32 MiB only
/// under `cfg!(target_os = "android")`, which cannot be set on a desktop test run.
fn android_kdf_params() -> KdfParams {
    KdfParams {
        algorithm: "Argon2id".to_string(),
        memory_kib: 32 * 1024,
        iterations: 3,
        parallelism: 1,
        salt: encode_b64(&random_bytes(16)),
        output_len: 32,
    }
}

/// Decrypt a vault file straight through the crypto layer, returning the header
/// and the full `VaultData` (the manager API does not expose settings).
fn open_envelope(contents: &str) -> (VaultHeader, VaultData) {
    let envelope: VaultEnvelope = serde_json::from_str(contents).unwrap();
    let key = derive_key(TEST_PASSWORD, &envelope.header.kdf).unwrap();
    let data: VaultData = open_payload(&envelope.payload, &envelope.header, &key[..]).unwrap();
    (envelope.header, data)
}

fn pretty(data: &VaultData) -> String {
    let mut text = serde_json::to_string_pretty(data).unwrap();
    text.push('\n');
    text
}

fn write_fixture(name: &str, contents: &str) {
    let path = golden_dir().join(name);
    fs::write(&path, contents).unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
    println!("wrote {}", path.display());
}

fn sample_sync_config() -> SyncConfig {
    SyncConfig {
        enabled: true,
        protocol: "ftps".to_string(),
        host: "ftp.example.invalid".to_string(),
        port: 21,
        username: "fixture".to_string(),
        password: "fixture-password".to_string(),
        remote_dir: "vault".to_string(),
        remote_file: "passdroid.pdvault".to_string(),
    }
}

/// Desktop vault through the real `VaultManager` code path.
fn build_desktop_vault() -> String {
    let mut manager = VaultManager::default();
    manager.create(TEST_PASSWORD.to_string()).unwrap();

    // Unicode/emoji in title and notes.
    manager
        .upsert(VaultEntry::imported(
            "Cuenta bancaria \u{1F3E6} ñandú 日本語".to_string(),
            "titular@example.com".to_string(),
            "p\u{00E1}ssw\u{00F6}rd-\u{1F510}-Ω".to_string(),
            "Notas con emoji \u{1F510} y acentos áéíóú\nsegunda línea con \"comillas\" y \\barras".to_string(),
            String::new(),
        ))
        .unwrap();
    // URL and username.
    manager
        .upsert(VaultEntry::imported(
            "Mail".to_string(),
            "user@example.com".to_string(),
            "c0rrect-h0rse-battery".to_string(),
            String::new(),
            "https://mail.example.com/login?next=%2Finbox".to_string(),
        ))
        .unwrap();
    // Minimal: title only.
    manager
        .upsert(VaultEntry::imported(
            "Minimal".to_string(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ))
        .unwrap();

    manager.set_vault_icon("shield".to_string()).unwrap();
    manager.set_sync_config(sample_sync_config()).unwrap().contents
}

/// Same content sealed with Android KDF params, using the same header layout and
/// seal functions as `seal_envelope`. Production code paths are untouched.
fn build_android_vault(desktop_contents: &str) -> String {
    let (desktop_header, data) = open_envelope(desktop_contents);

    let kdf = android_kdf_params();
    let key = derive_key(TEST_PASSWORD, &kdf).unwrap();
    let mut header = VaultHeader {
        magic: VAULT_MAGIC.to_string(),
        version: 1,
        vault_id: Uuid::new_v4().to_string(),
        kdf,
        cipher: default_cipher_info(),
        nonce: String::new(),
        created_at: desktop_header.created_at,
        updated_at: now_iso(),
    };
    let payload = seal_payload(&data, &mut header, &key[..]).unwrap();
    serde_json::to_string_pretty(&VaultEnvelope { header, payload }).unwrap()
}

#[test]
#[ignore = "writes fixtures/golden/*; run manually to regenerate"]
fn generate_golden_fixtures() {
    fs::create_dir_all(golden_dir()).unwrap();

    let desktop = build_desktop_vault();
    let android = build_android_vault(&desktop);

    let (desktop_header, desktop_data) = open_envelope(&desktop);
    let (android_header, android_data) = open_envelope(&android);
    assert_eq!(desktop_header.kdf.memory_kib, 64 * 1024);
    assert_eq!(android_header.kdf.memory_kib, 32 * 1024);

    write_fixture(DESKTOP_FILE, &desktop);
    write_fixture(ANDROID_FILE, &android);
    write_fixture(EXPECTED_DESKTOP_FILE, &pretty(&desktop_data));
    write_fixture(EXPECTED_ANDROID_FILE, &pretty(&android_data));

    for (label, header) in [("desktop", &desktop_header), ("android", &android_header)] {
        println!(
            "{label} kdf: algorithm={} memoryKib={} iterations={} parallelism={} outputLen={} salt={}",
            header.kdf.algorithm,
            header.kdf.memory_kib,
            header.kdf.iterations,
            header.kdf.parallelism,
            header.kdf.output_len,
            header.kdf.salt,
        );
    }
}

fn expected_value(name: &str) -> serde_json::Value {
    serde_json::from_str(&read_fixture(name)).unwrap()
}

fn check_fixture(file: &str, expected_file: &str, memory_kib: u32) {
    let contents = read_fixture(file);
    let expected = expected_value(expected_file);

    // Header carries the params the fixture was sealed with.
    let (header, data) = open_envelope(&contents);
    assert_eq!(header.magic, VAULT_MAGIC);
    assert_eq!(header.version, 1);
    assert_eq!(header.kdf.algorithm, "Argon2id");
    assert_eq!(header.kdf.memory_kib, memory_kib);
    assert_eq!(header.kdf.iterations, 3);
    assert_eq!(header.kdf.parallelism, 1);
    assert_eq!(header.kdf.output_len, 32);
    assert_eq!(header.cipher.algorithm, "XChaCha20-Poly1305");

    // Decrypted data equals the golden JSON.
    assert_eq!(serde_json::to_value(&data).unwrap(), expected);

    // The manager opens it too, and sees the same entries and sync config.
    let mut manager = VaultManager::default();
    let status = manager.unlock(contents.clone(), TEST_PASSWORD.to_string()).unwrap();
    assert_eq!(status.entry_count, 3);
    assert_eq!(status.icon, "shield");
    assert_eq!(status.revision, data.revision);
    assert_eq!(
        serde_json::to_value(manager.list().unwrap()).unwrap(),
        {
            let mut visible = expected["entries"].as_array().unwrap().clone();
            visible.sort_by_key(|e| e["title"].as_str().unwrap().to_lowercase());
            serde_json::Value::Array(visible)
        }
    );
    let sync = manager.get_sync_config().unwrap().unwrap();
    assert_eq!(sync.protocol, "ftps");
    assert_eq!(sync.host, "ftp.example.invalid");

    // A wrong password is rejected.
    manager.lock();
    assert_eq!(
        manager.unlock(contents.clone(), "not-the-password".to_string()),
        Err("master_password_incorrect".to_string())
    );

    // Reseal (save) and reopen: contents differ (fresh nonce), data is identical.
    manager.unlock(contents.clone(), TEST_PASSWORD.to_string()).unwrap();
    let resealed = manager.save().unwrap().contents;
    assert_ne!(resealed, contents);
    let (resealed_header, resealed_data) = open_envelope(&resealed);
    assert_eq!(resealed_header.kdf.memory_kib, memory_kib);
    assert_ne!(resealed_header.nonce, header.nonce);
    assert_eq!(serde_json::to_value(&resealed_data).unwrap(), expected);

    // Reopen the resealed file through the manager.
    manager.lock();
    manager.unlock(resealed, TEST_PASSWORD.to_string()).unwrap();
    assert_eq!(manager.list().unwrap().len(), 3);
}

#[test]
fn desktop_fixture_opens_and_round_trips() {
    check_fixture(DESKTOP_FILE, EXPECTED_DESKTOP_FILE, 64 * 1024);
}

#[test]
fn android_fixture_opens_and_round_trips() {
    check_fixture(ANDROID_FILE, EXPECTED_ANDROID_FILE, 32 * 1024);
}
