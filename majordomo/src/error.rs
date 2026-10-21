//! Error type shared by the library and both binaries.

use std::io;
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("another majordomo is already running for {home} (pid {pid})")]
    AlreadyRunning { home: PathBuf, pid: String },

    #[error("{0}")]
    Config(String),

    #[error("refusing unsafe path {path}: {reason}")]
    UnsafePath { path: PathBuf, reason: String },

    #[error("majordomo is not running (nothing is listening on {0})")]
    NotRunning(PathBuf),

    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },

    #[error("local API request failed: {0}")]
    Http(String),
}

impl Error {
    pub fn io(context: impl Into<String>) -> impl FnOnce(io::Error) -> Error {
        let context = context.into();
        move |source| Error::Io { context, source }
    }

    pub fn unsafe_path(path: impl Into<PathBuf>, reason: impl Into<String>) -> Error {
        Error::UnsafePath {
            path: path.into(),
            reason: reason.into(),
        }
    }
}
