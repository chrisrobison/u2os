//! In-process lifecycle and security tests. Every test uses its own temporary
//! U2OS home; nothing touches a real home or vault.

use majordomo::fsutil::{classify, PathKind};
use majordomo::{client, Config, Daemon, Error};
use std::fs;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::Path;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

fn home() -> TempDir {
    tempfile::Builder::new()
        .prefix("mj")
        .tempdir()
        .expect("tempdir")
}

fn config(dir: &TempDir) -> Config {
    Config::for_home(dir.path()).expect("config")
}

fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).expect("stat").mode() & 0o7777
}

#[tokio::test]
async fn serves_health_and_status_then_cleans_up() {
    let dir = home();
    let cfg = config(&dir);
    let daemon = Daemon::start(cfg.clone()).await.expect("start");

    assert_eq!(mode(&cfg.data_dir), 0o700);
    assert_eq!(mode(&cfg.run_dir), 0o700);
    assert_eq!(mode(&cfg.socket_path), 0o600);
    assert_eq!(mode(&cfg.lock_path), 0o600);

    let health = client::get(&cfg.socket_path, "/api/v1/health")
        .await
        .expect("health");
    assert_eq!(health.status, 200);
    let v: serde_json::Value = serde_json::from_str(&health.body).unwrap();
    assert_eq!(v["status"], "ok");

    let status = client::get(&cfg.socket_path, "/api/v1/status")
        .await
        .expect("status");
    let v: serde_json::Value = serde_json::from_str(&status.body).unwrap();
    assert_eq!(v["pid"], std::process::id());
    assert_eq!(
        v["responsibilities"]["action_queue"]["majordomo"],
        "disabled"
    );

    assert_eq!(
        client::get(&cfg.socket_path, "/nope").await.unwrap().status,
        404
    );

    daemon.shutdown().await.expect("shutdown");
    assert_eq!(classify(&cfg.socket_path).unwrap(), PathKind::Missing);
    assert!(cfg.lock_path.exists(), "lock file stays on disk by design");
    assert!(matches!(
        client::get(&cfg.socket_path, "/api/v1/health").await,
        Err(Error::NotRunning(_))
    ));
}

#[tokio::test]
async fn second_instance_for_the_same_home_is_refused() {
    let dir = home();
    let cfg = config(&dir);
    let first = Daemon::start(cfg.clone()).await.expect("start");

    match Daemon::start(cfg.clone()).await {
        Err(Error::AlreadyRunning { pid, .. }) => assert_eq!(pid, std::process::id().to_string()),
        Err(other) => panic!("expected AlreadyRunning, got {other}"),
        Ok(_) => panic!("second daemon must not start"),
    }
    // The refused attempt must not have disturbed the running daemon's socket.
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/health")
            .await
            .unwrap()
            .status,
        200
    );

    first.shutdown().await.expect("shutdown");
    // After a clean stop the home can be started again.
    let again = Daemon::start(cfg).await.expect("restart");
    again.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn stale_socket_from_a_crashed_run_is_replaced() {
    let dir = home();
    let cfg = config(&dir);
    fs::create_dir_all(&cfg.run_dir).unwrap();
    {
        // Bind and drop: the socket file remains but nothing listens.
        let _dead = std::os::unix::net::UnixListener::bind(&cfg.socket_path).unwrap();
    }
    assert!(matches!(
        classify(&cfg.socket_path).unwrap(),
        PathKind::Socket { .. }
    ));

    let daemon = Daemon::start(cfg.clone())
        .await
        .expect("start over stale socket");
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/health")
            .await
            .unwrap()
            .status,
        200
    );
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn regular_file_at_socket_path_is_refused_and_preserved() {
    let dir = home();
    let cfg = config(&dir);
    fs::create_dir_all(&cfg.run_dir).unwrap();
    fs::write(&cfg.socket_path, b"owner data").unwrap();

    let err = Daemon::start(cfg.clone()).await.err().expect("must refuse");
    assert!(matches!(err, Error::UnsafePath { .. }), "{err}");
    assert_eq!(fs::read(&cfg.socket_path).unwrap(), b"owner data");
}

#[tokio::test]
async fn symlink_at_socket_path_is_refused_and_target_untouched() {
    let dir = home();
    let cfg = config(&dir);
    fs::create_dir_all(&cfg.run_dir).unwrap();
    let target = dir.path().join("target.txt");
    fs::write(&target, b"keep").unwrap();
    symlink(&target, &cfg.socket_path).unwrap();

    let err = Daemon::start(cfg.clone()).await.err().expect("must refuse");
    assert!(matches!(err, Error::UnsafePath { .. }), "{err}");
    assert_eq!(fs::read(&target).unwrap(), b"keep");
}

#[tokio::test]
async fn symlinked_data_dir_is_refused() {
    let dir = home();
    let cfg = config(&dir);
    let elsewhere = dir.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    symlink(&elsewhere, &cfg.data_dir).unwrap();

    let err = Daemon::start(cfg).await.err().expect("must refuse");
    assert!(matches!(err, Error::UnsafePath { .. }), "{err}");
    assert_eq!(
        fs::read_dir(&elsewhere).unwrap().count(),
        0,
        "nothing written through the link"
    );
}

#[tokio::test]
async fn symlinked_lock_file_is_refused() {
    let dir = home();
    let cfg = config(&dir);
    fs::create_dir_all(&cfg.data_dir).unwrap();
    let target = dir.path().join("victim");
    fs::write(&target, b"keep").unwrap();
    symlink(&target, &cfg.lock_path).unwrap();

    assert!(Daemon::start(cfg).await.is_err());
    assert_eq!(
        fs::read(&target).unwrap(),
        b"keep",
        "lock must not write through a symlink"
    );
}

#[tokio::test]
async fn loose_directory_permissions_are_tightened() {
    let dir = home();
    let cfg = config(&dir);
    fs::create_dir_all(&cfg.run_dir).unwrap();
    fs::set_permissions(&cfg.data_dir, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&cfg.run_dir, fs::Permissions::from_mode(0o755)).unwrap();

    let daemon = Daemon::start(cfg.clone()).await.unwrap();
    assert_eq!(mode(&cfg.data_dir), 0o700);
    assert_eq!(mode(&cfg.run_dir), 0o700);
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn never_touches_node_owned_files() {
    let dir = home();
    let cfg = config(&dir);
    let node_db = dir.path().join("db");
    fs::create_dir_all(&node_db).unwrap();
    let files = [
        node_db.join("u2os.sqlite"),
        dir.path().join(".runtime-lock.sqlite"),
    ];
    for f in &files {
        fs::write(f, b"node-owned bytes").unwrap();
    }
    let before: Vec<_> = files
        .iter()
        .map(|f| fs::metadata(f).unwrap().modified().unwrap())
        .collect();

    let daemon = Daemon::start(cfg.clone()).await.unwrap();
    client::get(&cfg.socket_path, "/api/v1/status")
        .await
        .unwrap();
    daemon.shutdown().await.unwrap();

    for (f, mtime) in files.iter().zip(before) {
        assert_eq!(fs::read(f).unwrap(), b"node-owned bytes");
        assert_eq!(fs::metadata(f).unwrap().modified().unwrap(), mtime);
    }
}

#[tokio::test]
async fn burst_of_concurrent_requests_is_served() {
    let dir = home();
    let cfg = config(&dir);
    let daemon = Daemon::start(cfg.clone()).await.unwrap();

    // Waves stay under the kernel accept backlog (macOS caps it near 128); the
    // server bounds in-flight work at MAX_CONNECTIONS and the total here is
    // well above that.
    let mut served = 0;
    for _ in 0..4 {
        let mut tasks = Vec::new();
        for _ in 0..50 {
            let socket = cfg.socket_path.clone();
            tasks.push(tokio::spawn(async move {
                client::get(&socket, "/api/v1/health")
                    .await
                    .map(|r| r.status)
            }));
        }
        for t in tasks {
            assert_eq!(t.await.unwrap().expect("request"), 200);
            served += 1;
        }
    }
    assert!(served > majordomo::server::MAX_CONNECTIONS);
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn post_is_method_not_allowed() {
    let dir = home();
    let cfg = config(&dir);
    let daemon = Daemon::start(cfg.clone()).await.unwrap();

    let mut s = UnixStream::connect(&cfg.socket_path).await.unwrap();
    s.write_all(b"POST /api/v1/status HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 405"), "{out}");

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn idle_connection_does_not_block_shutdown() {
    let dir = home();
    let cfg = config(&dir);
    let daemon = Daemon::start(cfg.clone()).await.unwrap();

    let _idle = UnixStream::connect(&cfg.socket_path).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    let started = Instant::now();
    daemon.shutdown().await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "shutdown took {:?}",
        started.elapsed()
    );
}
