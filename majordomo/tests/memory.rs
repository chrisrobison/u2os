//! Memory queries: search, links and backlinks, refresh, and the daemon API.
//! Vaults are built in temporary directories.

use majordomo::memory::{IndexHandle, LinkKind, MemoryIndex, Query};
use majordomo::vault::{scan, Classification};
use majordomo::{client, Config, Daemon};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn vault() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjv").tempdir().unwrap();
    let r = dir.path();
    write(r, "people/alice.md", "---\nid: ent_alice\nname: Alice Chen\nemail: alice@example.com\nrelationship: sister\nrelationships:\n  - predicate: sister_of\n    target: ent_bob\n  - predicate: Bad Pred\n    target: x\n  - just a string\n---\nWorks with [Bob](u2os:ent_bob) on [the house](u2os:projects/house.md).\nSee [gone](u2os:ent_missing).\n```\n[ignored](u2os:ent_code)\n```\n");
    write(r, "people/bob.md", "---\nid: ent_bob\nname: Bob Stone\nclassification: private\n---\nAlice Chen is my friend, but this is only a mention.\n");
    write(
        r,
        "projects/house.md",
        "# House renovation\nKitchen first, mind the peanut allergy.\n",
    );
    write(
        r,
        "commitments/send-report.md",
        "---\ntitle: Send Q3 report\ndue: 2026-10-01\n---\n",
    );
    dir
}

fn index(dir: &tempfile::TempDir) -> MemoryIndex {
    MemoryIndex::build(scan(dir.path()).unwrap())
}

fn q(text: &str) -> Query {
    Query::default().with_text(text).unwrap()
}

fn names(index: &MemoryIndex, query: &Query) -> Vec<String> {
    index
        .search(query)
        .hits
        .iter()
        .map(|h| h.record.name.clone())
        .collect()
}

#[test]
fn search_ranks_name_over_mentions_and_is_case_insensitive() {
    let dir = vault();
    let idx = index(&dir);
    let page = idx.search(&q("ALICE"));
    assert_eq!(page.total, 2);
    assert_eq!(page.hits[0].record.name, "Alice Chen");
    assert!(page.hits[0].matched.contains(&"name".to_string()));
    assert_eq!(page.hits[1].record.name, "Bob Stone");
    assert_eq!(page.hits[1].matched, vec!["notes".to_string()]);
    assert!(page.hits[1]
        .snippet
        .as_deref()
        .unwrap()
        .contains("Alice Chen"));
}

#[test]
fn every_term_must_match_and_filters_combine() {
    let dir = vault();
    let idx = index(&dir);
    assert_eq!(names(&idx, &q("alice sister")), vec!["Alice Chen"]);
    assert!(names(&idx, &q("alice nonexistentword")).is_empty());
    assert_eq!(names(&idx, &q("peanut")), vec!["House renovation"]);

    let by_type = Query {
        type_name: Some("commitment".into()),
        ..Query::default()
    };
    assert_eq!(names(&idx, &by_type), vec!["Send Q3 report"]);

    let private = Query {
        classification: Some(Classification::Private),
        ..Query::default()
    };
    assert_eq!(names(&idx, &private), vec!["Bob Stone"]);

    let wrong_key = Query {
        facts: vec![("RELATIONSHIP".into(), "Sister".into())],
        ..Query::default()
    };
    assert!(names(&idx, &wrong_key).is_empty(), "fact keys are exact");
    let fact = Query {
        facts: vec![("relationship".into(), "Sister".into())],
        ..Query::default()
    };
    assert_eq!(names(&idx, &fact), vec!["Alice Chen"]);
}

#[test]
fn listing_is_sorted_and_paginated() {
    let dir = vault();
    let idx = index(&dir);
    let all = idx.search(&Query::default());
    assert_eq!(all.total, 4);
    let p = Query {
        limit: 2,
        offset: 1,
        ..Query::default()
    };
    let page = idx.search(&p);
    assert_eq!((page.total, page.hits.len(), page.offset), (4, 2, 1));
    assert_eq!(page.hits[0].record.name, all.hits[1].record.name);
}

#[test]
fn query_input_is_bounded() {
    assert!(Query::default().with_text(&"a".repeat(257)).is_err());
    assert!(Query::default().with_text("a b c d e f g h i").is_err());
}

#[test]
fn links_backlinks_and_dangling() {
    let dir = vault();
    let idx = index(&dir);

    let out = idx.outgoing("ent_alice");
    let summary: Vec<(String, LinkKind, Option<String>)> = out
        .iter()
        .map(|l| (l.predicate.clone(), l.kind, l.to.clone()))
        .collect();
    assert!(summary.contains(&("sister_of".into(), LinkKind::Typed, Some("ent_bob".into()))));
    assert!(summary.contains(&("links_to".into(), LinkKind::Inline, Some("ent_bob".into()))));
    let house = idx.vault.by_path("projects/house.md").unwrap().id.clone();
    assert!(
        summary.contains(&("links_to".into(), LinkKind::Inline, Some(house.clone()))),
        "path targets resolve to ids"
    );
    assert!(
        summary.contains(&("links_to".into(), LinkKind::Inline, None)),
        "dangling link is kept"
    );
    assert!(
        !out.iter().any(|l| l.target == "ent_code"),
        "links inside code fences are ignored"
    );

    let back = idx.backlinks("ent_bob");
    assert_eq!(back.len(), 2, "typed + inline from Alice");
    assert!(back.iter().all(|l| l.from == "ent_alice"));
    assert_eq!(idx.backlinks(&house).len(), 1);

    assert!(
        idx.outgoing("ent_bob").is_empty(),
        "a name mentioned in text is not a relationship"
    );
    assert_eq!(idx.dangling().len(), 1);
    assert_eq!(idx.dangling()[0].target, "ent_missing");
}

#[test]
fn malformed_relationships_are_reported_not_fatal() {
    let dir = vault();
    let idx = index(&dir);
    let msgs: Vec<&str> = idx.warnings.iter().map(|w| w.message.as_str()).collect();
    assert_eq!(idx.warnings.len(), 2, "{msgs:?}");
    assert!(idx.warnings.iter().all(|w| w.path == "people/alice.md"));
}

#[test]
fn handle_refreshes_on_external_edit_and_reuses_unchanged_index() {
    let dir = vault();
    let handle = IndexHandle::with_interval(dir.path().to_path_buf(), Duration::ZERO);
    let first = handle.current().unwrap();
    assert!(
        Arc::ptr_eq(&first, &handle.current().unwrap()),
        "unchanged vault is not rescanned"
    );
    assert_eq!(first.vault.records.len(), 4);

    write(dir.path(), "people/carol.md", "---\nname: Carol\n---\n");
    let second = handle.current().unwrap();
    assert_eq!(second.vault.records.len(), 5);

    write(
        dir.path(),
        "people/carol.md",
        "---\nname: Carol Renamed Longer\n---\n",
    );
    assert_eq!(
        names(&handle.current().unwrap(), &q("renamed")),
        vec!["Carol Renamed Longer"]
    );

    fs::remove_file(dir.path().join("people/carol.md")).unwrap();
    assert_eq!(handle.current().unwrap().vault.records.len(), 4);
}

#[test]
fn handle_reports_a_missing_vault_and_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("later");
    let handle = IndexHandle::with_interval(root.clone(), Duration::ZERO);
    assert!(handle.current().is_err());
    assert!(!root.exists(), "never creates the vault");
    write(&root, "people/a.md", "---\nname: A\n---\n");
    assert_eq!(handle.current().unwrap().vault.records.len(), 1);
}

fn config_for(home: &tempfile::TempDir, vault: &Path) -> Config {
    let mut c = Config::for_home(home.path()).unwrap();
    c.vault_dir = vault.to_path_buf();
    c
}

async fn get_json(cfg: &Config, path: &str) -> (u16, Value) {
    let r = client::get(&cfg.socket_path, path).await.unwrap();
    (r.status, serde_json::from_str(&r.body).unwrap())
}

#[tokio::test]
async fn api_serves_memories_search_and_links() {
    let vault = vault();
    let home = tempfile::Builder::new().prefix("mj").tempdir().unwrap();
    let cfg = config_for(&home, vault.path());
    let daemon = Daemon::start(cfg.clone()).await.unwrap();

    let (s, v) = get_json(&cfg, "/api/v1/memories").await;
    assert_eq!((s, v["total"].as_u64()), (200, Some(4)));

    let (_, v) = get_json(&cfg, "/api/v1/memories?type=Person&limit=1").await;
    assert_eq!(
        (v["total"].as_u64(), v["items"].as_array().unwrap().len()),
        (Some(2), 1)
    );

    let (s, v) = get_json(&cfg, "/api/v1/memories/ent_alice").await;
    assert_eq!(s, 200);
    assert_eq!(v["facts"]["email"]["value"], "alice@example.com");
    assert_eq!(v["idFromFile"], true);

    let (_, v) = get_json(&cfg, "/api/v1/memories/ent_alice/links").await;
    assert_eq!(v["outgoing"].as_array().unwrap().len(), 4);
    let (_, v) = get_json(&cfg, "/api/v1/memories/ent_bob/links").await;
    assert_eq!(v["backlinks"].as_array().unwrap().len(), 2);
    assert_eq!(v["backlinks"][0]["otherName"], "Alice Chen");

    let (_, v) = get_json(&cfg, "/api/v1/search?q=peanut%20allergy").await;
    assert_eq!(v["total"], 1);
    assert_eq!(v["items"][0]["name"], "House renovation");

    let (_, v) = get_json(&cfg, "/api/v1/vault").await;
    assert_eq!(
        (v["valid"].as_u64(), v["dangling"].as_u64()),
        (Some(4), Some(1))
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn api_rejects_bad_input_and_unknown_ids() {
    let vault = vault();
    let home = tempfile::Builder::new().prefix("mj").tempdir().unwrap();
    let cfg = config_for(&home, vault.path());
    let daemon = Daemon::start(cfg.clone()).await.unwrap();

    for (path, status) in [
        ("/api/v1/memories/ent_nobody", 404),
        ("/api/v1/memories/bad.id", 400),
        ("/api/v1/memories/ent_alice/links/extra", 404),
        ("/api/v1/search", 400),
        ("/api/v1/memories?limit=abc", 400),
        ("/api/v1/memories?classification=secret", 400),
        ("/api/v1/memories?fact=nocolon", 400),
        ("/api/v1/memories?unknown=1", 400),
    ] {
        let (s, v) = get_json(&cfg, path).await;
        assert_eq!(s, status, "{path}: {v}");
        assert!(v["error"]["code"].is_string(), "{path}");
    }
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn api_follows_external_edits_and_survives_a_missing_vault() {
    let vault_dir = tempfile::tempdir().unwrap();
    let root = vault_dir.path().join("vault");
    let home = tempfile::Builder::new().prefix("mj").tempdir().unwrap();
    let cfg = config_for(&home, &root);
    let daemon = Daemon::start(cfg.clone()).await.unwrap();

    let (s, v) = get_json(&cfg, "/api/v1/memories").await;
    assert_eq!(s, 503);
    assert_eq!(v["error"]["code"], "vault_unavailable");
    assert!(
        !v.to_string().contains(root.to_str().unwrap()),
        "no paths in error bodies"
    );
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/health")
            .await
            .unwrap()
            .status,
        200
    );
    assert!(!root.exists());

    write(&root, "people/zed.md", "---\nname: Zed\n---\n");
    let (s, v) = get_json(&cfg, "/api/v1/memories").await;
    assert_eq!((s, v["total"].as_u64()), (200, Some(1)));

    tokio::time::sleep(Duration::from_millis(600)).await;
    write(&root, "people/yan.md", "---\nname: Yan\n---\n");
    let (_, v) = get_json(&cfg, "/api/v1/memories").await;
    assert_eq!(v["total"], 2, "edit made outside Majordomo is picked up");
    daemon.shutdown().await.unwrap();
}
