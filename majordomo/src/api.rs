//! Routing for the local `/api/v1` API. Pure functions over method + path so
//! the behaviour is unit-testable without a socket.

use crate::git::{self, Git, Health, RevSpec};
use crate::memory::{view, IndexHandle, Query};
use crate::vault::Classification;
use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{HeaderValue, ALLOW, CACHE_CONTROL, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use hyper::{Method, Response, StatusCode};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
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
    pub memory: Arc<IndexHandle>,
    pub git: Git,
    started: Instant,
    started_at_unix: u64,
}

impl AppState {
    pub fn new(home: PathBuf, socket: PathBuf, vault_dir: PathBuf) -> Self {
        AppState {
            version: env!("CARGO_PKG_VERSION"),
            pid: std::process::id(),
            home,
            socket,
            git: Git::new(vault_dir.clone()),
            memory: Arc::new(IndexHandle::new(vault_dir)),
            started: Instant::now(),
            started_at_unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        }
    }
}

/// `target` is the request path with an optional `?query`. May read the vault
/// from disk, so callers on an async runtime should run it on a blocking thread.
pub fn route(state: &AppState, method: &Method, target: &str) -> Response<Full<Bytes>> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let known = matches!(
        segments.as_slice(),
        [
            "api",
            "v1",
            "health" | "status" | "vault" | "memories" | "search" | "git"
        ] | ["api", "v1", "memories", _]
            | ["api", "v1", "memories", _, "links" | "history" | "diff"]
    );
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
    match segments.as_slice() {
        ["api", "v1", "health"] => json_response(StatusCode::OK, &health(state)),
        ["api", "v1", "status"] => json_response(StatusCode::OK, &status(state)),
        ["api", "v1", "vault"] => with_index(state, |index| {
            let mut v = view::vault_status(index);
            let (generation, last) = state.memory.generation();
            v["generation"] = json!(generation);
            v["lastChange"] = serde_json::to_value(last.as_deref()).unwrap_or(Value::Null);
            Ok(v)
        }),
        ["api", "v1", "memories"] => with_index(state, |index| list(index, query, false)),
        ["api", "v1", "search"] => with_index(state, |index| list(index, query, true)),
        ["api", "v1", "memories", id] => with_index(state, |index| {
            let record = lookup(index, id)?;
            Ok(view::full(record))
        }),
        ["api", "v1", "memories", id, "links"] => with_index(state, |index| {
            let record = lookup(index, id)?;
            Ok(view::links(index, record))
        }),
        ["api", "v1", "git"] => match Health::inspect(&state.git) {
            Ok(h) => json_response(
                StatusCode::OK,
                &serde_json::to_value(h).unwrap_or(Value::Null),
            ),
            Err(e) => git_error(&e),
        },
        ["api", "v1", "memories", id, "history"] => with_index(state, |index| {
            let record = lookup(index, id)?;
            let limit = single_param(query, "limit")?
                .map(|v| {
                    v.parse::<usize>()
                        .map_err(|_| bad_query("limit must be a number"))
                })
                .transpose()?
                .unwrap_or(100);
            let h = git::record_history(
                &state.git,
                &record.path,
                record.id_from_file.then_some(record.id.as_str()),
                limit.min(500),
            )
            .map_err(git_api_error)?;
            Ok(serde_json::to_value(h).unwrap_or(Value::Null))
        }),
        ["api", "v1", "memories", id, "diff"] => with_index(state, |index| {
            let record = lookup(index, id)?;
            let since =
                single_param(query, "since")?.ok_or_else(|| bad_query("since is required"))?;
            let since = RevSpec::parse(&since).map_err(git_api_error)?;
            let until = single_param(query, "until")?
                .map(|u| RevSpec::parse(&u))
                .transpose()
                .map_err(git_api_error)?;
            let history = git::record_history(
                &state.git,
                &record.path,
                record.id_from_file.then_some(record.id.as_str()),
                0,
            )
            .map_err(git_api_error)?;
            let d = git::diff_paths(&state.git, &history.paths, &since, until.as_ref())
                .map_err(git_api_error)?;
            Ok(serde_json::to_value(d).unwrap_or(Value::Null))
        }),
        _ => error(StatusCode::NOT_FOUND, "not_found", "unknown route"),
    }
}

fn bad_query(message: &str) -> (StatusCode, &'static str, String) {
    (StatusCode::BAD_REQUEST, "bad_query", message.to_string())
}

fn single_param(
    query: &str,
    name: &str,
) -> Result<Option<String>, (StatusCode, &'static str, String)> {
    let mut found = None;
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        if k == name {
            found = Some(v.into_owned());
        } else if !matches!(k.as_ref(), "limit" | "since" | "until") {
            return Err(bad_query(&format!("unknown parameter: {k}")));
        }
    }
    Ok(found)
}

/// Our own validation messages are safe to show; git failures are not echoed.
fn git_api_error(e: crate::error::Error) -> (StatusCode, &'static str, String) {
    match e {
        crate::error::Error::Invalid(m) => (StatusCode::BAD_REQUEST, "bad_query", m),
        other => {
            tracing::warn!(error = %other, "git request failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "git_unavailable",
                "git could not answer for this vault".into(),
            )
        }
    }
}

fn git_error(e: &crate::error::Error) -> Response<Full<Bytes>> {
    tracing::warn!(error = %e, "git request failed");
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "git_unavailable",
        "git is not available",
    )
}

type ApiResult = Result<Value, (StatusCode, &'static str, String)>;

fn with_index(
    state: &AppState,
    f: impl FnOnce(&crate::memory::MemoryIndex) -> ApiResult,
) -> Response<Full<Bytes>> {
    match state.memory.current() {
        Err(message) => {
            tracing::warn!(error = %message, "vault unavailable");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "vault_unavailable",
                "the vault could not be read",
            )
        }
        Ok(index) => match f(&index) {
            Ok(body) => json_response(StatusCode::OK, &body),
            Err((status, code, message)) => error(status, code, &message),
        },
    }
}

fn lookup<'a>(
    index: &'a crate::memory::MemoryIndex,
    id: &str,
) -> Result<&'a crate::vault::Record, (StatusCode, &'static str, String)> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !valid {
        return Err((
            StatusCode::BAD_REQUEST,
            "bad_id",
            "malformed memory id".into(),
        ));
    }
    index.get(id).ok_or((
        StatusCode::NOT_FOUND,
        "not_found",
        "no memory with that id".into(),
    ))
}

fn list(index: &crate::memory::MemoryIndex, query: &str, require_text: bool) -> ApiResult {
    let bad = |message: String| (StatusCode::BAD_REQUEST, "bad_query", message);
    let mut q = Query::default();
    let mut text = String::new();
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "q" => text = value.into_owned(),
            "type" => q.type_name = Some(value.into_owned()),
            "classification" => {
                q.classification = Some(
                    parse_classification(&value)
                        .ok_or_else(|| bad("unknown classification".into()))?,
                )
            }
            "fact" => {
                let (k, v) = value
                    .split_once(':')
                    .ok_or_else(|| bad("fact must be key:value".into()))?;
                q.facts.push((k.to_string(), v.to_string()));
            }
            "limit" => {
                q.limit = value
                    .parse()
                    .map_err(|_| bad("limit must be a number".into()))?
            }
            "offset" => {
                q.offset = value
                    .parse()
                    .map_err(|_| bad("offset must be a number".into()))?
            }
            _ => return Err(bad(format!("unknown parameter: {key}"))),
        }
    }
    let q = q.with_text(&text).map_err(bad)?;
    if require_text && q.terms.is_empty() {
        return Err(bad("q is required".into()));
    }
    Ok(view::page(&index.search(&q)))
}

pub fn parse_classification(text: &str) -> Option<Classification> {
    match text {
        "public" => Some(Classification::Public),
        "personal" => Some(Classification::Personal),
        "private" => Some(Classification::Private),
        "sensitive" => Some(Classification::Sensitive),
        _ => None,
    }
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
                json!({
                    "owner": "node",
                    "majordomo": if *name == "vault_index" { "read-only" } else { "disabled" },
                }),
            )
        })
        .collect();
    json!({
        "status": "ok",
        "api": API_VERSION,
        "version": state.version,
        "phase": "vault-read",
        "pid": state.pid,
        "startedAtUnix": state.started_at_unix,
        "uptimeSeconds": state.started.elapsed().as_secs(),
        "home": state.home.display().to_string(),
        "socket": state.socket.display().to_string(),
        "responsibilities": responsibilities,
    })
}

pub fn internal_error() -> Response<Full<Bytes>> {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
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
        AppState::new(
            "/h".into(),
            "/h/majordomo/run/majordomo.sock".into(),
            "/h/vault".into(),
        )
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
    async fn status_reports_node_as_owner_of_everything() {
        let v = body_json(route(&state(), &Method::GET, "/api/v1/status")).await;
        assert_eq!(v["phase"], "vault-read");
        let r = v["responsibilities"].as_object().unwrap();
        assert_eq!(r.len(), RESPONSIBILITIES.len());
        for (name, entry) in r {
            assert_eq!(entry["owner"], "node");
            let expected = if name == "vault_index" {
                "read-only"
            } else {
                "disabled"
            };
            assert_eq!(entry["majordomo"], expected);
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
