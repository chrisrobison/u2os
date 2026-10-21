//! Routing for the local `/api/v1` API. Pure functions over method + path so
//! the behaviour is unit-testable without a socket.

use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{HeaderValue, ALLOW, CACHE_CONTROL, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use hyper::{Method, Response, StatusCode};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const API_VERSION: &str = "v1";

/// Who owns each operational responsibility today. In the foundation phase
/// Node owns all of them and Majordomo runs every one disabled (ADR 0011).
const RESPONSIBILITIES: &[&str] = &[
    "vault_index",
    "vault_writes",
    "policy",
    "action_queue",
    "scheduler",
    "event_log",
];

#[derive(Debug)]
pub struct AppState {
    pub version: &'static str,
    pub pid: u32,
    pub home: PathBuf,
    pub socket: PathBuf,
    started: Instant,
    started_at_unix: u64,
}

impl AppState {
    pub fn new(home: PathBuf, socket: PathBuf) -> Self {
        AppState {
            version: env!("CARGO_PKG_VERSION"),
            pid: std::process::id(),
            home,
            socket,
            started: Instant::now(),
            started_at_unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        }
    }
}

pub fn route(state: &AppState, method: &Method, path: &str) -> Response<Full<Bytes>> {
    let known = matches!(path, "/api/v1/health" | "/api/v1/status");
    if !known {
        return error(StatusCode::NOT_FOUND, "not_found", "unknown route");
    }
    if method != Method::GET && method != Method::HEAD {
        let mut resp = error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "only GET is supported",
        );
        resp.headers_mut()
            .insert(ALLOW, HeaderValue::from_static("GET, HEAD"));
        return resp;
    }
    let body = match path {
        "/api/v1/health" => health(state),
        _ => status(state),
    };
    json_response(StatusCode::OK, &body)
}

/// Liveness only. No dependency or path detail.
fn health(state: &AppState) -> Value {
    json!({ "status": "ok", "version": state.version })
}

fn status(state: &AppState) -> Value {
    let responsibilities: serde_json::Map<String, Value> = RESPONSIBILITIES
        .iter()
        .map(|name| {
            (
                (*name).to_string(),
                json!({ "owner": "node", "majordomo": "disabled" }),
            )
        })
        .collect();
    json!({
        "status": "ok",
        "api": API_VERSION,
        "version": state.version,
        "phase": "foundation",
        "pid": state.pid,
        "startedAtUnix": state.started_at_unix,
        "uptimeSeconds": state.started.elapsed().as_secs(),
        "home": state.home.display().to_string(),
        "socket": state.socket.display().to_string(),
        "responsibilities": responsibilities,
    })
}

fn error(status: StatusCode, code: &str, message: &str) -> Response<Full<Bytes>> {
    json_response(
        status,
        &json!({ "error": { "code": code, "message": message } }),
    )
}

fn json_response(status: StatusCode, body: &Value) -> Response<Full<Bytes>> {
    // Serialising a `serde_json::Value` cannot fail; fall back to an empty
    // object rather than panic in a daemon path.
    let text = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let mut resp = Response::new(Full::new(Bytes::from(text)));
    *resp.status_mut() = status;
    let h = resp.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    fn state() -> AppState {
        AppState::new("/h".into(), "/h/majordomo/run/majordomo.sock".into())
    }

    async fn body_json(resp: Response<Full<Bytes>>) -> Value {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn health_is_minimal() {
        let resp = route(&state(), &Method::GET, "/api/v1/health");
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["status"], "ok");
        assert!(v.get("home").is_none(), "health must not leak paths");
    }

    #[tokio::test]
    async fn status_reports_all_responsibilities_disabled() {
        let v = body_json(route(&state(), &Method::GET, "/api/v1/status")).await;
        assert_eq!(v["phase"], "foundation");
        let r = v["responsibilities"].as_object().unwrap();
        assert_eq!(r.len(), RESPONSIBILITIES.len());
        for (_, entry) in r {
            assert_eq!(entry["owner"], "node");
            assert_eq!(entry["majordomo"], "disabled");
        }
    }

    #[test]
    fn unknown_route_is_404_and_post_is_405() {
        let s = state();
        assert_eq!(
            route(&s, &Method::GET, "/nope").status(),
            StatusCode::NOT_FOUND
        );
        let resp = route(&s, &Method::POST, "/api/v1/status");
        assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(resp.headers()[ALLOW], "GET, HEAD");
    }

    #[test]
    fn responses_are_not_cacheable_or_sniffable() {
        let resp = route(&state(), &Method::GET, "/api/v1/health");
        assert_eq!(resp.headers()[CACHE_CONTROL], "no-store");
        assert_eq!(resp.headers()[X_CONTENT_TYPE_OPTIONS], "nosniff");
    }
}
