//! Git routes of the daemon API, against a real repository.

use majordomo::{client, Config, Daemon};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, date: &str, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn repo() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjga").tempdir().unwrap();
    let d = dir.path();
    fs::create_dir_all(d.join("people")).unwrap();
    git(d, "2025-01-01T00:00:00Z", &["init", "-q", "-b", "main"]);
    fs::write(
        d.join("people/alice.md"),
        "---\nid: ent_alice\nname: Alice\n---\nfirst notes\nsecond\nthird\n",
    )
    .unwrap();
    git(d, "2025-01-01T00:00:00Z", &["add", "-A"]);
    git(
        d,
        "2025-01-01T00:00:00Z",
        &["commit", "-q", "-m", "add alice"],
    );
    fs::write(
        d.join("people/alice.md"),
        "---\nid: ent_alice\nname: Alice\n---\nedited notes\nsecond\nthird\n",
    )
    .unwrap();
    git(
        d,
        "2025-06-01T00:00:00Z",
        &["commit", "-q", "-am", "edit alice"],
    );
    dir
}

async fn get(cfg: &Config, path: &str) -> (u16, Value) {
    let r = client::get(&cfg.socket_path, path).await.unwrap();
    (r.status, serde_json::from_str(&r.body).unwrap())
}

async fn daemon_for(vault: &Path) -> (Daemon, Config, tempfile::TempDir) {
    let home = tempfile::Builder::new().prefix("mj").tempdir().unwrap();
    let mut cfg = Config::for_home(home.path()).unwrap();
    cfg.vault_dir = vault.to_path_buf();
    (Daemon::start(cfg.clone()).await.unwrap(), cfg, home)
}

#[tokio::test]
async fn git_health_history_and_diff_over_the_api() {
    let v = repo();
    let (daemon, cfg, _home) = daemon_for(v.path()).await;

    let (s, h) = get(&cfg, "/api/v1/git").await;
    assert_eq!(s, 200);
    assert_eq!(
        (
            h["present"].clone(),
            h["isVaultRoot"].clone(),
            h["commits"].clone()
        ),
        (true.into(), true.into(), 2.into())
    );

    let (s, h) = get(&cfg, "/api/v1/memories/ent_alice/history").await;
    assert_eq!(s, 200);
    assert_eq!(h["entries"].as_array().unwrap().len(), 2);
    assert_eq!(h["entries"][0]["subject"], "edit alice");
    assert_eq!(h["paths"][0], "people/alice.md");

    let (_, h) = get(&cfg, "/api/v1/memories/ent_alice/history?limit=1").await;
    assert_eq!(h["entries"].as_array().unwrap().len(), 1);

    let (s, d) = get(&cfg, "/api/v1/memories/ent_alice/diff?since=2025-03-01").await;
    assert_eq!(s, 200);
    assert!(
        d["patch"].as_str().unwrap().contains("+edited notes"),
        "{d}"
    );
    assert!(d["until"].is_null());

    let (_, d) = get(
        &cfg,
        "/api/v1/memories/ent_alice/diff?since=2024-01-01&until=2025-03-01",
    )
    .await;
    assert!(d["base"].is_null());
    assert!(d["patch"].as_str().unwrap().contains("+first notes"));

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn git_routes_validate_input_and_do_not_leak() {
    let v = repo();
    let (daemon, cfg, _home) = daemon_for(v.path()).await;
    for (path, status) in [
        ("/api/v1/memories/ent_alice/diff", 400),
        ("/api/v1/memories/ent_alice/diff?since=yesterday", 400),
        (
            "/api/v1/memories/ent_alice/diff?since=--output%3D/tmp/pwned",
            400,
        ),
        ("/api/v1/memories/ent_alice/diff?since=deadbeef", 400),
        ("/api/v1/memories/ent_alice/history?limit=x", 400),
        ("/api/v1/memories/ent_alice/history?color=red", 400),
        ("/api/v1/memories/ent_nobody/history", 404),
    ] {
        let (s, body) = get(&cfg, path).await;
        assert_eq!(s, status, "{path}: {body}");
        assert!(
            !body.to_string().contains(v.path().to_str().unwrap()),
            "no paths in errors: {body}"
        );
    }
    assert!(!Path::new("/tmp/pwned").exists());
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_vault_that_is_not_a_repository_is_reported_not_fatal() {
    let v = tempfile::Builder::new().prefix("mjga").tempdir().unwrap();
    fs::create_dir_all(v.path().join("people")).unwrap();
    fs::write(
        v.path().join("people/a.md"),
        "---\nid: ent_a\nname: A\n---\n",
    )
    .unwrap();
    let (daemon, cfg, _home) = daemon_for(v.path()).await;

    let (s, h) = get(&cfg, "/api/v1/git").await;
    assert_eq!((s, h["present"].clone()), (200, false.into()));
    let (s, body) = get(&cfg, "/api/v1/memories/ent_a/history").await;
    assert_eq!(s, 400);
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("not a git repository"));
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/health")
            .await
            .unwrap()
            .status,
        200
    );
    daemon.shutdown().await.unwrap();
}
