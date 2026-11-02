//! Read-only inspection: `u2 actions list|show`, `u2 events tail` and the
//! daemon's `/api/v1/actions` and `/api/v1/events` routes.

use majordomo::actions::{ActionStore, NewAction};
use majordomo::store::{store_path, Store};
use majordomo::{client, Config, Daemon};
use serde_json::{json, Value};
use std::process::Command;
use std::sync::Arc;

fn home() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("mji").tempdir().unwrap()
}

fn u2(home: &tempfile::TempDir, args: &[&str]) -> (bool, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_u2"))
        .args(args)
        .env("U2OS_HOME", home.path())
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    )
}

fn seed(home: &tempfile::TempDir) {
    let store = Arc::new(Store::open(&store_path(&home.path().join("majordomo"))).unwrap());
    let actions = ActionStore::new(store);
    actions
        .submit(
            &NewAction::new("mock.send", json!({"body": "private text"}))
                .id("act_one")
                .consequential(),
            5,
        )
        .unwrap();
}

#[test]
fn cli_reads_without_creating_the_store() {
    let h = home();
    let (ok, out) = u2(&h, &["actions", "list"]);
    assert!(ok);
    assert!(out.contains("no actions"));
    assert!(!h.path().join("majordomo").exists());
    let (ok, out) = u2(&h, &["events", "tail", "--json"]);
    assert!(ok);
    assert_eq!(
        serde_json::from_str::<Value>(&out).unwrap()["items"],
        json!([])
    );
}

#[test]
fn cli_lists_shows_and_tails() {
    let h = home();
    seed(&h);
    let (ok, out) = u2(&h, &["actions", "list", "--json"]);
    assert!(ok);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["items"][0]["id"], "act_one");
    assert_eq!(v["items"][0]["status"], "awaiting_approval");
    assert!(
        v["items"][0].get("arguments").is_none(),
        "lists omit arguments"
    );
    let (ok, out) = u2(&h, &["actions", "show", "act_one", "--json"]);
    assert!(ok);
    assert_eq!(
        serde_json::from_str::<Value>(&out).unwrap()["arguments"]["body"],
        "private text"
    );
    assert!(!u2(&h, &["actions", "show", "missing"]).0);
    assert!(!u2(&h, &["actions", "list", "--status", "bogus"]).0);
    let (ok, out) = u2(&h, &["events", "tail", "--json"]);
    assert!(ok);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["items"][0]["type"], "action.transition");
    assert!(
        !out.contains("private text"),
        "events never carry arguments"
    );
    let (_, out) = u2(&h, &["events", "tail", "--after", "1", "--json"]);
    assert_eq!(
        serde_json::from_str::<Value>(&out).unwrap()["items"],
        json!([])
    );
}

#[tokio::test]
async fn daemon_api_is_read_only_and_reports_the_store() {
    let h = home();
    seed(&h);
    let cfg = Config::for_home(h.path()).unwrap();
    let daemon = Daemon::start(cfg.clone()).await.unwrap();
    let r = client::get(&cfg.socket_path, "/api/v1/actions?status=awaiting_approval")
        .await
        .unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&r.body).unwrap()["items"][0]["id"],
        "act_one"
    );
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/actions/act_one")
            .await
            .unwrap()
            .status,
        200
    );
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/actions/nope")
            .await
            .unwrap()
            .status,
        404
    );
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/actions?status=x")
            .await
            .unwrap()
            .status,
        400
    );
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/events?limit=5")
            .await
            .unwrap()
            .status,
        200
    );
    daemon.shutdown().await.unwrap();
}
