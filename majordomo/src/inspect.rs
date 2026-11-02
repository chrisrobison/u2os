//! Read-only inspection of the operational store for the local API and the
//! `u2` CLI (`actions list|show`, `events tail`). Opens the store read-only,
//! never creates it, and never changes anything. Node remains authoritative:
//! these views describe only Majordomo's isolated Phase 4a store.

use crate::actions::state::Status;
use crate::actions::store::{get_action, list_actions, list_attempts};
use crate::api::{bad_query, error, json_response, AppState};
use crate::events::{read_after, read_last};
use crate::store::Store;
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Response, StatusCode};
use serde_json::{json, Value};
use std::path::Path;

type Rejection = Box<Response<Full<Bytes>>>;

pub fn open(path: &Path) -> Result<Option<Store>, String> {
    Store::open_read_only(path).map_err(|e| {
        tracing::warn!(error = %e, "operational store unavailable");
        "the operational store could not be read".to_string()
    })
}

/// Action as shown in a list: arguments are left out.
pub fn action_summary(a: &crate::actions::Action) -> Value {
    let mut v = serde_json::to_value(a).unwrap_or(Value::Null);
    if let Some(m) = v.as_object_mut() {
        m.remove("arguments");
    }
    v
}

pub fn list_json(
    store: Option<&Store>,
    status: Option<Status>,
    limit: usize,
) -> Result<Value, String> {
    let items = match store {
        None => Vec::new(),
        Some(s) => list_actions(s, status, limit).map_err(|e| e.to_string())?,
    };
    Ok(json!({ "items": items.iter().map(action_summary).collect::<Vec<_>>() }))
}

pub fn show_json(store: Option<&Store>, id: &str) -> Result<Option<Value>, String> {
    let Some(s) = store else { return Ok(None) };
    let Some(a) = get_action(s, id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let attempts = list_attempts(s, id).map_err(|e| e.to_string())?;
    let mut v = serde_json::to_value(&a).unwrap_or(Value::Null);
    v["attempts"] = serde_json::to_value(attempts).unwrap_or(Value::Null);
    Ok(Some(v))
}

/// `after` given: events after that seq, oldest first; otherwise the newest `limit`.
pub fn events_json(
    store: Option<&Store>,
    after: Option<i64>,
    limit: usize,
) -> Result<Value, String> {
    let events = match store {
        None => Vec::new(),
        Some(s) => s
            .with_conn(|c| match after {
                Some(after) => read_after(c, after, limit),
                None => read_last(c, limit),
            })
            .map_err(|e: crate::events::EventError| e.to_string())?,
    };
    Ok(json!({ "items": events }))
}

/// Newest scheduler claims (Phase 4b), read-only.
pub fn scheduler_runs_json(store: Option<&Store>, limit: usize) -> Result<Value, String> {
    let items = match store {
        None => Vec::new(),
        Some(s) => crate::scheduler::list_runs(s, limit).map_err(|e| e.to_string())?,
    };
    Ok(json!({ "enabled": false, "items": items }))
}

pub fn scheduler_runs(state: &AppState, query: &str) -> Response<Full<Bytes>> {
    let p = match params(query, &["limit"]) {
        Ok(p) => p,
        Err(r) => return *r,
    };
    let limit = match limit_of(&p, 100) {
        Ok(l) => l,
        Err(r) => return *r,
    };
    let Ok(store) = open(&state.store_path) else {
        return unavailable();
    };
    match scheduler_runs_json(store.as_ref(), limit) {
        Ok(v) => json_response(StatusCode::OK, &v),
        Err(_) => unavailable(),
    }
}

fn unavailable() -> Response<Full<Bytes>> {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "store_unavailable",
        "the operational store could not be read",
    )
}

fn params(query: &str, allowed: &[&str]) -> Result<Vec<(String, String)>, Rejection> {
    let mut out = Vec::new();
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        if !allowed.contains(&k.as_ref()) {
            let (s, c, m) = bad_query(&format!("unknown parameter: {k}"));
            return Err(Box::new(error(s, c, &m)));
        }
        out.push((k.into_owned(), v.into_owned()));
    }
    Ok(out)
}

fn limit_of(p: &[(String, String)], default: usize) -> Result<usize, Rejection> {
    match p.iter().find(|(k, _)| k == "limit") {
        None => Ok(default),
        Some((_, v)) => v.parse::<usize>().map(|n| n.clamp(1, 500)).map_err(|_| {
            let (s, c, m) = bad_query("limit must be a number");
            Box::new(error(s, c, &m))
        }),
    }
}

pub fn actions_list(state: &AppState, query: &str) -> Response<Full<Bytes>> {
    let p = match params(query, &["status", "limit"]) {
        Ok(p) => p,
        Err(r) => return *r,
    };
    let limit = match limit_of(&p, 100) {
        Ok(l) => l,
        Err(r) => return *r,
    };
    let status = match p.iter().find(|(k, _)| k == "status") {
        None => None,
        Some((_, v)) => match Status::parse(v) {
            Some(s) => Some(s),
            None => {
                let (s, c, m) = bad_query("unknown status");
                return error(s, c, &m);
            }
        },
    };
    let Ok(store) = open(&state.store_path) else {
        return unavailable();
    };
    match list_json(store.as_ref(), status, limit) {
        Ok(v) => json_response(StatusCode::OK, &v),
        Err(_) => unavailable(),
    }
}

pub fn action_show(state: &AppState, id: &str) -> Response<Full<Bytes>> {
    if id.is_empty() || id.len() > 256 || !id.bytes().all(|b| b.is_ascii_graphic()) {
        let (s, c, m) = bad_query("malformed action id");
        return error(s, c, &m);
    }
    let Ok(store) = open(&state.store_path) else {
        return unavailable();
    };
    match show_json(store.as_ref(), id) {
        Ok(Some(v)) => json_response(StatusCode::OK, &v),
        Ok(None) => error(StatusCode::NOT_FOUND, "not_found", "no action with that id"),
        Err(_) => unavailable(),
    }
}

pub fn events(state: &AppState, query: &str) -> Response<Full<Bytes>> {
    let p = match params(query, &["after", "limit"]) {
        Ok(p) => p,
        Err(r) => return *r,
    };
    let limit = match limit_of(&p, 100) {
        Ok(l) => l,
        Err(r) => return *r,
    };
    let after = match p.iter().find(|(k, _)| k == "after") {
        None => None,
        Some((_, v)) => match v.parse::<i64>() {
            Ok(n) if n >= 0 => Some(n),
            _ => {
                let (s, c, m) = bad_query("after must be a non-negative number");
                return error(s, c, &m);
            }
        },
    };
    let Ok(store) = open(&state.store_path) else {
        return unavailable();
    };
    match events_json(store.as_ref(), after, limit) {
        Ok(v) => json_response(StatusCode::OK, &v),
        Err(_) => unavailable(),
    }
}
