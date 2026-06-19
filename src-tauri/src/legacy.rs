// One-time migration reader for legacy Passdroid databases and exports.
//
// The decryption routines below reimplement the on-disk crypto of the original
// Passdroid Android app (Crypto.java / PasswordEntry.java / FileExporter.java,
// Copyright (C) 2009-2012 Magnus Eriksson, GPLv3). They exist ONLY to read a
// user-supplied legacy file so its contents can be re-encrypted into the modern
// Argon2id + XChaCha20-Poly1305 vault. This legacy (and weak) crypto is never
// used to create new data. Reused under the GNU GPL v3 or later.
use aes::{
    cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyInit, KeyIvInit},
    Aes256,
};
use base64::{engine::general_purpose, Engine as _};
use cbc::Decryptor as CbcDecryptor;
use crc32fast::Hasher;
use ecb::Decryptor as EcbDecryptor;
use hmac::{Hmac, Mac};
use rusqlite::Connection;
use sha2::Sha256;
use std::{fs, path::Path};

use crate::models::VaultEntry;

type HmacSha256 = Hmac<Sha256>;
type Aes256CbcDec = CbcDecryptor<Aes256>;
type Aes256EcbDec = EcbDecryptor<Aes256>;

#[cfg(test)]
use aes::cipher::BlockEncryptMut;
#[cfg(test)]
type Aes256CbcEnc = cbc::Encryptor<Aes256>;

/// Test-only: AES-256-CBC encrypt with PKCS7 padding, matching the legacy
/// Bouncy Castle output, so we can build fixtures without committing binaries.
#[cfg(test)]
fn encrypt_cbc_raw(key: &[u8], iv: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; plaintext.len() + 16];
    buf[..plaintext.len()].copy_from_slice(plaintext);
    Aes256CbcEnc::new_from_slices(key, iv)
        .unwrap()
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .unwrap()
        .to_vec()
}

/// Import from in-memory bytes. The frontend reads the picked file via the
/// Tauri fs plugin (content-URI aware on Android) and passes the bytes here.
/// SQLite needs a real path for rusqlite, so its bytes are written to a temp
/// file first.
pub fn import_legacy_entries_from_bytes(
    name: &str,
    bytes: &[u8],
    legacy_password: Option<String>,
) -> Result<Vec<VaultEntry>, String> {
    if is_sqlite(bytes, name) {
        let password = legacy_password.ok_or_else(|| "legacy_password_required".to_string())?;
        let mut tmp = std::env::temp_dir();
        tmp.push(format!("passdroid-import-{}.db", uuid::Uuid::new_v4()));
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        let result = import_sqlite(&tmp.to_string_lossy(), &password);
        let _ = fs::remove_file(&tmp);
        return result;
    }
    import_decoded(bytes, legacy_password)
}

fn is_sqlite(bytes: &[u8], name: &str) -> bool {
    bytes.starts_with(b"SQLite format 3")
        || Path::new(name).extension().and_then(|v| v.to_str()) == Some("db")
}

fn import_decoded(bytes: &[u8], legacy_password: Option<String>) -> Result<Vec<VaultEntry>, String> {
    if bytes.starts_with(b"sqt") {
        let password = legacy_password.ok_or_else(|| "legacy_password_required".to_string())?;
        let xml = decrypt_legacy_export(bytes, &password)?;
        return parse_xml(&xml);
    }
    let xml = String::from_utf8(bytes.to_vec()).map_err(|_| "legacy_file_not_utf8".to_string())?;
    parse_xml(&xml)
}

/// Serialize entries to the legacy Passdroid cleartext XML format
/// (`<passdroid>` with per-entry `<system>` and CDATA children), matching the
/// old app's FileExporter so the output is readable by both this app and the
/// original Passdroid. The output is UNENCRYPTED.
pub fn entries_to_legacy_xml(entries: &[VaultEntry], app_version: &str) -> String {
    let mut sb = String::new();
    sb.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    sb.push_str(&format!("<passdroid version=\"{}\">\n", escape_xml_attr(app_version)));
    for entry in entries {
        sb.push_str(&format!("  <system name=\"{}\">\n", escape_xml_attr(&entry.title)));
        push_cdata_field(&mut sb, "username", &entry.username);
        push_cdata_field(&mut sb, "password", &entry.password);
        push_cdata_field(&mut sb, "note", &entry.notes);
        push_cdata_field(&mut sb, "url", &entry.url);
        sb.push_str("  </system>\n");
    }
    sb.push_str("</passdroid>\n");
    sb
}

fn push_cdata_field(sb: &mut String, tag: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    // Split any literal "]]>" so it cannot terminate the CDATA section early,
    // mirroring the original exporter's escaping.
    let escaped = value.replace("]]>", "]]>]]><![CDATA[");
    sb.push_str(&format!("    <{tag}><![CDATA[{escaped}]]></{tag}>\n"));
}

fn escape_xml_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn parse_xml(xml: &str) -> Result<Vec<VaultEntry>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|_| "legacy_xml_invalid".to_string())?;
    let root = doc.root_element();
    if root.tag_name().name() != "passdroid" {
        return Err("legacy_xml_invalid_root".to_string());
    }

    let mut entries = Vec::new();
    for system in root.children().filter(|n| n.has_tag_name("system")) {
        let title = system.attribute("name").unwrap_or_default().to_string();
        let username = child_text(system, "username");
        let password = child_text(system, "password");
        let notes = child_text(system, "note");
        let url = child_text(system, "url");
        entries.push(VaultEntry::imported(title, username, password, notes, url));
    }

    Ok(entries)
}

fn child_text(node: roxmltree::Node<'_, '_>, name: &str) -> String {
    node.children()
        .find(|child| child.has_tag_name(name))
        .and_then(|child| child.text())
        .unwrap_or_default()
        .to_string()
}

fn import_sqlite(path: &str, password: &str) -> Result<Vec<VaultEntry>, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    let system_key: String = conn
        .query_row("SELECT value FROM system WHERE attribute = 'key'", [], |row| row.get(0))
        .map_err(|_| "legacy_key_missing".to_string())?;

    if !verify_legacy_password(password, &system_key)? {
        return Err("legacy_password_incorrect".to_string());
    }

    let key = hmac_from_password(password)?;
    let query_with_notes = "SELECT id, system, username, password, note, url FROM data ORDER BY id";
    let query_basic = "SELECT id, system, username, password FROM data ORDER BY id";

    let mut entries = Vec::new();
    match conn.prepare(query_with_notes) {
        Ok(mut stmt) => {
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (title, username, password, notes, url) = row.map_err(|e| e.to_string())?;
                entries.push(VaultEntry::imported(
                    decrypt_legacy_field(&key, title)?,
                    decrypt_legacy_field(&key, username)?,
                    decrypt_legacy_field(&key, password)?,
                    decrypt_legacy_field(&key, notes)?,
                    decrypt_legacy_field(&key, url)?,
                ));
            }
        }
        Err(_) => {
            let mut stmt = conn.prepare(query_basic).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (title, username, password) = row.map_err(|e| e.to_string())?;
                entries.push(VaultEntry::imported(
                    decrypt_legacy_field(&key, title)?,
                    decrypt_legacy_field(&key, username)?,
                    decrypt_legacy_field(&key, password)?,
                    String::new(),
                    String::new(),
                ));
            }
        }
    }

    Ok(entries)
}

fn decrypt_legacy_export(bytes: &[u8], password: &str) -> Result<String, String> {
    if bytes.len() <= 3 {
        return Err("legacy_file_too_small".to_string());
    }
    let key = hmac_from_password(password)?;
    let clear = decrypt_cbc(&key, &[0u8; 16], &bytes[3..])?;
    if clear.len() < 2 {
        return Err("legacy_export_invalid".to_string());
    }
    String::from_utf8(clear[2..].to_vec()).map_err(|_| "legacy_export_not_utf8".to_string())
}

fn verify_legacy_password(password: &str, db_string: &str) -> Result<bool, String> {
    let xor = general_purpose::STANDARD
        .decode(db_string)
        .map_err(|_| "legacy_key_invalid".to_string())?;
    let hmac = hmac_from_password(password)?;
    if xor.len() != hmac.len() {
        return Ok(false);
    }

    let mut key = vec![0u8; xor.len()];
    for (idx, value) in key.iter_mut().enumerate() {
        *value = xor[idx] ^ hmac[idx];
    }

    let mut hasher = Hasher::new();
    hasher.update(&key[..28]);
    let crc = hasher.finalize();

    Ok(key[28] == ((crc >> 24) & 0xff) as u8
        && key[29] == ((crc >> 16) & 0xff) as u8
        && key[30] == ((crc >> 8) & 0xff) as u8
        && key[31] == (crc & 0xff) as u8)
}

fn hmac_from_password(password: &str) -> Result<Vec<u8>, String> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(b"notverysecretiv")
        .map_err(|_| "legacy_hmac_failed".to_string())?;
    mac.update(password.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

// Decrypt a single encrypted field from the legacy `data` table.
//
// Branch order matches the precedence of the legacy on-disk formats:
//   1. Modern Passdroid 2.x (PasswordEntry.decrypt): a random 16-byte IV
//      prefix, then AES-256-CBC of the cleartext with no salt. This is what a
//      live, auto-migrated `password.db` actually stores and is the supported
//      target of this importer.
//   2. Very old zero-IV format (PasswordEntry.decryptZeroIv): all-zero IV with
//      a 2-byte salt prefix on the plaintext.
//   3. Ancient ECB format (PasswordEntry.decryptEcb).
//
// Branches 2/3 only fire when branch 1 fails to produce valid UTF-8. Note that
// a pre-2.x DB that was never opened by a notes/URL-capable version (so its
// fields are still zero-IV) can decode under branch 1 to a left-shifted, valid
// looking but truncated string; such un-migrated DBs are out of scope here
// (the plan targets `password.db` 2.x). Live DBs are always migrated to format 1.
fn decrypt_legacy_field(key: &[u8], encrypted: Option<String>) -> Result<String, String> {
    let Some(encrypted) = encrypted else {
        return Ok(String::new());
    };
    if encrypted.is_empty() {
        return Ok(String::new());
    }

    let bytes = general_purpose::STANDARD
        .decode(encrypted)
        .map_err(|_| "legacy_field_base64_invalid".to_string())?;

    if bytes.len() > 16 {
        if let Ok(clear) = decrypt_cbc(key, &bytes[..16], &bytes[16..]) {
            if let Ok(text) = String::from_utf8(clear) {
                return Ok(text);
            }
        }
    }

    if let Ok(clear) = decrypt_cbc(key, &[0u8; 16], &bytes) {
        if clear.len() >= 2 {
            if let Ok(text) = String::from_utf8(clear[2..].to_vec()) {
                return Ok(text);
            }
        }
    }

    if let Ok(clear) = decrypt_ecb(key, &bytes) {
        if clear.len() >= 2 {
            if let Ok(text) = String::from_utf8(clear[2..].to_vec()) {
                return Ok(text);
            }
        }
    }

    Err("legacy_field_decryption_failed".to_string())
}

fn decrypt_cbc(key: &[u8], iv: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = encrypted.to_vec();
    let decrypted = Aes256CbcDec::new_from_slices(key, iv)
        .map_err(|_| "legacy_aes_invalid".to_string())?
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "legacy_aes_decryption_failed".to_string())?;
    Ok(decrypted.to_vec())
}

fn decrypt_ecb(key: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = encrypted.to_vec();
    let decrypted = Aes256EcbDec::new_from_slice(key)
        .map_err(|_| "legacy_aes_invalid".to_string())?
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "legacy_aes_decryption_failed".to_string())?;
    Ok(decrypted.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    const SAMPLE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<passdroid version="2.3">
  <system name="Mail">
    <username><![CDATA[user@example.com]]></username>
    <password><![CDATA[secret]]></password>
    <note><![CDATA[note]]></note>
    <url><![CDATA[https://example.com]]></url>
  </system>
</passdroid>"#;

    fn temp_path(tag: &str, ext: &str) -> String {
        let mut dir = std::env::temp_dir();
        dir.push(format!("passdroid-legacy-{}-{}.{}", tag, Uuid::new_v4(), ext));
        dir.to_string_lossy().to_string()
    }

    /// Build a valid `system.key` value that `verify_legacy_password` accepts.
    fn make_system_key(password: &str) -> String {
        let hmac = hmac_from_password(password).unwrap();
        let mut key = [0u8; 32];
        for (i, byte) in key.iter_mut().enumerate().take(28) {
            *byte = (i as u8).wrapping_mul(7);
        }
        let mut hasher = Hasher::new();
        hasher.update(&key[..28]);
        let crc = hasher.finalize();
        key[28] = ((crc >> 24) & 0xff) as u8;
        key[29] = ((crc >> 16) & 0xff) as u8;
        key[30] = ((crc >> 8) & 0xff) as u8;
        key[31] = (crc & 0xff) as u8;
        let xor = key.iter().zip(hmac.iter()).map(|(k, h)| k ^ h).collect::<Vec<_>>();
        general_purpose::STANDARD.encode(xor)
    }

    /// Encode a field in the modern Passdroid 2.x format: base64(IV || AES-CBC).
    fn encode_modern_field(hmac: &[u8], clear: &str) -> String {
        let iv = [7u8; 16];
        let mut blob = iv.to_vec();
        blob.extend_from_slice(&encrypt_cbc_raw(hmac, &iv, clear.as_bytes()));
        general_purpose::STANDARD.encode(blob)
    }

    fn build_legacy_db(path: &str, password: &str) {
        let hmac = hmac_from_password(password).unwrap();
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE system (id INTEGER PRIMARY KEY AUTOINCREMENT, attribute TEXT NOT NULL, value TEXT);
             CREATE TABLE data (id INTEGER PRIMARY KEY AUTOINCREMENT, system TEXT NOT NULL, username TEXT, password TEXT, note TEXT, url TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO system (attribute, value) VALUES ('key', ?1)",
            rusqlite::params![make_system_key(password)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO data (system, username, password, note, url) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                encode_modern_field(&hmac, "Mail"),
                encode_modern_field(&hmac, "user@example.com"),
                encode_modern_field(&hmac, "a-long-enough-password-1234567890"),
                encode_modern_field(&hmac, "a multi word note"),
                encode_modern_field(&hmac, "https://mail.example.com"),
            ],
        )
        .unwrap();
        drop(conn);
    }

    #[test]
    fn parses_clear_passdroid_xml() {
        let entries = parse_xml(SAMPLE_XML).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Mail");
        assert_eq!(entries[0].username, "user@example.com");
        assert_eq!(entries[0].password, "secret");
    }

    #[test]
    fn imports_clear_xml_bytes() {
        let entries = import_legacy_entries_from_bytes("export.xml", SAMPLE_XML.as_bytes(), None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].url, "https://example.com");
    }

    #[test]
    fn imports_encrypted_sqt_export_round_trip() {
        let password = "legacy-export-pass";
        let hmac = hmac_from_password(password).unwrap();
        // Format: "sqt" || AES-CBC(zero IV, [2 salt bytes] || xml).
        let mut plaintext = vec![0u8, 0u8];
        plaintext.extend_from_slice(SAMPLE_XML.as_bytes());
        let mut blob = b"sqt".to_vec();
        blob.extend_from_slice(&encrypt_cbc_raw(&hmac, &[0u8; 16], &plaintext));

        let entries =
            import_legacy_entries_from_bytes("export.pwde", &blob, Some(password.to_string())).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Mail");
        assert_eq!(entries[0].password, "secret");
    }

    #[test]
    fn encrypted_sqt_export_wrong_password_fails() {
        let hmac = hmac_from_password("right-pass").unwrap();
        let mut plaintext = vec![0u8, 0u8];
        plaintext.extend_from_slice(SAMPLE_XML.as_bytes());
        let mut blob = b"sqt".to_vec();
        blob.extend_from_slice(&encrypt_cbc_raw(&hmac, &[0u8; 16], &plaintext));

        assert!(
            import_legacy_entries_from_bytes("export.pwde", &blob, Some("wrong-pass".to_string()))
                .is_err()
        );
    }

    #[test]
    fn imports_sqlite_password_db_v2() {
        let password = "sqlite-master-pass";
        let path = temp_path("db", "db");
        build_legacy_db(&path, password);
        let bytes = fs::read(&path).unwrap();

        let entries =
            import_legacy_entries_from_bytes("password.db", &bytes, Some(password.to_string())).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Mail");
        assert_eq!(entries[0].username, "user@example.com");
        assert_eq!(entries[0].password, "a-long-enough-password-1234567890");
        assert_eq!(entries[0].notes, "a multi word note");
        assert_eq!(entries[0].url, "https://mail.example.com");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn sqlite_import_wrong_password_is_rejected() {
        let path = temp_path("db-wrong", "db");
        build_legacy_db(&path, "the-real-pass");
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            import_legacy_entries_from_bytes("password.db", &bytes, Some("not-the-pass".to_string())),
            Err("legacy_password_incorrect".to_string())
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn sqlite_import_requires_password() {
        let path = temp_path("db-nopw", "db");
        build_legacy_db(&path, "whatever");
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            import_legacy_entries_from_bytes("password.db", &bytes, None),
            Err("legacy_password_required".to_string())
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn corrupt_file_is_rejected() {
        // Not SQLite, not "sqt", and not valid UTF-8 XML.
        assert!(import_legacy_entries_from_bytes("x.xml", &[0xff, 0xfe, 0x00, 0x01, 0x02, 0x03], None).is_err());
    }

    #[test]
    fn legacy_xml_export_round_trips() {
        let entries = vec![
            VaultEntry::imported(
                "Mail".into(),
                "user@example.com".into(),
                "p4ss".into(),
                "a note".into(),
                "https://ex.com".into(),
            ),
            // Title with characters that must be XML-attribute-escaped, and
            // empty fields that should be omitted from the output.
            VaultEntry::imported("R&D <\"tag\">".into(), String::new(), "x".into(), String::new(), String::new()),
        ];

        let xml = entries_to_legacy_xml(&entries, "3.0.0");
        let parsed = parse_xml(&xml).unwrap();

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].title, "Mail");
        assert_eq!(parsed[0].password, "p4ss");
        assert_eq!(parsed[0].notes, "a note");
        assert_eq!(parsed[0].url, "https://ex.com");
        assert_eq!(parsed[1].title, "R&D <\"tag\">");
        assert_eq!(parsed[1].password, "x");
        assert_eq!(parsed[1].username, "");
    }
}

