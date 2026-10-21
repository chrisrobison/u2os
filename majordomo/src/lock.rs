//! Single-instance protection: one daemon per U2OS home.
//!
//! This is a dedicated `flock` on `majordomo/majordomo.lock`. It is entirely
//! separate from Node's `.runtime-lock.sqlite` guard, which Majordomo never
//! opens. The lock is released when the file closes or the process dies, so
//! there are no stale PID files; the lock file itself is left on disk.

use crate::error::{Error, Result};
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
    path: PathBuf,
}

impl InstanceLock {
    pub fn acquire(path: &Path, home: &Path, uid: u32) -> Result<Self> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            // Never follow a symlink planted at the lock path.
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(path)
            .map_err(Error::io(format!("open lock file {}", path.display())))?;

        let meta = file
            .metadata()
            .map_err(Error::io(format!("stat lock file {}", path.display())))?;
        if !meta.is_file() || meta.uid() != uid {
            return Err(Error::unsafe_path(
                path,
                "lock file is not a regular file owned by this user",
            ));
        }

        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                let mut text = String::new();
                let _ = file.read_to_string(&mut text);
                let pid = text.trim();
                return Err(Error::AlreadyRunning {
                    home: home.to_path_buf(),
                    pid: if pid.is_empty() {
                        "unknown".into()
                    } else {
                        pid.into()
                    },
                });
            }
            Err(TryLockError::Error(e)) => {
                return Err(Error::io(format!("lock {}", path.display()))(e));
            }
        }

        file.set_len(0)
            .and_then(|_| file.rewind())
            .and_then(|_| writeln!(file, "{}", std::process::id()))
            .and_then(|_| file.flush())
            .map_err(Error::io(format!("write pid to {}", path.display())))?;

        Ok(InstanceLock {
            _file: file,
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
