//! Browser bindings over `passdroid-core` for the Phase 0 spike.
//!
//! Everything returns plain strings / bytes so the JS side stays trivial.
//! Errors are the core's error codes (`master_password_incorrect`, ...).

use passdroid_core::{self as core, GeneratePasswordOptions, KdfParams, VaultEnvelope};
use wasm_bindgen::prelude::*;

fn err(code: String) -> JsError {
    JsError::new(&code)
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

fn serde_json_string<T: serde::Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|e| JsError::new(&e.to_string()))
}
