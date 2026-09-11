# Passdroid v3.1.0

## 🚀 What's New in v3.1.0

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
- 🤖 **Android (APK)**: `Passdroid-v3.1.0-Android.apk`
- 🪟 **Windows (Setup Installer)**: `Passdroid-v3.1.0-Setup.exe`
- 🪟 **Windows (Standalone / Portable)**: `Passdroid-v3.1.0-Standalone.exe`
- 🪟 **Windows (MSI Installer)**: `Passdroid-v3.1.0.msi`
