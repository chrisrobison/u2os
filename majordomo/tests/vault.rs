//! Vault reader tests: parity with the Node indexer (shared golden) and
//! read-only/safety behaviour. All on temporary copies; nothing touches a real vault.

use majordomo::vault::{scan, RecordKind};
use serde_json::{json, Map, Value};
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vault")
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn temp_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    copy_dir(&fixture_dir(), dir.path());
    dir
}

#[test]
fn matches_the_node_indexer_golden() {
    let index = scan(&fixture_dir()).unwrap();

    let mut records: Vec<Value> = index
        .records
        .iter()
        .map(|r| {
            let facts: Map<String, Value> = r
                .facts
                .iter()
                .map(|(k, f)| {
                    (
                        k.clone(),
                        json!({"value": f.value, "classification": f.classification}),
                    )
                })
                .collect();
            if r.kind == RecordKind::Owner {
                json!({"path": r.path, "type": "Person", "facts": facts})
            } else {
                let mut v = json!({
                    "path": r.path, "type": r.kind.type_name(), "id": r.id, "name": r.name,
                    "classification": r.classification, "facts": facts,
                });
                if let Some(status) = &r.status {
                    v["status"] = json!(status);
                }
                v
            }
        })
        .collect();
    records.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let mut invalid: Vec<&str> = index.invalid.iter().map(|i| i.path.as_str()).collect();
    invalid.sort();

    let golden: Value = serde_json::from_str(
        &fs::read_to_string(fixture_dir().join("../vault-expected.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(json!({"records": records, "invalid": invalid}), golden);
}

#[test]
fn indexes_by_id_path_and_type_and_reports_problems() {
    let index = scan(&fixture_dir()).unwrap();
    assert_eq!(index.of_type("Commitment").count(), 2);
    let dave = index.get("ent_known_dave").expect("bound id");
    assert_eq!(
        dave.path, "people/dave-copy.md",
        "first file in order wins; the later one is a duplicate"
    );
    assert!(index.by_path("people/alice-chen.md").is_some());
    let dup = index
        .invalid
        .iter()
        .find(|i| i.path == "people/dave.md")
        .unwrap();
    assert!(dup.error.contains("already describes"), "{}", dup.error);
    let bad = index
        .invalid
        .iter()
        .find(|i| i.path == "people/bad-class.md")
        .unwrap();
    assert!(bad.error.contains("classification"), "{}", bad.error);
    assert!(index.records.iter().all(|r| !r.path.contains(".hidden")));
    assert!(index.by_path("people/notes.txt").is_none());
}

#[test]
fn scanning_never_modifies_the_vault() {
    let dir = temp_vault();
    let snapshot = |root: &Path| -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let e = e.unwrap();
                if e.file_type().unwrap().is_dir() {
                    stack.push(e.path());
                } else {
                    let m = fs::metadata(e.path()).unwrap();
                    out.push((
                        e.path().display().to_string(),
                        fs::read(e.path()).unwrap(),
                        m.modified().unwrap(),
                    ));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    };
    let before = snapshot(dir.path());
    scan(dir.path()).unwrap();
    assert_eq!(before, snapshot(dir.path()));
}

#[test]
fn works_on_a_read_only_vault() {
    let dir = temp_vault();
    for sub in ["", "people", "projects", "commitments"] {
        fs::set_permissions(dir.path().join(sub), fs::Permissions::from_mode(0o555)).unwrap();
    }
    let result = scan(dir.path());
    for sub in ["", "people", "projects", "commitments"] {
        fs::set_permissions(dir.path().join(sub), fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(result.unwrap().records.len() > 5);
}

#[test]
fn symlinked_files_and_directories_are_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.md"), "---\nname: Secret\n---\n").unwrap();
    fs::create_dir(dir.path().join("people")).unwrap();
    symlink(
        outside.path().join("secret.md"),
        dir.path().join("people/link.md"),
    )
    .unwrap();
    symlink(outside.path(), dir.path().join("projects")).unwrap();
    symlink(outside.path().join("secret.md"), dir.path().join("me.md")).unwrap();

    let index = scan(dir.path()).unwrap();
    assert!(index.records.is_empty(), "{:?}", index.records);
    assert!(index
        .notes
        .iter()
        .any(|n| n.contains("projects/") && n.contains("symlink")));
}

#[test]
fn oversize_and_non_utf8_files() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("people")).unwrap();
    fs::write(dir.path().join("people/big.md"), vec![b'a'; 256 * 1024 + 1]).unwrap();
    fs::write(
        dir.path().join("people/latin.md"),
        b"---\nname: Caf\xe9\n---\n",
    )
    .unwrap();
    let index = scan(dir.path()).unwrap();
    assert!(index
        .invalid
        .iter()
        .any(|i| i.path == "people/big.md" && i.error.contains("exceeds")));
    let latin = index.by_path("people/latin.md").unwrap();
    assert!(
        latin.name.starts_with("Caf"),
        "invalid bytes are replaced, not fatal: {}",
        latin.name
    );
}

#[test]
fn missing_or_non_directory_root_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert!(scan(&dir.path().join("nope")).is_err());
    fs::write(dir.path().join("file"), "x").unwrap();
    assert!(scan(&dir.path().join("file")).is_err());
    assert!(
        !dir.path().join("nope").exists(),
        "scan must not create the vault"
    );
}
