# Golden vector fixtures (TEST ONLY)

Vault files sealed by the Passdroid Next code **before** the `passdroid-core`
extraction (Phase 0). They prove that the extracted core, and its WASM build,
open real-format desktop and Android vaults and produce the same data.

**Everything here is test data.** None of it is a real vault, password or
credential. Do not reuse the password or the sync settings anywhere.

## Contents

| File | What it is |
| --- | --- |
| `desktop-64mib.pdvault` | Vault sealed with the desktop KDF params |
| `android-32mib.pdvault` | Same VaultData sealed with the Android KDF params |
| `expected-desktop.json` | Decrypted `VaultData` JSON of the desktop fixture |
| `expected-android.json` | Decrypted `VaultData` JSON of the Android fixture |

- Master password: `phase0-golden-vectors`
- KDF (both): Argon2id, t=3, p=1, output 32 bytes, 16-byte random salt
  - desktop: m = 65536 KiB (64 MiB)
  - android: m = 32768 KiB (32 MiB)
- Cipher: XChaCha20-Poly1305, 24-byte nonce, header authenticated as AAD
- Magic `passdroid-vault-v1`, version 1

Vault data (identical in both files): 3 entries (one with unicode/emoji in title
and notes, one with URL and username, one minimal), `settings.icon = "shield"`
and a dummy `settings.sync` (protocol `ftps`, host `ftp.example.invalid`, user
`fixture`, password `fixture-password`).

## How they were generated

`src-tauri/src/golden_tests.rs`, ignored test `generate_golden_fixtures`:

- Desktop: real `VaultManager` path: `create` -> 3x `upsert` -> `set_vault_icon`
  -> `set_sync_config`; the last snapshot's `contents` is the file.
- Android: `default_kdf_params()` only selects 32 MiB under
  `cfg!(target_os = "android")`, so the test builds the Android `KdfParams`
  explicitly and seals the desktop vault's `VaultData` with `derive_key` +
  `seal_payload` using the same header layout as `seal_envelope`. Production
  code is untouched. The Android vault has its own vaultId and salt.
- `expected-*.json`: `VaultData` decrypted from each fixture, pretty-printed.

```
cd src-tauri
cargo test generate_golden_fixtures -- --ignored --nocapture   # regenerate
cargo test golden_tests                                        # verify
```

Regenerating produces new salts, nonces, ids and timestamps. Only do it when the
format changes on purpose; otherwise keep the committed files, since other
implementations (the WASM core) are checked against them.

The non-ignored tests (`desktop_fixture_opens_and_round_trips`,
`android_fixture_opens_and_round_trips`) assert the decrypted data equals the
expected JSON, a wrong password is rejected, and reseal + reopen round-trips.
