<p align="center">
  <img src="src-tauri/icons/passdroid.png" alt="Passdroid Next" width="160" height="160" />
</p>

# Passdroid Next

Gestor de contraseñas y notas Markdown con bóveda cifrada, para escritorio (Windows, macOS y Linux) y Android desde un mismo código. Está hecho con **Tauri 2, React y Rust**.

Es la sucesora de la app Android original [Passdroid](https://github.com/mangefoo/passdroid). Este repositorio conserva su historial de git como punto de partida, pero la aplicación es nueva.

Los secretos nunca van a una base de datos ni a un fichero en claro. La bóveda es un único fichero cifrado `.pdvault`. En escritorio puedes guardarlo donde quieras, incluida una carpeta sincronizada (Google Drive, Dropbox, OneDrive, Syncthing, Nextcloud o una carpeta compartida). En Android vive en el almacenamiento privado de la app y se sincroniza entre dispositivos por FTPS.

## Características

- **Entradas**: título, usuario, contraseña, URL y notas, con búsqueda instantánea. Borrar una entrada pide confirmación.
- **Notas en Markdown**: el campo de notas alterna entre *Escribir* y *Vista previa* (tablas, listas de tareas, código) y recuerda la vista elegida. El HTML se muestra como texto y los enlaces solo admiten http, https y mailto; se abren en el navegador del sistema y muestran el host real si el texto del enlace es distinto. Nunca se cargan imágenes remotas.
- **Copiar entrada sin la contraseña**: copia como texto plano el título, el usuario, la URL y las notas para pasárselos a alguien. La contraseña nunca se incluye; el texto indica que se envía por separado.
- **Sincronización por FTPS**: opcional y con validación del certificado. Al abrir, si la copia del servidor es más reciente, ofrece descargarla y fusionarla. Tras cada cambio sube el resultado de forma atómica.
- **Vinculación por QR**: un código `pdvault://` lleva la configuración de sincronización a otro móvil o equipo. Se puede leer con la cámara, desde una imagen o desde el portapapeles. La contraseña maestra **nunca** va en el QR.
- **Generador de contraseñas**: longitud y mayúsculas, minúsculas, números y símbolos.
- **Icono por bóveda**: se guarda dentro de la bóveda, así que se sincroniza, y aparece en las pantallas de inicio, desbloqueo y bóveda.
- **Bóvedas recientes**: se reabren desde la pantalla de inicio.
- **Importación** desde la app Passdroid original: XML en claro, exportación cifrada `sqt` o base de datos SQLite `password.db`.
- **Exportación**: copia cifrada `.pdvault` o XML compatible con la app antigua (sin cifrar). En Android se guarda en `Download/Passdroid/`. Cada exportación se relee y se comprueba antes de darla por buena.
- **Protección en Android**: bloqueo de capturas y grabación de pantalla (`FLAG_SECURE`), miniatura en blanco en las apps recientes y bloqueo de la bóveda al pasar a segundo plano.
- **Ajustes** en pestañas: *General* (apariencia, idioma, icono), *Sincronización* (servidor, prueba, sincronización manual y QR) y *Seguridad* (cambio de contraseña maestra).
- **Interfaz**: diseño azul marino y ámbar con tema claro, oscuro o del sistema; barra de título propia en escritorio, raíl lateral plegable, barra inferior con botón flotante en móvil, y español e inglés con detección automática.

Hay también un cliente web, Passdroid Web (repositorio aparte), que se aloja en un servidor propio y abre la misma bóveda.

## Descargas

Las versiones para cada plataforma están en [GitHub Releases](https://github.com/alexwing/passdroid/releases):

| Plataforma | Paquete |
|---|---|
| Android | APK firmado (`.apk`), Android 7.0 o superior (API 24+) |
| Windows | Instalador (`Setup.exe`, NSIS) |
| Windows | Ejecutable portátil (`Standalone.exe`), sin instalación |
| Windows | Instalador MSI (`.msi`) |

## Cómo funciona

```
Escritorio / Android (Tauri)                     Servidor FTPS
┌──────────────────────────────┐                 ┌─────────────────────┐
│ React (interfaz)             │                 │ carpeta de bóvedas  │
│        │ comandos Tauri      │   FTPS (TLS)    │  passdroid.pdvault  │
│ Rust:                        │ ──────────────► │  .htaccess (deny)   │
│  · Argon2id (derivar clave)  │  bytes cifrados │                     │
│  · XChaCha20-Poly1305        │ ◄────────────── │                     │
│  · fusión por id/updated_at  │                 └─────────────────────┘
│ Texto claro solo en memoria  │
└──────────────┬───────────────┘
               │ disco
        fichero .pdvault
```

- **Cifrado en Rust.** La interfaz React pide las operaciones al backend por comandos de Tauri. La clave se deriva con Argon2id y el contenido se cifra con XChaCha20-Poly1305.
- **Un único fichero.** La bóveda se sincroniza como un bloque cifrado. Al sincronizar se descifran las dos revisiones y se fusionan entrada a entrada.
- **Configuración dentro de la bóveda.** Los datos de conexión al servidor (host, puerto, usuario, contraseña, carpeta y fichero) se guardan cifrados dentro de la bóveda, protegidos por la contraseña maestra.

### Formato de la bóveda (`passdroid-vault-v1`)

```jsonc
{
  "header": {            // visible, autenticada como AAD
    "magic": "passdroid-vault-v1",
    "version": 1,
    "vaultId": "...",
    "kdf": { "algorithm": "Argon2id", "memoryKib": 65536, "iterations": 3, ... },
    "cipher": { "algorithm": "XChaCha20-Poly1305" },
    "nonce": "<base64>",
    "createdAt": "...", "updatedAt": "..."
  },
  "payload": "<base64>"  // cifra { entries, revision, deviceId, settings }
}
```

## Seguridad

- **Derivación de clave.** Argon2id (RFC 9106) con 64 MiB de memoria, 3 iteraciones, paralelismo 1, sal aleatoria de 16 bytes y clave de 32 bytes. En Android se usan 32 MiB. Los parámetros van en la cabecera de cada bóveda, así que se abre en cualquier dispositivo, se creara donde se creara.
- **Cifrado.** XChaCha20-Poly1305 (AEAD). La cabecera JSON visible se autentica como dato asociado (AAD), así que cualquier manipulación se detecta.
- **Memoria.** Las claves derivadas van envueltas en `zeroize` y se borran al bloquear.
- **Conflictos.** Si la misma entrada cambió en dos sitios, se crea un duplicado marcado como conflicto en lugar de perder datos.
- **Sincronización.**
  - FTPS por defecto: TLS explícito en el puerto 21 con `rustls`. El certificado se valida contra las raíces públicas y el nombre del host, y el canal de datos también va cifrado (`PROT P`). Conecta por nombre de host, no por IP.
  - FTP sin cifrar solo como opción heredada, marcada como insegura.
  - Las subidas van a un temporal `.<fichero>.<aleatorio>.part`, se comprueba su tamaño y solo después se renombra sobre la bóveda.
  - Solo un «fichero no encontrado» (550) cuenta como que no hay bóveda remota. Cualquier otro error detiene la sincronización en lugar de sobrescribir una copia más reciente.
  - Junto a la bóveda se deja un `.htaccess` que deniega todo, para que la carpeta nunca se sirva por web.
  - Las conexiones caducan (15 s al conectar, 30 s de E/S) en vez de quedarse colgadas.
- **QR.** No incluye la contraseña maestra, pero sí el usuario y la contraseña del FTP. Trátalo como un secreto y enséñalo solo a tus dispositivos.
- **Android.** `FLAG_SECURE`, bloqueo automático al pasar a segundo plano y bóveda en el almacenamiento privado de la app.

> Usa una **cuenta FTP dedicada y con los mínimos permisos** y, en tu servidor, obliga a usar TLS (por ejemplo, en vsftpd, `force_local_logins_ssl=YES` y `force_local_data_ssl=YES`).

## Sincronización

- **FTPS integrado** (Ajustes → *Sincronización*). Al abrir una bóveda, si la del servidor es más reciente, la app ofrece descargarla y fusionarla. Tras cada cambio sube el resultado fusionado.
- **Vincular otro dispositivo** (Ajustes → *Sincronización* → *Vincular otro dispositivo*). Genera el QR. En el otro equipo, pulsa **Vincular mediante QR** en la pantalla de inicio, léelo y escribe la contraseña maestra: la app descarga la bóveda, la desbloquea y guarda la configuración del QR. Si la bóveda está en la raíz del FTP, el QR envía la carpeta como `/`.
- **En Android** la bóveda vive en el almacenamiento privado de la app. Android revoca los permisos del selector de ficheros al reiniciar, así que un fichero elegido en Documentos o Drive no se podría reabrir de forma fiable. *Importar vault* copia una vez el fichero elegido y a partir de ahí el FTP mantiene sincronizados los dispositivos. Usa *Exportar* si quieres una copia en Documentos.
- **En escritorio** puedes prescindir del FTP y guardar el `.pdvault` en una carpeta sincronizada con [Syncthing](https://syncthing.net/), Dropbox, OneDrive, Nextcloud, etc.

## Migración desde Passdroid

Ajustes → **Importar Passdroid** lee una exportación o base de datos antigua, la descifra en memoria con la contraseña antigua, muestra una vista previa y añade las entradas a la bóveda actual. Admite:

- Exportaciones en claro `passdroid_db.xml`
- Exportaciones cifradas (formato AES-CBC con la marca `sqt`)
- Bases de datos SQLite `password.db` (Passdroid 2.x, tablas `system` y `data`)

La criptografía antigua vive solo en `src-tauri/src/legacy.rs` y nunca se usa para crear datos nuevos.

## Estructura del repositorio

| Carpeta | Contenido |
|---|---|
| `src/` | Interfaz React y TypeScript: `App.tsx`, componentes, traducciones (`i18n/`) y estilos |
| `src/dev/` | Sustitutos de las APIs de Tauri para la vista previa en el navegador (`npm run dev:preview`) |
| `src-tauri/src/` | Backend Rust: cifrado (`crypto.rs`), bóveda y fusión (`vault.rs`), sincronización (`sync.rs`), exportación, preferencias e importación antigua (`legacy.rs`) |
| `src-tauri/gen/android/` | Proyecto Gradle de Android generado por Tauri |
| `.github/workflows/` | Compilación y publicación de versiones al crear una etiqueta `v*` |
| `docs/design/` | Propuesta de diseño y maqueta |

## Requisitos

- [Rust](https://www.rust-lang.org/tools/install) estable y Cargo
- [Node.js](https://nodejs.org/) 20 o superior y npm
- Las dependencias de sistema de Tauri: [requisitos de Tauri](https://v2.tauri.app/start/prerequisites/)
- Para Android: Android SDK y NDK, con `ANDROID_HOME` y `NDK_HOME` definidos (SDK mínimo 24)

## Desarrollo

```bash
npm install
npm run tauri:dev      # escritorio con recarga en caliente
npm run tauri:build    # paquete de escritorio
```

`npm run dev` y `npm run build` solo arrancan o compilan la interfaz web (Vite en el puerto 1420). `npm run dev:preview` la abre en el navegador con las APIs de Tauri simuladas, útil para revisar la interfaz sin compilar la app.

### Android

El proyecto Gradle está en `src-tauri/gen/android`.

```bash
npm run tauri:android:init    # una sola vez; regenera src-tauri/gen/android
npm run tauri:android:dev     # en un dispositivo o emulador
npm run tauri:android:build   # APK/AAB
```

El árbol `gen/android` está en el repositorio, así que un clon limpio compila sin ejecutar `init`. Solo se ignoran las salidas de compilación (`build/`, `.gradle/` y las `*.so` nativas). Vuelve a ejecutar `init` solo al actualizar la plantilla Android de Tauri.

### Tests y comprobaciones

En `src-tauri/`:

```bash
cargo test                   # cifrado, KDF, ciclo de vida de la bóveda, fusión y conflictos, importación antigua
cargo clippy --all-targets
```

En la raíz:

```bash
npm run build                # comprueba los tipos (tsc) y compila la interfaz
```

## Publicar una versión

1. Sube la versión en `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` y `src-tauri/Cargo.lock`.
2. Añade la sección de la versión al principio de [RELEASE_NOTES.md](RELEASE_NOTES.md).
3. Crea la etiqueta `vX.Y.Z` y súbela. El flujo de GitHub Actions compila Windows y Android y publica la versión en Releases.

## Licencia

GPL-3.0-or-later ([LICENSE.TXT](LICENSE.TXT)).

El código de migración de `src-tauri/src/legacy.rs` reimplementa el cifrado en disco de la app Passdroid original (Copyright © 2009–2012 Magnus Eriksson), reutilizado bajo GPLv3. La estructura de Tauri se inspira en el proyecto de referencia Syncdrome (MIT), sin copiar su código.
