//! Accept loop for the owner-only Unix socket.

use crate::api::{self, AppState};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;

/// Bounded concurrency: further clients wait in the kernel accept backlog.
pub const MAX_CONNECTIONS: usize = 64;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);
const DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Only a process running as the daemon's own user may use the API.
pub fn peer_allowed(peer_uid: u32, daemon_uid: u32) -> bool {
    peer_uid == daemon_uid
}

pub async fn serve(
    listener: UnixListener,
    state: Arc<AppState>,
    daemon_uid: u32,
    mut shutdown: watch::Receiver<bool>,
) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut conns: JoinSet<()> = JoinSet::new();

    loop {
        if *shutdown.borrow() {
            break;
        }
        let permit = tokio::select! {
            _ = shutdown.changed() => break,
            p = permits.clone().acquire_owned() => match p {
                Ok(p) => p,
                Err(_) => break,
            },
        };
        let stream = tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _addr)) => stream,
                Err(e) => {
                    tracing::warn!(error = %e, "accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
        };
        let state = state.clone();
        let conn_shutdown = shutdown.clone();
        conns.spawn(async move {
            handle_connection(stream, state, daemon_uid, conn_shutdown).await;
            drop(permit);
        });
        while conns.try_join_next().is_some() {}
    }

    drop(listener);
    let drain = async { while conns.join_next().await.is_some() {} };
    if tokio::time::timeout(DRAIN_GRACE, drain).await.is_err() {
        tracing::warn!("connections did not drain in time; aborting them");
        conns.abort_all();
    }
}

async fn handle_connection(
    stream: UnixStream,
    state: Arc<AppState>,
    daemon_uid: u32,
    mut shutdown: watch::Receiver<bool>,
) {
    match stream.peer_cred() {
        Ok(cred) if peer_allowed(cred.uid(), daemon_uid) => {}
        Ok(cred) => {
            tracing::warn!(
                peer_uid = cred.uid(),
                "rejected connection from another user"
            );
            return;
        }
        Err(e) => {
            tracing::warn!(error = %e, "rejected connection: peer credentials unavailable");
            return;
        }
    }

    let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
        let state = state.clone();
        async move {
            let method = req.method().clone();
            let target = req.uri().path_and_query().map_or_else(
                || req.uri().path().to_string(),
                |pq| pq.as_str().to_string(),
            );
            // Routes may read the vault from disk; keep that off the async workers.
            let response =
                tokio::task::spawn_blocking(move || api::route(&state, &method, &target))
                    .await
                    .unwrap_or_else(|_| api::internal_error());
            Ok::<_, Infallible>(response)
        }
    });
    let conn = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .keep_alive(false)
        .serve_connection(TokioIo::new(stream), service);
    tokio::pin!(conn);

    let work = async {
        tokio::select! {
            r = conn.as_mut() => r,
            _ = shutdown.changed() => {
                conn.as_mut().graceful_shutdown();
                conn.as_mut().await
            }
        }
    };
    match tokio::time::timeout(CONNECTION_TIMEOUT, work).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::debug!(error = %e, "connection ended with error"),
        Err(_) => tracing::debug!("connection timed out"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_same_uid_is_allowed() {
        assert!(peer_allowed(501, 501));
        assert!(!peer_allowed(0, 501));
        assert!(!peer_allowed(502, 501));
    }
}
