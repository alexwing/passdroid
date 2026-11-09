//! Browser bindings over `passdroid-core` for the Phase 0 spike and the Web Workers.
//!
//! Everything returns plain strings / bytes so the JS side stays trivial.
//! Errors are the core's error codes (`master_password_incorrect`, ...): the
//! JsError message is exactly the code. Malformed JSON coming from JS is reported
//! as `vault_file_invalid`, the code the core uses for an unreadable file.

use passdroid_core::{self as core, GeneratePasswordOptions, KdfParams, VaultData, VaultEntry, VaultEnvelope, VaultHeader};
use serde::{de::DeserializeOwned, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

/// Largest integer an f64 holds exactly (2^53 - 1), the limit for revisions from JS.
const MAX_SAFE_REVISION: f64 = 9_007_199_254_740_991.0;

fn err(code: String) -> JsError {
    JsError::new(&code)
}

/// Parse JSON handed in by JS. A malformed input is an unreadable vault file.
fn parse_json<T: DeserializeOwned>(text: &str) -> Result<T, JsError> {
    serde_json::from_str(text).map_err(|_| JsError::new("vault_file_invalid"))
}

/// Copy of raw key bytes from JS, checked to be a 256-bit key and wiped on drop.
fn key_bytes(key: &[u8]) -> Result<Zeroizing<Vec<u8>>, JsError> {
    if key.len() != 32 {
        return Err(JsError::new("invalid_key"));
    }
    Ok(Zeroizing::new(key.to_vec()))
}

/// A revision from JS: an integer in `0..=2^53-1`, so the f64 is exact.
fn revision_of(value: f64) -> Result<u64, JsError> {
    if value.fract() == 0.0 && (0.0..=MAX_SAFE_REVISION).contains(&value) {
        Ok(value as u64)
    } else {
        Err(JsError::new("invalid_revision"))
    }
}

/// Argon2id with the given params, returning the 32 key bytes. For timing and
/// for byte-comparison against other implementations.
#[wasm_bindgen]
pub fn derive_key_bench(
    password: &str,
    salt_b64: &str,
    m_kib: u32,
    t: u32,
    p: u32,
) -> Result<Vec<u8>, JsError> {
    let params = KdfParams {
        algorithm: "Argon2id".to_string(),
        memory_kib: m_kib,
        iterations: t,
        parallelism: p,
        salt: salt_b64.to_string(),
        output_len: 32,
    };
    let key = core::derive_key(password, &params).map_err(err)?;
    Ok(key.to_vec())
}

/// Decrypt an envelope and return the `VaultData` as JSON.
#[wasm_bindgen]
pub fn open_vault(envelope_json: &str, password: &str) -> Result<String, JsError> {
    let opened = core::open_envelope(envelope_json, password).map_err(err)?;
    serde_json_string(&opened.data)
}

/// Decrypt and seal again with the same key and a fresh nonce (revision and
/// `updatedAt` untouched), returning the new envelope JSON.
#[wasm_bindgen]
pub fn reseal_vault(envelope_json: &str, password: &str) -> Result<String, JsError> {
    let mut opened = core::open_envelope(envelope_json, password).map_err(err)?;
    core::reseal_envelope(&mut opened.header, &opened.data, &opened.key[..]).map_err(err)
}

/// Same as `reseal_vault` but bumps the revision and `updatedAt`, like a save.
#[wasm_bindgen]
pub fn save_vault(envelope_json: &str, password: &str) -> Result<String, JsError> {
    let mut opened = core::open_envelope(envelope_json, password).map_err(err)?;
    core::seal_envelope(&mut opened.header, &mut opened.data, &opened.key[..]).map_err(err)
}

/// Header of an envelope as JSON, without deriving any key (to show KDF params).
#[wasm_bindgen]
pub fn read_header(envelope_json: &str) -> Result<String, JsError> {
    let envelope: VaultEnvelope = core::parse_envelope(envelope_json).map_err(err)?;
    serde_json_string(&envelope.header)
}

#[wasm_bindgen]
pub fn generate_password(
    length: usize,
    uppercase: bool,
    lowercase: bool,
    numbers: bool,
    symbols: bool,
) -> Result<String, JsError> {
    core::generate_password(GeneratePasswordOptions {
        length,
        uppercase,
        lowercase,
        numbers,
        symbols,
    })
    .map_err(err)
}

// ---------------------------------------------------------------------------
// Worker API: split open/seal so the key is derived once and reused, and the
// session operations run on plain JSON. Used by the Passdroid Web workers.

/// Check a KDF params JSON against the accepted bounds (`kdf_out_of_bounds`).
/// Does not derive anything.
#[wasm_bindgen(js_name = checkKdfBounds)]
pub fn check_kdf_bounds(kdf_json: &str) -> Result<(), JsError> {
    let kdf: KdfParams = parse_json(kdf_json)?;
    core::check_kdf_bounds(&kdf).map_err(err)
}

/// Argon2id key for `password` with the KDF params JSON, as 32 bytes. The bounds
/// are checked first, so out-of-range params are rejected without deriving.
#[wasm_bindgen(js_name = deriveKey)]
pub fn derive_key(password: &str, kdf_json: &str) -> Result<Vec<u8>, JsError> {
    let kdf: KdfParams = parse_json(kdf_json)?;
    core::check_kdf_bounds(&kdf).map_err(err)?;
    let key = core::derive_key(password, &kdf).map_err(err)?;
    Ok(key.to_vec())
}

/// Header of an envelope as JSON (magic, version and cipher checked), without
/// deriving any key.
#[wasm_bindgen(js_name = parseHeader)]
pub fn parse_header(envelope_json: &str) -> Result<String, JsError> {
    let envelope = core::parse_envelope(envelope_json).map_err(err)?;
    serde_json_string(&envelope.header)
}

/// Decrypt an envelope with a derived key and return the `VaultData` as JSON
/// (unknown fields kept). A wrong key is `master_password_incorrect`.
#[wasm_bindgen(js_name = openWithKey)]
pub fn open_with_key(envelope_json: &str, key: &[u8]) -> Result<String, JsError> {
    let envelope = core::parse_envelope(envelope_json).map_err(err)?;
    let key = key_bytes(key)?;
    let data = core::open_envelope_with_key(&envelope, &key).map_err(err)?;
    serde_json_string(&data)
}

/// Seal `data` with a derived key and return the envelope JSON, in the same
/// format as the desktop and Android clients. With `bump` the revision and
/// `updatedAt` advance (`seal_envelope`); without it the revision is kept
/// (`reseal_envelope`). Both write a fresh nonce.
#[wasm_bindgen(js_name = sealWithKey)]
pub fn seal_with_key(
    header_json: &str,
    data_json: &str,
    key: &[u8],
    bump: bool,
) -> Result<String, JsError> {
    let mut header: VaultHeader = parse_json(header_json)?;
    core::validate_header(&header).map_err(err)?;
    let mut data: VaultData = parse_json(data_json)?;
    let key = key_bytes(key)?;
    if bump {
        core::seal_envelope(&mut header, &mut data, &key).map_err(err)
    } else {
        core::reseal_envelope(&mut header, &data, &key).map_err(err)
    }
}

#[derive(Serialize)]
struct UpsertResult {
    data: VaultData,
    id: String,
}

/// Insert or replace an entry (`apply_upsert`, with the current time). The entry
/// JSON may omit `id`, the timestamps and `conflict`. Returns `{data, id}`.
#[wasm_bindgen(js_name = upsertEntry)]
pub fn upsert_entry(data_json: &str, entry_json: &str) -> Result<String, JsError> {
    let mut data: VaultData = parse_json(data_json)?;
    let entry: VaultEntry = parse_json(entry_json)?;
    let id = core::apply_upsert(&mut data.entries, entry, &core::now_iso()).map_err(err)?;
    serde_json_string(&UpsertResult { data, id })
}

#[derive(Serialize)]
struct DeleteResult {
    data: VaultData,
    existed: bool,
}

/// Soft-delete an entry (tombstone, `apply_delete` with the current time).
/// Returns `{data, existed}`.
#[wasm_bindgen(js_name = deleteEntry)]
pub fn delete_entry(data_json: &str, id: &str) -> Result<String, JsError> {
    let mut data: VaultData = parse_json(data_json)?;
    let existed = core::apply_delete(&mut data.entries, id, &core::now_iso());
    serde_json_string(&DeleteResult { data, existed })
}

/// 3-way merge after a conflict (`merge_session`). Inputs are the base entries
/// JSON array, the remote `VaultData` and the local `VaultData`.
#[wasm_bindgen(js_name = mergeSession)]
pub fn merge_session(
    base_entries_json: &str,
    remote_data_json: &str,
    local_data_json: &str,
    settings_dirty: bool,
) -> Result<String, JsError> {
    let base: Vec<VaultEntry> = parse_json(base_entries_json)?;
    let remote: VaultData = parse_json(remote_data_json)?;
    let local: VaultData = parse_json(local_data_json)?;
    serde_json_string(&core::merge_session(&base, &remote, &local, settings_dirty))
}

/// Rollback guard (`check_rollback`). Revisions must be integers >= 0, otherwise
/// `invalid_revision`. `max_seen_revision` is optional (`undefined` or `null`).
#[wasm_bindgen(js_name = checkRollback)]
pub fn check_rollback(
    remote_revision: f64,
    loaded_revision: f64,
    max_seen_revision: Option<f64>,
) -> Result<(), JsError> {
    let remote = revision_of(remote_revision)?;
    let loaded = revision_of(loaded_revision)?;
    let max_seen = max_seen_revision.map(revision_of).transpose()?;
    core::check_rollback(remote, loaded, max_seen).map_err(err)
}

/// Entries that are not tombstones, sorted as the UI shows them, as a JSON array.
#[wasm_bindgen(js_name = visibleEntries)]
pub fn visible_entries(data_json: &str) -> Result<String, JsError> {
    let data: VaultData = parse_json(data_json)?;
    serde_json_string(&core::visible_entries(&data.entries))
}

fn serde_json_string<T: Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|e| JsError::new(&e.to_string()))
}
