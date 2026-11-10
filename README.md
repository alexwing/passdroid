<p align="center">
  <img src="src-tauri/icons/passdroid.png" alt="Passdroid Next" width="160" height="160" />
</p>

# Passdroid Next

A password manager with an encrypted vault and Markdown notes, for desktop (Windows, macOS and Linux) and Android from a single codebase. Built with **Tauri 2, React and Rust**.

It is the successor to the original [Passdroid](https://github.com/mangefoo/passdroid) Android app. This repository keeps that app's git history as its starting point, but the application is new.

Secrets never go into a database or a plaintext file. The vault is a single encrypted `.pdvault` file. On desktop you can keep it wherever you like, including a synced folder (Google Drive, Dropbox, OneDrive, Syncthing, Nextcloud or a network share). On Android it lives in the app's private storage and syncs across devices over FTPS.

## Features

- **Entries**: title, username, password, URL and notes, with instant search. Deleting an entry asks for confirmation.
- **Markdown notes**: the notes field switches between *Write* and *Preview* (tables, task lists, code) and remembers the chosen view. HTML is shown as text and links only allow http, https and mailto; they open in the system browser and show the real host when the link text differs. Remote images are never loaded.
- **Copy an entry without its password**: copies the title, username, URL and notes as plain text to share with someone. The password is never included; the text says it is sent separately.
- **FTPS sync**: optional, with certificate validation. On open, if the server copy is newer, the app offers to download and merge it. After each change it uploads the result atomically.
- **QR linking**: a `pdvault://` code carries the sync settings to another phone or computer. It can be read with the camera, from an image or from the clipboard. The master password is **never** in the QR.
- **Password generator**: length plus upper case, lower case, numbers and symbols.
- **Per-vault icon**: stored inside the vault, so it syncs, and shown on the start, unlock and vault screens.
- **Recent vaults**: reopen them from the start screen.
- **Import** from the original Passdroid app: cleartext XML, encrypted `sqt` export or a `password.db` SQLite database.
- **Export**: an encrypted `.pdvault` copy or legacy-compatible XML (unencrypted). On Android it is saved to `Download/Passdroid/`. Every export is read back and checked before it is reported as done.
- **Android protection**: screenshots and screen recording are blocked (`FLAG_SECURE`), the recent-apps thumbnail is blanked, and the vault locks when the app goes to the background.
- **Tabbed settings**: *General* (appearance, language, icon), *Sync* (server, connection test, manual sync and QR) and *Security* (master password change).
- **Interface**: navy and amber design with light, dark or system theme; a custom title bar on desktop, a collapsible side rail, a bottom bar with a floating action button on mobile, and English and Spanish with automatic detection.

There is also a web client, Passdroid Web (separate repository), which runs on your own server and opens the same vault.

## Downloads

Builds for each platform are on [GitHub Releases](https://github.com/alexwing/passdroid/releases):

| Platform | Package |
|---|---|
| Android | Signed APK (`.apk`), Android 7.0 or later (API 24+) |
| Windows | Installer (`Setup.exe`, NSIS) |
| Windows | Portable executable (`Standalone.exe`), no installation |
| Windows | MSI installer (`.msi`) |

## How it works

```
Desktop / Android (Tauri)                        FTPS server
┌──────────────────────────────┐                 ┌─────────────────────┐
│ React (interface)            │                 │ vault folder        │
│        │ Tauri commands      │   FTPS (TLS)    │  passdroid.pdvault  │
│ Rust:                        │ ──────────────► │  .htaccess (deny)   │
│  · Argon2id (key derivation) │ encrypted bytes │                     │
│  · XChaCha20-Poly1305        │ ◄────────────── │                     │
│  · merge by id/updated_at    │                 └─────────────────────┘
│ Plaintext only in memory     │
└──────────────┬───────────────┘
               │ disk
          .pdvault file
```

- **Encryption in Rust.** The React interface asks the backend for every operation through Tauri commands. The key is derived with Argon2id and the content is encrypted with XChaCha20-Poly1305.
- **A single file.** The vault syncs as one encrypted blob. When syncing, both revisions are decrypted and merged entry by entry.
- **Settings inside the vault.** The server connection details (host, port, username, password, folder and file) are stored encrypted inside the vault, protected by the master password.

### Vault format (`passdroid-vault-v1`)

```jsonc
{
  "header": {            // visible, authenticated as AAD
    "magic": "passdroid-vault-v1",
    "version": 1,
    "vaultId": "...",
    "kdf": { "algorithm": "Argon2id", "memoryKib": 65536, "iterations": 3, ... },
    "cipher": { "algorithm": "XChaCha20-Poly1305" },
    "nonce": "<base64>",
    "createdAt": "...", "updatedAt": "..."
  },
  "payload": "<base64>"  // encrypts { entries, revision, deviceId, settings }
}
```

## Security

- **Key derivation.** Argon2id (RFC 9106) with 64 MiB of memory, 3 iterations, parallelism 1, a random 16-byte salt and a 32-byte key. Android uses 32 MiB. The parameters are stored in each vault's header, so a vault opens on any device wherever it was created.
- **Encryption.** XChaCha20-Poly1305 (AEAD). The visible JSON header is authenticated as associated data (AAD), so any tampering is detected.
- **Memory.** Derived keys are wrapped in `zeroize` and wiped on lock.
- **Conflicts.** If the same entry changed in two places, a duplicate marked as a conflict is created instead of losing data.
- **Sync.**
  - FTPS by default: explicit TLS on port 21 with `rustls`. The certificate is validated against the public roots and the host name, and the data channel is encrypted too (`PROT P`). Connect by host name, not by IP.
  - Plain FTP only as a legacy option, flagged as insecure.
  - Uploads go to a temporary `.<file>.<random>.part`, its size is checked, and only then is it renamed over the vault.
  - Only a definite "file not found" (550) counts as no remote vault. Any other error stops the sync instead of overwriting a newer copy.
  - A deny-all `.htaccess` is placed next to the vault so the folder is never served over the web.
  - Connections time out (15 s to connect, 30 s for I/O) instead of hanging.
- **QR.** It does not include the master password, but it does include the FTP username and password. Treat it as a secret and show it only to your own devices.
- **Android.** `FLAG_SECURE`, automatic lock in the background and the vault in the app's private storage.

> Use a **dedicated, least-privilege FTP account** and, on your server, enforce TLS (for example, in vsftpd, `force_local_logins_ssl=YES` and `force_local_data_ssl=YES`).

## Sync

- **Built-in FTPS** (Settings → *Sync*). When you open a vault and the server copy is newer, the app offers to download and merge it. After every change it uploads the merged result.
- **Link another device** (Settings → *Sync* → *Link another device*). Generates the QR. On the other device, tap **Link via QR** on the start screen, scan it and enter the master password: the app downloads the vault, unlocks it and saves the settings from the QR. If the vault is at the root of the FTP server, the QR sends the folder as `/`.
- **On Android** the vault lives in the app's private storage. Android revokes file-picker permissions on restart, so a file picked in Documents or Drive could not be reopened reliably. *Import vault* copies the picked file in once, and from then on FTP keeps the devices in sync. Use *Export* if you want a copy in Documents.
- **On desktop** you can skip FTP and keep the `.pdvault` in a folder synced with [Syncthing](https://syncthing.net/), Dropbox, OneDrive, Nextcloud, etc.

## Migrating from Passdroid

Settings → **Import Passdroid** reads an old export or database, decrypts it in memory with the old password, shows a preview and adds the entries to the current vault. Supported sources:

- Cleartext `passdroid_db.xml` exports
- Encrypted exports (the AES-CBC format with the `sqt` magic)
- `password.db` SQLite databases (Passdroid 2.x, `system` and `data` tables)

The legacy crypto lives only in `src-tauri/src/legacy.rs` and is never used to create new data.

## Repository layout

| Folder | Contents |
|---|---|
| `src/` | React and TypeScript interface: `App.tsx`, components, translations (`i18n/`) and styles |
| `src/dev/` | Stand-ins for the Tauri APIs used by the in-browser preview (`npm run dev:preview`) |
| `src-tauri/src/` | Rust backend: encryption (`crypto.rs`), vault and merge (`vault.rs`), sync (`sync.rs`), export, preferences and legacy import (`legacy.rs`) |
| `src-tauri/gen/android/` | Android Gradle project generated by Tauri |
| `.github/workflows/` | Builds and publishes releases when a `v*` tag is pushed |
| `docs/design/` | Design proposal and mockup |

## Requirements

- [Rust](https://www.rust-lang.org/tools/install) stable and Cargo
- [Node.js](https://nodejs.org/) 20 or later and npm
- Tauri's system dependencies: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- For Android: Android SDK and NDK, with `ANDROID_HOME` and `NDK_HOME` set (minimum SDK 24)

## Development

```bash
npm install
npm run tauri:dev      # desktop with hot reload
npm run tauri:build    # desktop bundle
```

`npm run dev` and `npm run build` only run or build the web interface (Vite on port 1420). `npm run dev:preview` opens it in the browser with the Tauri APIs mocked, which is handy for reviewing the interface without building the app.

### Android

The Gradle project is in `src-tauri/gen/android`.

```bash
npm run tauri:android:init    # once; regenerates src-tauri/gen/android
npm run tauri:android:dev     # on a device or emulator
npm run tauri:android:build   # APK/AAB
```

The `gen/android` tree is committed, so a clean checkout builds without running `init`. Only build outputs (`build/`, `.gradle/` and native `*.so` files) are ignored. Re-run `init` only when updating Tauri's Android template.

### Tests and checks

In `src-tauri/`:

```bash
cargo test                   # crypto, KDF, vault lifecycle, merge and conflicts, legacy import
cargo clippy --all-targets
```

At the root:

```bash
npm run build                # type-checks (tsc) and builds the interface
```

## Releasing a version

1. Bump the version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`.
2. Add the version's section at the top of [RELEASE_NOTES.md](RELEASE_NOTES.md).
3. Create the `vX.Y.Z` tag and push it. The GitHub Actions workflow builds Windows and Android and publishes the release.

## License

GPL-3.0-or-later ([LICENSE.TXT](LICENSE.TXT)).

The migration code in `src-tauri/src/legacy.rs` reimplements the on-disk crypto of the original Passdroid app (Copyright © 2009–2012 Magnus Eriksson), reused under GPLv3. The Tauri structure is inspired by the Syncdrome reference project (MIT), without copying its code.
