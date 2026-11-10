# Passdroid v3.1.9

## 🚀 What's New in v3.1.9

### 🔗 QR linking with a vault at the FTP root
- **The bug**: when the vault lived in the root folder of the FTP server (empty remote folder), the device that scanned the link QR read it as the default `vault` folder, created `/vault` on the server and did not find the file.
- The QR now sends the root as `/`, which every version (including older ones) keeps and treats as the root.
- When reading a QR, the `vault` default is only used if the folder field is missing; an empty value or `/` means the root.

---


## 📦 Prior v3.1.8 Highlights

### 📱 Phones with larger text
- The entry list no longer scrolls sideways when an entry has a long title or user name without spaces (for example a long e-mail address): it is shortened with an ellipsis.
- Tables in the notes preview keep words and values (IP addresses, user names) whole and scroll sideways inside their own box, like code blocks, instead of breaking them letter by letter.
- Checked the start, unlock, list, editor and settings screens on a 375 px phone with text at 110 %.

---


## 📦 Prior v3.1.7 Highlights

### 📋 Copy an entry without its password
- A new button in the entry header copies the entry as plain text to share with someone: title, user, URL and, at the end, the notes. The password is **never** included; the text says it is sent separately so you can paste it on its own.
- It copies what is on screen (including unsaved edits) and skips empty fields.

### 📱 Dialogs that fit on phones
- The master-password prompt after scanning a link QR no longer overflows on the right: a long "server • file" label is now shortened with an ellipsis.
- Dialog titles that come from your data (entry title when deleting, vault name when removing it from the list) wrap instead of pushing the close button out.
- Single-column forms can no longer grow wider than their dialog, whatever their content.

---


## 📦 Prior v3.1.6 Highlights

### 🔗 QR linking keeps the scanned sync settings (important)
- **The bug**: linking a device by QR downloaded the remote vault and saved it as is, so the vault on disk kept the sync settings it was uploaded with (for example plain FTP). The FTPS settings from the QR only lived in memory and were gone the next time the vault was opened.
- **The fix**: the vault is saved with the scanned settings already stored inside it, and linking now reports an error instead of silently continuing if that step fails.

### 📱 QR dialog fits on phones
- The *Link another device* dialog no longer overflows on the right on narrow phones: the QR code shrinks to fit the dialog.

### 🖥️ Settings on large screens
- On wide windows the title, tabs and settings share a single centred column instead of hugging the left edge.

---


## 📦 Prior v3.1.5 Highlights

### ⚙️ Settings inside the window
- **Settings is no longer a popup.** It opens as a view inside the vault window: on desktop it takes the place of the entry list and editor (the side rail stays visible and highlights *Settings*); on phones it fills the screen above the bottom bar, which also marks the active view.
- Locking the vault (manually or when the app goes to the background) and reopening a vault always return to *Entries* and clear the change-password form.
- *Use password* in the generator now opens the editor with the generated password.

### 📝 Roomier notes
- The notes box (both *Write* and *Preview*) now stretches down to the *Save* bar instead of having a fixed height, and the preview scrolls on its own.

---


## 📦 Prior v3.1.4 Highlights

### 💾 Android export fixed (important)
- **The bug**: in v3.1.3 on some Android builds (seen on HyperOS / Android 16) the system "save as" picker lost its result, so *Export* silently created an **empty file** and showed nothing.
- **The fix**: on Android, exports are written with MediaStore straight to **`Download/Passdroid/`** (`passdroid-copy-YYYYMMDD-HHmmss.pdvault` / `passdroid-export-….xml`), without a picker. Every export, on Android and desktop, is **read back and verified** (valid vault header or XML root) before reporting success; a failed export removes the partial file and shows an error. The toast tells you exactly where the file was saved.
- The legacy XML export now strips characters that are not valid in XML 1.0 instead of failing.

> [!IMPORTANT]
> If you exported a backup with v3.1.3 on Android, check its size: a 0-byte file is not a backup. Export again with v3.1.4.

### 🎨 New design
- **Navy & amber** palette taken from the app icon, serif headings, light / dark / system themes with AA contrast and visible focus everywhere.
- **Custom title bar on desktop** (drag, double-click to maximize, minimize / maximize / close).
- **Start screen**: available vaults first, then a single row of actions. **Unlock**: a large lock "knob" as the focal point.
- **Desktop vault**: a labelled side rail with sync status that **collapses to icons only** (remembered), entry list with avatars, editor with a fixed action bar and a password-strength meter.
- **Mobile**: bottom bar, floating "new entry" button, full-screen editor whose header sits below the status bar, toasts that never block taps, settings tabs that stay in place.

### 📝 Markdown in notes
- *Write* / *Preview* toggle in the notes field (GFM: tables, task lists, code), and the chosen view becomes the default for every entry.
- Safe rendering: no HTML execution, only http/https/mailto links opened outside the app (with the real host shown for deceptive links), no remote image loading, and protection against pathological inputs.

### 🛡️ Other fixes
- Deleting an entry now asks for confirmation.
- Settings dialog tabs no longer collapse or jump on phones; the unlock button stays visible with the keyboard open.

---

## 📦 Prior v3.1.3 Highlights

### 🔒 FTPS Sync with Certificate Validation
- **Encrypted transport**: sync now supports explicit FTPS (AUTH TLS on port 21) using `rustls` (no OpenSSL on Android). The server certificate is validated against the public Mozilla roots **and the configured host name**, and the data channel is encrypted as well (`PROT P`). There is no "accept any certificate" mode.
- **Protocol selector**: Settings → *Sync* offers **FTPS (recommended)** or **FTP (unencrypted)**. New configs and new QR links default to FTPS. Existing configs keep their current protocol until you switch them, so legacy servers without TLS keep working.
- **Clear errors**: TLS/certificate problems now report a dedicated error instead of a generic connection failure. Connect by host name: an IP address will not match the certificate.

### 🛡️ Safer Sync Writes
- **Atomic uploads**: the vault is uploaded to a temporary `.<file>.<random>.part`, its size is verified, and only then is it renamed over the remote vault. A broken or truncated transfer can no longer replace a good vault.
- **No blind overwrites**: removed the old directory-listing check that treated *any* listing error as "no remote vault". Now only a definite "file not found" (550) means there is no remote copy; any other server error aborts the sync instead of uploading over a newer remote. The same rule applies when entering the remote folder.
- **No more hangs**: existence is checked on the control channel before any transfer, and all FTP sockets have timeouts (15 s connect, 30 s I/O). Previously, over FTPS, a sync against a missing remote file could freeze until the server's idle timeout.
- **Binary mode**: transfers now explicitly use `TYPE I`, so no server can apply ASCII conversions to the vault.

### 📲 QR Linking
- QR links carry the sync protocol, so an FTPS setup links as FTPS.
- Fixed QR generation failing silently when the FTP password (or any field) contains characters outside Latin-1 (e.g. `€` or emoji). Older QR codes still scan.
- As before, the QR includes the FTP login (by design) but **never** the master password: treat the QR as a secret.

> [!IMPORTANT]
> **Update every device before enforcing TLS on your server.** Builds before v3.1.3 ignore the protocol field and always use plain FTP, so they will fail to sync once the server requires TLS. After updating, switch each device to **FTPS** in Settings → *Sync* and re-generate the QR. Updating from v3.1.2 installs directly over it.

---

## 📦 Prior v3.1.2 Highlights

### 🔑 Official Android Keystore & Seamless APK Updates
- **Permanent Release Certificate Signing**: Configured CI release pipeline with the official Passdroid release keystore (`passdroid-release.jks`). Prevents certificate mismatch (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) so future Android updates install directly over existing versions without having to uninstall.
- **Strict Keystore Integrity Verification**: CI build automatically validates keystore and alias certificates during the build process, failing fast if credentials are not present or corrupted.

> [!NOTE]
> If you previously installed the v3.1.0 or v3.1.1 APKs (which had temporary runner keys generated during the transition to GitHub Actions), please uninstall that interim build once before installing v3.1.2. If you are updating from v3.0.0 or any local release build, v3.1.2 installs directly over it. All future updates from v3.1.2 onward will update smoothly without losing data.

---

## 📦 Prior v3.1.1 Highlights

### 📸 Camera & Android Permissions Fix
- **Android Camera Permissions**: Added `android.permission.CAMERA` to `AndroidManifest.xml` so Android properly prompts the user for camera access when opening the QR code scanner.
- **Haptic Feedback & Media Access**: Added `android.permission.VIBRATE` for scanner vibration on scan success, as well as `READ_MEDIA_IMAGES` / `READ_EXTERNAL_STORAGE` for QR image file uploads.
- **Hardware Feature Flags**: Added `android.hardware.camera` and `android.hardware.camera.autofocus` with `android:required="false"` to ensure full compatibility across all Android devices and form factors.

---

## 📦 Prior v3.1.0 Highlights

### 🌐 Full Internationalization (i18n Context)
- **English & Spanish**: Automatic OS system language detection with in-app switcher (`🌐 System`, `🇪🇸 Español`, `🇬🇧 English`).
- **Dynamic Translation Engine**: Powered by `LanguageProvider` with `{{variable}}` string interpolation support.
- **Strict Key Parity**: 100% test and type coverage with zero missing keys guaranteed by TypeScript.

### 🌓 Theme Switching (ThemeContext)
- **Real-time OS Synchronization**: Dynamically follows system light/dark mode preference changes.
- **Appearance Selector**: Easily switch between `💻 System`, `☀️ Light`, and `🌙 Dark` modes with persistent preference storage.
- **Consistent Design System**: Full CSS variables integration across all panels, dialogs, cards, and modal windows.

### 📲 QR Code Vault Linking (Zero-Knowledge)
- **Zero-Knowledge Security**: Master passwords are **never** included in QR codes. The QR payload only contains FTP server sync configuration (`pdvault://`).
- **QR Code Generator**: Share sync setup across devices from the Sync settings tab, complete with security notices and a one-click copy button.
- **Native Camera Scanner**: Futuristic animated viewfinder with corner targeting, camera switcher (front/rear), and haptic feedback.
- **Resilient Fallbacks**: Direct support for uploading QR image files and decoding QR codes directly from the system clipboard.
- **One-Click Start Screen Link**: Connect to FTP, fetch the vault, verify the master password, and open the vault seamlessly from the welcome screen.

### 🎛️ Tabbed Settings Dialog
- **General Tab**: Appearance (themes), language selector, and custom vault icon picker.
- **Sync Tab**: FTP server parameters, connection testing, manual sync trigger, and QR device linking.
- **Security Tab**: Dedicated master password change form.

### ⚙️ Backend & Distribution Improvements
- New Rust Tauri command `download_ftp_vault` for cold remote vault retrieval.
- Updated Content Security Policy (CSP) for secure camera streaming and base64 QR rendering in production builds.
- Automated multiplatform GitHub Actions pipeline.

---

### 📦 Available Downloads:
- 🤖 **Android (APK)**: `Passdroid-v3.1.4-Android.apk`
- 🪟 **Windows (Setup Installer)**: `Passdroid-v3.1.4-Setup.exe`
- 🪟 **Windows (Standalone / Portable)**: `Passdroid-v3.1.4-Standalone.exe`
- 🪟 **Windows (MSI Installer)**: `Passdroid-v3.1.4.msi`
