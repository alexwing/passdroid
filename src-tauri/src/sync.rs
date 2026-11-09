// Remote vault synchronisation over FTP / explicit FTPS.
//
// The vault file is a single encrypted blob, so this layer only moves bytes:
// it downloads the remote vault (for merging) and uploads the local one. The
// FTP credentials live encrypted inside the vault itself (see SyncConfig).
//
// "ftps" (explicit FTPS, AUTH TLS) validates the server certificate against the
// Mozilla roots and the configured host name, and protects the data channel
// too (PBSZ 0 / PROT P, done by suppaftp's `into_secure`). The TLS stack is
// rustls with the `ring` provider, so Android does not need OpenSSL.
//
// NOTE: legacy "ftp" is plain FTP and transmits the login credentials in clear
// text. The vault CONTENT is always encrypted (XChaCha20-Poly1305), but the FTP
// user/password are exposed on the wire — prefer "ftps".
use std::io::Cursor;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use rand_core::{OsRng, RngCore};
use suppaftp::rustls::{self, ClientConfig, RootCertStore};
use suppaftp::types::FileType;
use suppaftp::{FtpError, FtpResult, FtpStream, RustlsConnector, RustlsFtpStream, Status};

use crate::models::SyncConfig;

// Best-effort guard dropped next to the vault so the remote directory is not
// served over the web if it happens to live under a web root.
const HTACCESS: &str = "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\nOptions -Indexes\n";

const DEFAULT_FILE: &str = "passdroid.pdvault";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    /// Legacy plain FTP.
    Ftp,
    /// Explicit FTPS (AUTH TLS).
    Ftps,
}

impl Protocol {
    /// An empty value is a config saved before the field existed: plain FTP, so
    /// existing configs are never silently migrated. Unknown values are
    /// rejected rather than guessed, to never downgrade by accident.
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "ftp" => Ok(Self::Ftp),
            "ftps" => Ok(Self::Ftps),
            _ => Err("sync_protocol_invalid".to_string()),
        }
    }
}

/// Open FTP session, plain or TLS-protected.
enum Session {
    Plain(FtpStream),
    Tls(RustlsFtpStream),
}

macro_rules! delegate {
    ($self:ident . $method:ident ( $($arg:expr),* )) => {
        match $self {
            Session::Plain(ftp) => ftp.$method($($arg),*),
            Session::Tls(ftp) => ftp.$method($($arg),*),
        }
    };
}

impl Session {
    fn login(&mut self, user: &str, password: &str) -> FtpResult<()> {
        delegate!(self.login(user, password))
    }
    fn transfer_type(&mut self, file_type: FileType) -> FtpResult<()> {
        delegate!(self.transfer_type(file_type))
    }
    fn cwd(&mut self, path: &str) -> FtpResult<()> {
        delegate!(self.cwd(path))
    }
    fn mkdir(&mut self, path: &str) -> FtpResult<()> {
        delegate!(self.mkdir(path))
    }
    fn retr_as_buffer(&mut self, file: &str) -> FtpResult<Cursor<Vec<u8>>> {
        delegate!(self.retr_as_buffer(file))
    }
    fn quit(&mut self) -> FtpResult<()> {
        delegate!(self.quit())
    }
}

/// The commands the atomic upload needs, behind a trait so the order of the
/// steps (STOR, SIZE, RNFR/RNTO) can be unit-tested without a server.
trait Remote {
    fn put_file(&mut self, file: &str, reader: &mut Cursor<&[u8]>) -> FtpResult<u64>;
    fn rename(&mut self, from: &str, to: &str) -> FtpResult<()>;
    fn rm(&mut self, file: &str) -> FtpResult<()>;
    fn size(&mut self, file: &str) -> FtpResult<usize>;
}

impl Remote for Session {
    fn put_file(&mut self, file: &str, reader: &mut Cursor<&[u8]>) -> FtpResult<u64> {
        delegate!(self.put_file(file, reader))
    }
    fn rename(&mut self, from: &str, to: &str) -> FtpResult<()> {
        delegate!(self.rename(from, to))
    }
    fn rm(&mut self, file: &str) -> FtpResult<()> {
        delegate!(self.rm(file))
    }
    fn size(&mut self, file: &str) -> FtpResult<usize> {
        delegate!(self.size(file))
    }
}

fn remote_file(cfg: &SyncConfig) -> String {
    let file = cfg.remote_file.trim();
    if file.is_empty() {
        DEFAULT_FILE.to_string()
    } else {
        file.to_string()
    }
}

/// True when the server answered "550 file unavailable" (not found / no access).
fn is_file_unavailable(err: &FtpError) -> bool {
    matches!(err, FtpError::UnexpectedResponse(resp) if resp.status == Status::FileUnavailable)
}

/// True when the server refused the command itself (SIZE not supported).
fn is_unsupported(err: &FtpError) -> bool {
    matches!(
        err,
        FtpError::UnexpectedResponse(resp)
            if matches!(resp.status, Status::BadCommand | Status::NotImplemented)
    )
}

/// Certificate verification uses the public Mozilla roots and the configured
/// host name; there is deliberately no way to disable it.
fn tls_connector() -> Result<RustlsConnector, String> {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // Explicit provider: never depends on a process-wide default being installed.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| "sync_tls_failed".to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(RustlsConnector::from(Arc::new(config)))
}

/// Connect and per-read/write limits. A stuck exchange must fail fast instead of
/// freezing sync until the server's idle timeout (vsftpd: 300 s). The classic
/// case: with FTPS, suppaftp starts the data-channel TLS handshake before it
/// reads the command reply, so a data command the server rejects (5xx) waits on
/// a socket the server never accepts.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(30);

fn tcp_with_timeouts(addr: SocketAddr) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    Ok(stream)
}

/// Control connection, trying every resolved address in order: a host may
/// publish IPv6 while the FTP daemon only listens on IPv4.
fn control_stream(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|_| "sync_connect_failed".to_string())?;
    addrs
        .into_iter()
        .find_map(|addr| tcp_with_timeouts(addr).ok())
        .ok_or_else(|| "sync_connect_failed".to_string())
}

/// Passive data connections get the same timeouts as the control channel.
fn data_stream(addr: SocketAddr) -> FtpResult<TcpStream> {
    tcp_with_timeouts(addr).map_err(FtpError::ConnectionError)
}

fn connect(cfg: &SyncConfig) -> Result<Session, String> {
    let host = cfg.host.trim();
    if host.is_empty() {
        return Err("sync_host_required".to_string());
    }
    let protocol = Protocol::parse(&cfg.protocol)?;
    let stream = control_stream(host, cfg.port)?;
    let mut session = match protocol {
        Protocol::Ftp => Session::Plain(
            FtpStream::connect_with_stream(stream)
                .map_err(|_| "sync_connect_failed".to_string())?
                .passive_stream_builder(data_stream),
        ),
        Protocol::Ftps => {
            let ftp = RustlsFtpStream::connect_with_stream(stream)
                .map_err(|_| "sync_connect_failed".to_string())?
                .passive_stream_builder(data_stream);
            // The handshake is lazy, so certificate errors surface from here too.
            let secure = ftp
                .into_secure(tls_connector()?, host)
                .map_err(|_| "sync_tls_failed".to_string())?;
            Session::Tls(secure)
        }
    };
    session
        .login(cfg.username.trim(), &cfg.password)
        .map_err(|_| "sync_auth_failed".to_string())?;
    // The vault is binary; never let the server apply ASCII conversions.
    session
        .transfer_type(FileType::Binary)
        .map_err(|_| "sync_connect_failed".to_string())?;
    Ok(session)
}

/// Change into the remote directory, creating each segment if needed. Only a
/// 550 on CWD means "missing"; any other error aborts.
fn enter_dir(ftp: &mut Session, dir: &str) -> Result<(), String> {
    let dir = dir.trim().trim_matches('/');
    if dir.is_empty() {
        return Ok(());
    }
    for part in dir.split('/').filter(|p| !p.is_empty()) {
        match ftp.cwd(part) {
            Ok(()) => {}
            Err(err) if is_file_unavailable(&err) => {
                ftp.mkdir(part).map_err(|_| "sync_mkdir_failed".to_string())?;
                ftp.cwd(part).map_err(|_| "sync_cwd_failed".to_string())?;
            }
            Err(_) => return Err("sync_cwd_failed".to_string()),
        }
    }
    Ok(())
}

/// Temporary name for an atomic upload: `.<file>.<random-hex>.part`, in the
/// same directory as `file`.
fn temp_name(file: &str, random: [u8; 8]) -> String {
    let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
    match file.rsplit_once('/') {
        Some((dir, name)) => format!("{dir}/.{name}.{hex}.part"),
        None => format!(".{file}.{hex}.part"),
    }
}

fn random_temp_name(file: &str) -> String {
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    temp_name(file, random)
}

/// What a SIZE reply says about the remote vault.
#[derive(Debug, PartialEq, Eq)]
enum Presence {
    /// SIZE answered: the file exists, RETR it.
    Exists,
    /// 550: no such file. No data connection is opened at all.
    Absent,
    /// The server does not implement SIZE: fall back to RETR.
    Unknown,
    /// Anything else is inconclusive: abort, never upload over the remote.
    Failed,
}

/// The existence check runs on the control channel, before any data command:
/// with FTPS a RETR on a missing file would otherwise hang (see IO_TIMEOUT).
fn presence(size: &FtpResult<usize>) -> Presence {
    match size {
        Ok(_) => Presence::Exists,
        Err(err) if is_file_unavailable(err) => Presence::Absent,
        Err(err) if is_unsupported(err) => Presence::Unknown,
        Err(_) => Presence::Failed,
    }
}

/// A SIZE that disagrees with the uploaded length is an error; a server
/// without SIZE support (or any SIZE failure) is not. Checked on the temporary
/// file, before the rename can replace the good remote vault.
fn verify_size(size: FtpResult<usize>, expected: usize) -> Result<(), String> {
    match size {
        Ok(actual) if actual != expected => Err("sync_upload_failed".to_string()),
        _ => Ok(()),
    }
}

/// Verify the credentials and that the remote directory is reachable/creatable.
pub fn test_connection(cfg: &SyncConfig) -> Result<(), String> {
    let mut ftp = connect(cfg)?;
    enter_dir(&mut ftp, &cfg.remote_dir)?;
    let _ = ftp.quit();
    Ok(())
}

/// Download the remote vault bytes, or `None` if the file does not exist yet.
/// Only a 550 on RETR means "no remote file"; every other error aborts, so a
/// failed lookup can never lead to an upload over a newer remote vault.
pub fn download(cfg: &SyncConfig) -> Result<Option<Vec<u8>>, String> {
    let mut ftp = connect(cfg)?;
    enter_dir(&mut ftp, &cfg.remote_dir)?;
    let file = remote_file(cfg);

    let bytes = match presence(&ftp.size(&file)) {
        Presence::Absent => None,
        Presence::Failed => return Err("sync_download_failed".to_string()),
        Presence::Exists => Some(
            ftp.retr_as_buffer(&file)
                .map_err(|_| "sync_download_failed".to_string())?
                .into_inner(),
        ),
        Presence::Unknown => match ftp.retr_as_buffer(&file) {
            Ok(cursor) => Some(cursor.into_inner()),
            Err(err) if is_file_unavailable(&err) => None,
            Err(_) => return Err("sync_download_failed".to_string()),
        },
    };
    let _ = ftp.quit();
    Ok(bytes)
}

/// Upload the vault bytes, dropping a deny-all `.htaccess` next to it.
pub fn upload(cfg: &SyncConfig, bytes: &[u8]) -> Result<(), String> {
    upload_as(cfg, &remote_file(cfg), bytes, true)
}

/// STOR to a temporary name, then RNFR/RNTO onto `file`, so a broken transfer
/// never leaves a truncated vault behind.
fn upload_as(cfg: &SyncConfig, file: &str, bytes: &[u8], guard: bool) -> Result<(), String> {
    let mut ftp = connect(cfg)?;
    enter_dir(&mut ftp, &cfg.remote_dir)?;

    if guard {
        let mut htaccess = Cursor::new(HTACCESS.as_bytes());
        let _ = ftp.put_file(".htaccess", &mut htaccess);
    }

    store_atomic(&mut ftp, &random_temp_name(file), file, bytes)?;
    let _ = ftp.quit();
    Ok(())
}

/// STOR to `temp`, check its SIZE, and only then RNFR/RNTO onto `file`. On any
/// failure the temp file is removed (best effort) and `file` stays untouched.
fn store_atomic(
    ftp: &mut impl Remote,
    temp: &str,
    file: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let mut reader = Cursor::new(bytes);
    let result = match ftp.put_file(temp, &mut reader) {
        Ok(_) => verify_size(ftp.size(temp), bytes.len()).and_then(|_| {
            ftp.rename(temp, file)
                .map_err(|_| "sync_upload_failed".to_string())
        }),
        Err(_) => Err("sync_upload_failed".to_string()),
    };
    if result.is_err() {
        let _ = ftp.rm(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use suppaftp::types::Response;

    fn reply(status: Status) -> FtpError {
        FtpError::UnexpectedResponse(Response::new(status, b"reply".to_vec()))
    }

    #[test]
    fn only_550_is_file_unavailable() {
        assert!(is_file_unavailable(&reply(Status::FileUnavailable)));
        assert!(!is_file_unavailable(&reply(Status::NotLoggedIn)));
        assert!(!is_file_unavailable(&reply(Status::NotAvailable)));
        assert!(!is_file_unavailable(&reply(Status::TransferAborted)));
        assert!(!is_file_unavailable(&FtpError::BadResponse));
        assert!(!is_file_unavailable(&FtpError::SecureError("x".into())));
        assert!(!is_file_unavailable(&FtpError::ConnectionError(
            std::io::Error::from(std::io::ErrorKind::TimedOut)
        )));
    }

    #[test]
    fn presence_is_decided_on_the_control_channel() {
        assert_eq!(presence(&Ok(10)), Presence::Exists);
        // 550: missing, so no RETR (and no data connection) at all.
        assert_eq!(presence(&Err(reply(Status::FileUnavailable))), Presence::Absent);
        // SIZE not implemented: fall back to RETR.
        assert_eq!(presence(&Err(reply(Status::NotImplemented))), Presence::Unknown);
        assert_eq!(presence(&Err(reply(Status::BadCommand))), Presence::Unknown);
        // Anything else is inconclusive: abort rather than upload over the remote.
        assert_eq!(presence(&Err(reply(Status::NotAvailable))), Presence::Failed);
        assert_eq!(
            presence(&Err(FtpError::ConnectionError(std::io::Error::from(
                std::io::ErrorKind::TimedOut
            )))),
            Presence::Failed
        );
    }

    #[test]
    fn verify_size_rejects_only_a_mismatch() {
        assert!(verify_size(Ok(5), 5).is_ok());
        assert!(verify_size(Ok(4), 5).is_err());
        assert!(verify_size(Err(reply(Status::NotImplemented)), 5).is_ok());
    }

    // Records the commands in order; SIZE and STOR outcomes are configurable.
    struct Mock {
        calls: Vec<String>,
        size: Option<usize>,
        stor_fails: bool,
        rename_fails: bool,
    }

    impl Mock {
        fn new(size: Option<usize>) -> Self {
            Mock { calls: Vec::new(), size, stor_fails: false, rename_fails: false }
        }
    }

    impl Remote for Mock {
        fn put_file(&mut self, file: &str, _: &mut Cursor<&[u8]>) -> FtpResult<u64> {
            self.calls.push(format!("stor {file}"));
            if self.stor_fails { Err(FtpError::BadResponse) } else { Ok(0) }
        }
        fn rename(&mut self, from: &str, to: &str) -> FtpResult<()> {
            self.calls.push(format!("rename {from} {to}"));
            if self.rename_fails { Err(FtpError::BadResponse) } else { Ok(()) }
        }
        fn rm(&mut self, file: &str) -> FtpResult<()> {
            self.calls.push(format!("rm {file}"));
            Ok(())
        }
        fn size(&mut self, file: &str) -> FtpResult<usize> {
            self.calls.push(format!("size {file}"));
            self.size.ok_or_else(|| reply(Status::NotImplemented))
        }
    }

    #[test]
    fn store_atomic_renames_after_a_matching_size() {
        let mut ftp = Mock::new(Some(3));
        assert!(store_atomic(&mut ftp, ".t.part", "v", b"abc").is_ok());
        assert_eq!(ftp.calls, ["stor .t.part", "size .t.part", "rename .t.part v"]);
    }

    #[test]
    fn store_atomic_never_renames_a_size_mismatch() {
        let mut ftp = Mock::new(Some(2));
        assert_eq!(
            store_atomic(&mut ftp, ".t.part", "v", b"abc"),
            Err("sync_upload_failed".to_string())
        );
        assert_eq!(ftp.calls, ["stor .t.part", "size .t.part", "rm .t.part"]);
    }

    #[test]
    fn store_atomic_renames_when_size_is_unsupported() {
        let mut ftp = Mock::new(None);
        assert!(store_atomic(&mut ftp, ".t.part", "v", b"abc").is_ok());
        assert_eq!(ftp.calls, ["stor .t.part", "size .t.part", "rename .t.part v"]);
    }

    #[test]
    fn store_atomic_cleans_up_after_a_failed_stor_or_rename() {
        let mut ftp = Mock::new(Some(3));
        ftp.stor_fails = true;
        assert!(store_atomic(&mut ftp, ".t.part", "v", b"abc").is_err());
        assert_eq!(ftp.calls, ["stor .t.part", "rm .t.part"]);

        let mut ftp = Mock::new(Some(3));
        ftp.rename_fails = true;
        assert!(store_atomic(&mut ftp, ".t.part", "v", b"abc").is_err());
        assert_eq!(
            ftp.calls,
            ["stor .t.part", "size .t.part", "rename .t.part v", "rm .t.part"]
        );
    }

    #[test]
    fn temp_name_is_hidden_part_file_in_same_dir() {
        let name = temp_name("passdroid.pdvault", [0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 255]);
        assert_eq!(name, ".passdroid.pdvault.deadbeef000102ff.part");
        assert_eq!(
            temp_name("sub/v.pdvault", [0; 8]),
            "sub/.v.pdvault.0000000000000000.part"
        );
    }

    #[test]
    fn temp_names_are_random_and_never_the_target() {
        let a = random_temp_name("passdroid.pdvault");
        let b = random_temp_name("passdroid.pdvault");
        assert_ne!(a, b);
        assert_ne!(a, "passdroid.pdvault");
        assert!(a.starts_with(".passdroid.pdvault.") && a.ends_with(".part"));
    }

    #[test]
    fn protocol_parse_and_defaults() {
        assert_eq!(Protocol::parse("ftps"), Ok(Protocol::Ftps));
        assert_eq!(Protocol::parse(" FTPS "), Ok(Protocol::Ftps));
        assert_eq!(Protocol::parse("ftp"), Ok(Protocol::Ftp));
        // Configs saved before the field existed stay plain FTP (no migration).
        assert_eq!(Protocol::parse(""), Ok(Protocol::Ftp));
        assert_eq!(
            Protocol::parse("sftp"),
            Err("sync_protocol_invalid".to_string())
        );
    }

    #[test]
    fn missing_protocol_field_deserializes_as_legacy_ftp() {
        let cfg: SyncConfig = serde_json::from_str(r#"{"host":"h"}"#).unwrap();
        assert_eq!(Protocol::parse(&cfg.protocol), Ok(Protocol::Ftp));
    }

    #[test]
    fn tls_connector_builds_without_a_global_provider() {
        assert!(tls_connector().is_ok());
    }

    // Dedicated remote file: the live test never touches the real vault file
    // name nor `.htaccess`.
    const SELFTEST_FILE: &str = "passdroid-selftest.pdvault";

    // Optional live round-trip, configured ONLY through environment variables:
    // PASSDROID_FTP_HOST, _USER, _PASS (required), _PORT (default 21), _DIR
    // (default "vault"), _PROTOCOL ("ftps" default, or "ftp"). No credentials
    // are stored here.
    fn cfg_from_env() -> Option<SyncConfig> {
        Some(SyncConfig {
            enabled: true,
            protocol: std::env::var("PASSDROID_FTP_PROTOCOL").unwrap_or_else(|_| "ftps".to_string()),
            host: std::env::var("PASSDROID_FTP_HOST").ok()?,
            port: std::env::var("PASSDROID_FTP_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(21),
            username: std::env::var("PASSDROID_FTP_USER").ok()?,
            password: std::env::var("PASSDROID_FTP_PASS").ok()?,
            remote_dir: std::env::var("PASSDROID_FTP_DIR").unwrap_or_else(|_| "vault".to_string()),
            remote_file: SELFTEST_FILE.to_string(),
        })
    }

    // Removes the self-test file even if an assertion fails.
    struct Cleanup<'a>(&'a SyncConfig);

    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if let Ok(mut ftp) = connect(self.0) {
                if enter_dir(&mut ftp, &self.0.remote_dir).is_ok() {
                    let _ = ftp.rm(SELFTEST_FILE);
                }
                let _ = ftp.quit();
            }
        }
    }

    #[test]
    #[ignore = "requires live FTP credentials in PASSDROID_FTP_* env vars"]
    fn ftp_round_trip() {
        let Some(cfg) = cfg_from_env() else {
            eprintln!("skipping ftp_round_trip: PASSDROID_FTP_* not set");
            return;
        };
        assert_eq!(cfg.remote_file, SELFTEST_FILE);
        let _cleanup = Cleanup(&cfg);
        drop(Cleanup(&cfg)); // start from a clean slate

        test_connection(&cfg).expect("connection");
        assert_eq!(download(&cfg).expect("download of a missing file"), None);

        let first = b"passdroid-sync-roundtrip-check".to_vec();
        upload_as(&cfg, SELFTEST_FILE, &first, false).expect("upload");
        assert_eq!(download(&cfg).expect("download").as_deref(), Some(&first[..]));

        // Second upload replaces the existing file through the rename.
        let second = b"passdroid-sync-roundtrip-check-v2-longer".to_vec();
        upload_as(&cfg, SELFTEST_FILE, &second, false).expect("replace");
        assert_eq!(download(&cfg).expect("download").as_deref(), Some(&second[..]));
    }
}
