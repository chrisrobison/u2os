//! Minimal client for the local API, used by the `u2` CLI and the doctor.

use crate::error::{Error, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Limited};
use hyper::client::conn::http1;
use hyper::Request;
use hyper_util::rt::TokioIo;
use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;
use tokio::net::UnixStream;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BODY_BYTES: usize = 1 << 20;

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// `GET path` over the daemon's Unix socket.
pub async fn get(socket: &Path, path: &str) -> Result<Reply> {
    timeout(TIMEOUT, get_inner(socket, path))
        .await
        .map_err(|_| Error::Http(format!("timed out after {}s", TIMEOUT.as_secs())))?
}

async fn get_inner(socket: &Path, path: &str) -> Result<Reply> {
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|e| match e.kind() {
            ErrorKind::NotFound | ErrorKind::ConnectionRefused => {
                Error::NotRunning(socket.to_path_buf())
            }
            _ => Error::io(format!("connect {}", socket.display()))(e),
        })?;
    let (mut sender, conn) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| Error::Http(e.to_string()))?;
    let driver = tokio::spawn(async move {
        let _ = conn.await;
    });

    let request = Request::builder()
        .method("GET")
        .uri(path)
        .header("host", "majordomo")
        .header("connection", "close")
        .body(Empty::<Bytes>::new())
        .map_err(|e| Error::Http(e.to_string()))?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|e| Error::Http(e.to_string()))?;
    let status = response.status().as_u16();
    let body = Limited::new(response.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
        .map_err(|e| Error::Http(e.to_string()))?
        .to_bytes();
    driver.abort();
    Ok(Reply {
        status,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}
