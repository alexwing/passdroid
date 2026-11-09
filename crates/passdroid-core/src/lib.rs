//! Passdroid vault core: pure Rust, no I/O, no platform code.
//!
//! Vault models, Argon2id + XChaCha20-Poly1305 crypto, session-free envelope
//! create/open/seal, the 3-way entry merge and the password generator. The
//! desktop app wraps it in a session (`VaultManager`); a WASM crate can wrap the
//! same functions for the browser.

pub mod crypto;
pub mod envelope;
pub mod merge;
pub mod models;
pub mod password;

pub use crypto::{
    decode_b64, default_cipher_info, default_kdf_params, derive_key, encode_b64, now_iso,
    open_payload, random_bytes, seal_payload, VAULT_MAGIC,
};
pub use envelope::{
    change_password, new_header, new_vault, new_vault_data, open_envelope, open_envelope_with_key,
    parse_envelope, reseal_envelope, seal_envelope, validate_header, validate_password,
    vault_status, NewVault, OpenedVault,
};
pub use merge::{merge_entries, visible_entries};
pub use models::{
    CipherInfo, GeneratePasswordOptions, KdfParams, VaultData, VaultEntry, VaultEnvelope,
    VaultHeader, VaultStatus,
};
pub use password::generate_password;
