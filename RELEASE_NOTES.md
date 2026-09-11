## Passdroid v3.1.0

### 🚀 Novedades y Mejoras / What's New:

#### 🌐 Soporte Multiidioma Completo (i18n Context)
- **Español e Inglés**: Detección automática del idioma del sistema con selector en Ajustes (`🌐 Sistema`, `🇪🇸 Español`, `🇬🇧 English`).
- **Motor de traducción dinámico**: Nueva arquitectura con `LanguageProvider` e interpolación de variables (`{{var}}`).
- **Paridad estricta**: 100% de cobertura y 0 claves faltantes garantizadas por TypeScript.

#### 🌓 Soporte de Tema Claro, Oscuro y Sistema (ThemeContext)
- **Sincronización en tiempo real**: Detección automática del tema del sistema operativo con escucha reactiva a cambios.
- **Selector de apariencia**: Opciones `💻 Sistema`, `☀️ Claro` y `🌙 Oscuro` con persistencia en preferencias nativas.
- **Diseño unificado**: Plena integración con las variables CSS del sistema en paneles, tarjetas, listas y modales.

#### 📲 Vinculación de Bóvedas por Código QR (Zero-Knowledge)
- **Seguridad Zero-Knowledge**: La contraseña maestra de la bóveda **nunca** viaja en el QR; el código contiene únicamente la configuración FTP (`pdvault://`).
- **Generador de QR**: Tarjeta para compartir configuración con otro dispositivo, visor QR con notas de seguridad y botón de copia al portapapeles.
- **Escáner de cámara nativo**: Visor moderno con retícula animada, alternancia entre cámara frontal/trasera y vibración háptica al escanear.
- **Alternativas resilientes**: Botones para subir imagen/foto del QR y para decodificar códigos copiados en el portapapeles.
- **Flujo de vinculación en inicio**: Botón en pantalla de bienvenida que conecta al FTP, descarga la bóveda, verifica la clave maestra y la abre directamente.

#### 🎛️ Ventana de Ajustes Organizada por Pestañas
- **Pestaña General**: Configuración de tema, idioma e icono de la bóveda.
- **Pestaña Sincronización**: Parámetros del servidor FTP, pruebas de conexión, sincronización manual y vinculación por QR.
- **Pestaña Seguridad**: Formulario dedicado para el cambio de contraseña maestra.

#### ⚙️ Mejoras de Backend y Despliegue
- Nuevo comando en Rust `download_ftp_vault` para descarga directa de bóvedas remotas sin sesión previa.
- Directivas CSP actualizadas para permitir transmisiones multimedia seguras y renderizado de imágenes Base64.
- Flujo automatizado en GitHub Actions para Android (APK firmado) y Windows (Setup, Portable y MSI).

---

### 📦 Binarios disponibles / Available Downloads:
- 🤖 **Android (APK)**: `Passdroid-v3.1.0-Android.apk`
- 🪟 **Windows (Instalador Setup)**: `Passdroid-v3.1.0-Setup.exe`
- 🪟 **Windows (Standalone / Portable)**: `Passdroid-v3.1.0-Standalone.exe`
- 🪟 **Windows (MSI)**: `Passdroid-v3.1.0.msi`
