//! Small filesystem-safety helpers (private directories, ownership checks).

use crate::error::{Error, Result};
use std::fs;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::Path;

/// The effective uid of this process.
pub fn effective_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

/// Ensure `path` is a real (non-symlink) directory owned by `uid` and not
/// accessible to group/other. A missing directory is created with mode 0700.
/// Loose permissions on a directory we own are tightened, never widened.
pub fn ensure_private_dir(path: &Path, uid: u32) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(Error::unsafe_path(path, "is a symlink"));
            }
            if !meta.is_dir() {
                return Err(Error::unsafe_path(path, "exists and is not a directory"));
            }
            if meta.uid() != uid {
                return Err(Error::unsafe_path(
                    path,
                    format!("owned by uid {}, expected {uid}", meta.uid()),
                ));
            }
            if meta.mode() & 0o077 != 0 {
                tracing::warn!(path = %path.display(), mode = format!("{:o}", meta.mode() & 0o7777), "tightening directory permissions to 0700");
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                    .map_err(Error::io(format!("chmod {}", path.display())))?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(path)
                .map_err(Error::io(format!("create {}", path.display())))?;
            // `recursive` honours the process umask only for the mode bits it
            // can clear; make the final mode exact.
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(Error::io(format!("chmod {}", path.display())))
        }
        Err(e) => Err(Error::io(format!("stat {}", path.display()))(e)),
    }
}

/// What lives at a path, without following symlinks.
#[derive(Debug, PartialEq, Eq)]
pub enum PathKind {
    Missing,
    Socket { uid: u32 },
    Symlink,
    Other,
}

pub fn classify(path: &Path) -> Result<PathKind> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Ok(PathKind::Symlink),
        Ok(m) if m.file_type().is_socket() => Ok(PathKind::Socket { uid: m.uid() }),
        Ok(_) => Ok(PathKind::Other),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PathKind::Missing),
        Err(e) => Err(Error::io(format!("stat {}", path.display()))(e)),
    }
}
