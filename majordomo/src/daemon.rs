//! Daemon lifecycle: lock, socket, serve, graceful shutdown.

use crate::api::AppState;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::fsutil::{self, PathKind};
use crate::lock::InstanceLock;
use crate::server;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use tokio::net::UnixListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub struct Daemon {
    config: Config,
    shutdown_tx: watch::Sender<bool>,
    server: JoinHandle<()>,
    // Held for the daemon's lifetime; released last, on drop.
    _lock: InstanceLock,
}

impl Daemon {
    /// Acquire the single-instance lock, prepare private directories, bind the
    /// owner-only socket and start serving. Starts nothing else: in the
    /// foundation phase Node still owns every responsibility.
    pub async fn start(config: Config) -> Result<Daemon> {
        let uid = fsutil::effective_uid();
        fsutil::ensure_private_dir(&config.data_dir, uid)?;
        fsutil::ensure_private_dir(&config.run_dir, uid)?;

        // Lock before touching the socket: only the lock holder may replace it.
        let lock = InstanceLock::acquire(&config.lock_path, &config.home, uid)?;

        remove_stale_socket(&config, uid)?;
        let listener = UnixListener::bind(&config.socket_path)
            .map_err(Error::io(format!("bind {}", config.socket_path.display())))?;
        fs::set_permissions(&config.socket_path, fs::Permissions::from_mode(0o600))
            .map_err(Error::io(format!("chmod {}", config.socket_path.display())))?;

        let state = Arc::new(AppState::new(
            config.home.clone(),
            config.socket_path.clone(),
            config.vault_dir.clone(),
        ));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let server = tokio::spawn(server::serve(listener, state, uid, shutdown_rx));

        tracing::info!(
            home = %config.home.display(),
            socket = %config.socket_path.display(),
            pid = std::process::id(),
            "majordomo started (foundation phase: all responsibilities remain with Node)"
        );
        Ok(Daemon {
            config,
            shutdown_tx,
            server,
            _lock: lock,
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Stop accepting, drain in-flight requests, remove the socket and release
    /// the lock. The lock file stays on disk by design.
    pub async fn shutdown(self) -> Result<()> {
        let _ = self.shutdown_tx.send(true);
        if let Err(e) = self.server.await {
            tracing::error!(error = %e, "server task failed during shutdown");
        }
        match fs::remove_file(&self.config.socket_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(Error::io(format!(
                    "remove socket {}",
                    self.config.socket_path.display()
                ))(e))
            }
        }
        tracing::info!("majordomo stopped");
        Ok(())
    }

    /// Run until SIGINT or SIGTERM, then shut down gracefully.
    pub async fn run_until_signal(self) -> Result<()> {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term =
            signal(SignalKind::terminate()).map_err(Error::io("install SIGTERM handler"))?;
        let mut int =
            signal(SignalKind::interrupt()).map_err(Error::io("install SIGINT handler"))?;
        tokio::select! {
            _ = term.recv() => tracing::info!("SIGTERM received"),
            _ = int.recv() => tracing::info!("SIGINT received"),
        }
        self.shutdown().await
    }
}

/// We hold the instance lock, so no other daemon is serving this path. A socket
/// left by a crashed predecessor and owned by us is removed. Anything else at
/// that path (symlink, regular file, someone else's socket) is never deleted.
fn remove_stale_socket(config: &Config, uid: u32) -> Result<()> {
    match fsutil::classify(&config.socket_path)? {
        PathKind::Missing => Ok(()),
        PathKind::Socket { uid: owner } if owner == uid => {
            tracing::warn!(path = %config.socket_path.display(), "removing stale socket from a previous run");
            fs::remove_file(&config.socket_path).map_err(Error::io(format!(
                "remove stale socket {}",
                config.socket_path.display()
            )))
        }
        PathKind::Socket { uid: owner } => Err(Error::unsafe_path(
            &config.socket_path,
            format!("socket is owned by uid {owner}, not {uid}"),
        )),
        PathKind::Symlink => Err(Error::unsafe_path(&config.socket_path, "is a symlink")),
        PathKind::Other => Err(Error::unsafe_path(
            &config.socket_path,
            "exists and is not a socket",
        )),
    }
}
