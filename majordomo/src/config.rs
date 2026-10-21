//! Resolution of the data locations used by the daemon.
//!
//! Majordomo only ever writes under `<U2OS_HOME>/majordomo/`. It resolves the
//! home exactly as the Node service does (`U2OS_HOME`, else `~/.u2os`) so both
//! runtimes agree on which installation they belong to.

use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

/// `sun_path` is 104 bytes on macOS and 108 on Linux. Stay under both, leaving
/// room for the terminating NUL.
pub const MAX_SOCKET_PATH_BYTES: usize = 100;

pub const DATA_DIR_NAME: &str = "majordomo";
pub const RUN_DIR_NAME: &str = "run";
pub const LOCK_FILE_NAME: &str = "majordomo.lock";
pub const SOCKET_FILE_NAME: &str = "majordomo.sock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// The U2OS home (shared with the Node service).
    pub home: PathBuf,
    /// `<home>/majordomo`, owned exclusively by this daemon.
    pub data_dir: PathBuf,
    /// `<home>/majordomo/run`, holds the socket.
    pub run_dir: PathBuf,
    pub lock_path: PathBuf,
    pub socket_path: PathBuf,
    /// Where the owner's vault lives (read-only for Majordomo).
    pub vault_dir: PathBuf,
}

impl Config {
    /// Resolve from the process environment (`U2OS_HOME`, then `HOME`).
    pub fn from_env() -> Result<Self> {
        let mut config = Self::for_home(home_from_env()?)?;
        config.vault_dir = crate::vault::locate(&config.home, std::env::var_os("U2OS_VAULT"));
        Ok(config)
    }

    pub fn for_home(home: impl Into<PathBuf>) -> Result<Self> {
        Self::build(home.into())
    }
}

/// The U2OS home as Node resolves it: `U2OS_HOME`, else `~/.u2os`.
pub fn home_from_env() -> Result<PathBuf> {
    if let Some(v) = std::env::var_os("U2OS_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(v));
    }
    let user_home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::Config("neither U2OS_HOME nor HOME is set".to_string()))?;
    Ok(PathBuf::from(user_home).join(".u2os"))
}

impl Config {
    fn build(home: PathBuf) -> Result<Self> {
        if !home.is_absolute() {
            return Err(Error::Config(format!(
                "U2OS home must be an absolute path, got {}",
                home.display()
            )));
        }
        let data_dir = home.join(DATA_DIR_NAME);
        let run_dir = data_dir.join(RUN_DIR_NAME);
        let lock_path = data_dir.join(LOCK_FILE_NAME);
        let socket_path = run_dir.join(SOCKET_FILE_NAME);
        check_socket_path_len(&socket_path)?;
        let vault_dir = crate::vault::locate(&home, None);
        Ok(Config {
            vault_dir,
            home,
            data_dir,
            run_dir,
            lock_path,
            socket_path,
        })
    }
}

fn check_socket_path_len(path: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let len = path.as_os_str().as_bytes().len();
    if len > MAX_SOCKET_PATH_BYTES {
        return Err(Error::Config(format!(
            "socket path is {len} bytes, over the {MAX_SOCKET_PATH_BYTES}-byte limit for Unix sockets: {}. Use a shorter U2OS_HOME.",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_paths_under_majordomo_dir() {
        let c = Config::for_home("/tmp/u2").unwrap();
        assert_eq!(c.data_dir, PathBuf::from("/tmp/u2/majordomo"));
        assert_eq!(
            c.lock_path,
            PathBuf::from("/tmp/u2/majordomo/majordomo.lock")
        );
        assert_eq!(
            c.socket_path,
            PathBuf::from("/tmp/u2/majordomo/run/majordomo.sock")
        );
    }

    #[test]
    fn rejects_relative_home() {
        assert!(matches!(
            Config::for_home("relative/u2"),
            Err(Error::Config(_))
        ));
    }

    #[test]
    fn rejects_overlong_socket_path() {
        let long = format!("/tmp/{}", "a".repeat(120));
        let err = Config::for_home(long).unwrap_err();
        assert!(err.to_string().contains("Unix sockets"), "{err}");
    }
}
