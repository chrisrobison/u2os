//! Vault watcher and change announcements. These use real filesystem events,
//! so they poll with generous timeouts instead of fixed sleeps.

use majordomo::memory::{IndexChange, IndexHandle, VaultWatcher, WatchOptions};
use majordomo::{client, Config, Daemon};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast::Receiver;

const FAST: WatchOptions = WatchOptions {
    debounce: Duration::from_millis(100),
    reconcile: Duration::from_millis(300),
};
// Events only: reconcile is effectively off, so a refresh proves the watcher fired.
const EVENTS_ONLY: WatchOptions = WatchOptions {
    debounce: Duration::from_millis(100),
    reconcile: Duration::from_secs(3600),
};

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn vault() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjw").tempdir().unwrap();
    write(dir.path(), "people/alice.md", "---\nname: Alice\n---\n");
    write(dir.path(), "projects/house.md", "# House\n");
    dir
}

/// A handle whose own throttle is an hour, so only the watcher can refresh it.
fn handle(dir: &tempfile::TempDir) -> Arc<IndexHandle> {
    Arc::new(IndexHandle::with_interval(
        dir.path().to_path_buf(),
        Duration::from_secs(3600),
    ))
}

async fn next_change(
    rx: &mut Receiver<Arc<IndexChange>>,
    within: Duration,
) -> Option<Arc<IndexChange>> {
    tokio::time::timeout(within, rx.recv())
        .await
        .ok()
        .and_then(Result::ok)
}

async fn change_matching(
    rx: &mut Receiver<Arc<IndexChange>>,
    within: Duration,
    pred: impl Fn(&IndexChange) -> bool,
) -> Option<Arc<IndexChange>> {
    let deadline = Instant::now() + within;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let change = next_change(rx, left).await?;
        if pred(&change) {
            return Some(change);
        }
    }
    None
}

#[tokio::test]
async fn edit_add_and_remove_are_announced_and_visible_without_a_request() {
    let dir = vault();
    let h = handle(&dir);
    h.current().unwrap();
    let mut rx = h.subscribe();
    let _watcher = VaultWatcher::spawn(h.clone(), EVENTS_ONLY).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await; // let the watch establish

    write(
        dir.path(),
        "people/alice.md",
        "---\nname: Alice Renamed\n---\n",
    );
    let c = change_matching(&mut rx, Duration::from_secs(10), |c| !c.modified.is_empty())
        .await
        .expect("modified");
    assert_eq!(c.modified[0].path, "people/alice.md");
    assert_eq!(
        h.current()
            .unwrap()
            .vault
            .by_path("people/alice.md")
            .unwrap()
            .name,
        "Alice Renamed"
    );

    write(dir.path(), "people/bob.md", "---\nname: Bob\n---\n");
    let c = change_matching(&mut rx, Duration::from_secs(10), |c| !c.added.is_empty())
        .await
        .expect("added");
    assert_eq!(c.added[0].path, "people/bob.md");
    assert_eq!(h.current().unwrap().vault.records.len(), 3);

    fs::remove_file(dir.path().join("people/bob.md")).unwrap();
    let c = change_matching(&mut rx, Duration::from_secs(10), |c| !c.removed.is_empty())
        .await
        .expect("removed");
    assert_eq!(c.removed[0].path, "people/bob.md");
    assert_eq!(h.current().unwrap().vault.records.len(), 2);
}

#[tokio::test]
async fn a_burst_of_saves_is_debounced_into_few_rescans() {
    let dir = vault();
    let h = handle(&dir);
    h.current().unwrap();
    let before = h.generation().0;
    let mut rx = h.subscribe();
    let _watcher = VaultWatcher::spawn(h.clone(), EVENTS_ONLY).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    for i in 0..40 {
        write(
            dir.path(),
            "people/alice.md",
            &format!("---\nname: Alice {i}\n---\n"),
        );
    }
    change_matching(&mut rx, Duration::from_secs(10), |c| {
        c.modified.iter().any(|m| m.path == "people/alice.md")
    })
    .await
    .expect("change");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rescans = h.generation().0 - before;
    assert!(
        (1..=4).contains(&rescans),
        "40 writes caused {rescans} rescans"
    );
    assert_eq!(
        h.current()
            .unwrap()
            .vault
            .by_path("people/alice.md")
            .unwrap()
            .name,
        "Alice 39"
    );
}

#[tokio::test]
async fn unrelated_files_do_not_cause_rescans() {
    let dir = vault();
    let h = handle(&dir);
    h.current().unwrap();
    let before = h.generation().0;
    let _watcher = VaultWatcher::spawn(h.clone(), EVENTS_ONLY).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let after_start = h.generation().0;

    write(dir.path(), "journal/2026-10.jsonl", "{\"type\":\"x\"}\n");
    write(dir.path(), "README.md", "hello");
    write(dir.path(), ".git/index", "x");
    write(dir.path(), "people/notes.txt", "not markdown");
    tokio::time::sleep(Duration::from_millis(800)).await;

    assert_eq!(
        h.generation().0,
        after_start,
        "no rescan for files that are not vault sources"
    );
    assert!(after_start - before <= 1);
}

#[tokio::test]
async fn reconcile_picks_up_a_vault_created_after_start() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("late-vault");
    let h = Arc::new(IndexHandle::with_interval(
        root.clone(),
        Duration::from_secs(3600),
    ));
    let _watcher = VaultWatcher::spawn(h.clone(), FAST).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(h.current().is_err());
    assert!(!root.exists(), "the watcher never creates the vault");

    write(&root, "people/a.md", "---\nname: A\n---\n");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if h.generation().0 > 0 && h.current().is_ok_and(|i| i.vault.records.len() == 1) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "vault created later was never indexed"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // And the live watch works on the vault that appeared.
    let mut rx = h.subscribe();
    write(&root, "people/b.md", "---\nname: B\n---\n");
    change_matching(&mut rx, Duration::from_secs(10), |c| {
        c.added.iter().any(|a| a.path == "people/b.md")
    })
    .await
    .expect("second file announced");
}

#[tokio::test]
async fn changes_made_before_the_watch_started_are_found() {
    // The edit lands while nothing is watching (the handle's own throttle is an
    // hour, so it has not looked either). Starting the watcher must find it,
    // whether through its initial refresh or the first reconcile.
    let dir = vault();
    let h = handle(&dir);
    h.current().unwrap();
    write(dir.path(), "people/carol.md", "---\nname: Carol\n---\n");
    let mut rx = h.subscribe();
    let _watcher = VaultWatcher::spawn(h.clone(), FAST).unwrap();
    change_matching(&mut rx, Duration::from_secs(10), |c| {
        c.added.iter().any(|a| a.path == "people/carol.md")
    })
    .await
    .expect("found");
}

#[tokio::test]
async fn dropping_the_watcher_stops_it_promptly() {
    let dir = vault();
    let h = handle(&dir);
    h.current().unwrap();
    let watcher = VaultWatcher::spawn(h.clone(), FAST).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let started = Instant::now();
    drop(watcher);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "stop took {:?}",
        started.elapsed()
    );

    let gen = h.generation().0;
    write(dir.path(), "people/late.md", "---\nname: Late\n---\n");
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(h.generation().0, gen, "no more rescans after stop");
}

#[tokio::test]
async fn watching_never_modifies_the_vault() {
    let dir = vault();
    let h = handle(&dir);
    let snap = |d: &Path| {
        let mut v: Vec<_> = ["people/alice.md", "projects/house.md"]
            .iter()
            .map(|r| {
                (
                    fs::read(d.join(r)).unwrap(),
                    fs::metadata(d.join(r)).unwrap().modified().unwrap(),
                )
            })
            .collect();
        v.sort();
        v
    };
    let before = snap(dir.path());
    let _w = VaultWatcher::spawn(h.clone(), FAST).unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    h.refresh().unwrap();
    assert_eq!(before, snap(dir.path()));
    assert_eq!(
        fs::read_dir(dir.path()).unwrap().count(),
        2,
        "no files or directories created"
    );
}

#[tokio::test]
async fn daemon_runs_the_watcher_and_reports_generation() {
    let vault = vault();
    let home = tempfile::Builder::new().prefix("mj").tempdir().unwrap();
    let mut cfg = Config::for_home(home.path()).unwrap();
    cfg.vault_dir = vault.path().to_path_buf();
    let daemon = Daemon::start(cfg.clone()).await.unwrap();

    let status = |body: String| serde_json::from_str::<serde_json::Value>(&body).unwrap();
    let first = status(
        client::get(&cfg.socket_path, "/api/v1/vault")
            .await
            .unwrap()
            .body,
    );
    let g0 = first["generation"].as_u64().unwrap();
    assert!(g0 >= 1);
    assert!(first["lastChange"].is_null());

    write(vault.path(), "people/dora.md", "---\nname: Dora\n---\n");
    let deadline = Instant::now() + Duration::from_secs(10);
    let v = loop {
        let v = status(
            client::get(&cfg.socket_path, "/api/v1/vault")
                .await
                .unwrap()
                .body,
        );
        if v["lastChange"]["added"][0]["path"] == "people/dora.md" {
            break v;
        }
        assert!(Instant::now() < deadline, "change not reported: {v}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(v["generation"].as_u64().unwrap() > g0);

    let started = Instant::now();
    daemon.shutdown().await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
}
