// Remote vault synchronisation over FTP.
//
// The vault file is a single encrypted blob, so this layer only moves bytes:
// it downloads the remote vault (for merging) and uploads the local one. The
// FTP credentials live encrypted inside the vault itself (see SyncConfig).
//
// NOTE: plain FTP transmits the login credentials in clear text. The vault
// CONTENT is always encrypted (XChaCha20-Poly1305), but the FTP user/password
// are exposed on the wire — use a dedicated, least-privilege FTP account and
// prefer FTPS/SFTP once supported.
use std::io::Cursor;

use suppaftp::FtpStream;

use crate::models::SyncConfig;

// Best-effort guard dropped next to the vault so the remote directory is not
// served over the web if it happens to live under a web root.
const HTACCESS: &str = "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\nOptions -Indexes\n";

const DEFAULT_FILE: &str = "passdroid.pdvault";

fn remote_file(cfg: &SyncConfig) -> String {
    let file = cfg.remote_file.trim();
    if file.is_empty() {
        DEFAULT_FILE.to_string()
    } else {
        file.to_string()
    }
}

fn connect(cfg: &SyncConfig) -> Result<FtpStream, String> {
    let host = cfg.host.trim();
    if host.is_empty() {
        return Err("sync_host_required".to_string());
    }
    let addr = format!("{}:{}", host, cfg.port);
    let mut ftp = FtpStream::connect(&addr).map_err(|_| "sync_connect_failed".to_string())?;
    ftp.login(cfg.username.trim(), &cfg.password)
        .map_err(|_| "sync_auth_failed".to_string())?;
    Ok(ftp)
}

/// Change into the remote directory, creating each segment if needed.
fn enter_dir(ftp: &mut FtpStream, dir: &str) -> Result<(), String> {
    let dir = dir.trim().trim_matches('/');
    if dir.is_empty() {
        return Ok(());
    }
    for part in dir.split('/').filter(|p| !p.is_empty()) {
        if ftp.cwd(part).is_err() {
            ftp.mkdir(part).map_err(|_| "sync_mkdir_failed".to_string())?;
            ftp.cwd(part).map_err(|_| "sync_cwd_failed".to_string())?;
        }
    }
    Ok(())
}

/// Verify the credentials and that the remote directory is reachable/creatable.
pub fn test_connection(cfg: &SyncConfig) -> Result<(), String> {
    let mut ftp = connect(cfg)?;
    enter_dir(&mut ftp, &cfg.remote_dir)?;
    let _ = ftp.quit();
    Ok(())
}

/// Download the remote vault bytes, or `None` if the file does not exist yet.
pub fn download(cfg: &SyncConfig) -> Result<Option<Vec<u8>>, String> {
    let mut ftp = connect(cfg)?;
    enter_dir(&mut ftp, &cfg.remote_dir)?;
    let file = remote_file(cfg);

    let names = ftp.nlst(None).unwrap_or_default();
    let exists = names
        .iter()
        .any(|name| name.rsplit('/').next().map(str::trim) == Some(file.as_str()));

    let bytes = if exists {
        let cursor = ftp
            .retr_as_buffer(&file)
            .map_err(|_| "sync_download_failed".to_string())?;
        Some(cursor.into_inner())
    } else {
        None
    };
    let _ = ftp.quit();
    Ok(bytes)
}

/// Upload the vault bytes, dropping a deny-all `.htaccess` next to it.
pub fn upload(cfg: &SyncConfig, bytes: &[u8]) -> Result<(), String> {
    let mut ftp = connect(cfg)?;
    enter_dir(&mut ftp, &cfg.remote_dir)?;

    let mut guard = Cursor::new(HTACCESS.as_bytes());
    let _ = ftp.put_file(".htaccess", &mut guard);

    let mut reader = Cursor::new(bytes);
    ftp.put_file(remote_file(cfg), &mut reader)
        .map_err(|_| "sync_upload_failed".to_string())?;
    let _ = ftp.quit();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Optional live round-trip. Skipped unless PASSDROID_FTP_* env vars are set,
    // and only runs under `cargo test -- --ignored`. No credentials are stored here.
    fn cfg_from_env() -> Option<SyncConfig> {
        Some(SyncConfig {
            enabled: true,
            protocol: "ftp".to_string(),
            host: std::env::var("PASSDROID_FTP_HOST").ok()?,
            port: std::env::var("PASSDROID_FTP_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(21),
            username: std::env::var("PASSDROID_FTP_USER").ok()?,
            password: std::env::var("PASSDROID_FTP_PASS").ok()?,
            remote_dir: std::env::var("PASSDROID_FTP_DIR").unwrap_or_else(|_| "vault".to_string()),
            remote_file: "passdroid-synctest.bin".to_string(),
        })
    }

    #[test]
    #[ignore = "requires live FTP credentials in PASSDROID_FTP_* env vars"]
    fn ftp_round_trip() {
        let Some(cfg) = cfg_from_env() else {
            eprintln!("skipping ftp_round_trip: PASSDROID_FTP_* not set");
            return;
        };
        test_connection(&cfg).expect("connection");
        let payload = b"passdroid-sync-roundtrip-check".to_vec();
        upload(&cfg, &payload).expect("upload");
        let fetched = download(&cfg).expect("download").expect("file should exist");
        assert_eq!(fetched, payload);
    }
}
