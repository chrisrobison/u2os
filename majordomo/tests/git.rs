//! Read-only Git integration, exercised against real repositories built with
//! the `git` CLI in temporary directories (global git config is ignored).

use majordomo::git::{self, Git, Health, RevSpec};
use std::fs;
use std::path::Path;
use std::process::Command;

fn run(dir: &Path, date: Option<&str>, args: &[&str]) -> String {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    cmd.env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test Owner")
        .env("GIT_AUTHOR_EMAIL", "owner@example.com")
        .env("GIT_COMMITTER_NAME", "Test Owner")
        .env("GIT_COMMITTER_EMAIL", "owner@example.com");
    if let Some(d) = date {
        cmd.env("GIT_AUTHOR_DATE", d).env("GIT_COMMITTER_DATE", d);
    }
    let out = cmd.output().expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn git_for(dir: &Path) -> Git {
    Git::new(dir)
        .with_env("GIT_CONFIG_GLOBAL", "/dev/null")
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
}

fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn commit(dir: &Path, date: &str, message: &str) {
    run(dir, Some(date), &["add", "-A"]);
    run(dir, Some(date), &["commit", "-q", "-m", message]);
}

const ALICE_V1: &str = "---\nid: ent_alice\nname: Alice Chen\nemail: alice@example.com\nphone: '+1 555 0100'\n---\nWorks on the kitchen.\nLikes tea and long walks.\nAllergic to peanuts.\n";

/// A vault repo with a record that is created, renamed, edited, and renamed
/// with heavy edits (so similarity-based rename detection loses it).
fn history_repo() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjg").tempdir().unwrap();
    let d = dir.path();
    run(d, None, &["init", "-q", "-b", "main"]);
    write(d, "people/alice.md", ALICE_V1);
    write(d, "people/bob.md", "---\nid: ent_bob\nname: Bob\n---\n");
    commit(d, "2025-01-10T10:00:00Z", "add alice and bob");
    run(d, None, &["mv", "people/alice.md", "people/alice-chen.md"]);
    commit(d, "2025-03-10T10:00:00Z", "rename alice");
    write(
        d,
        "people/alice-chen.md",
        &ALICE_V1.replace("kitchen", "garden"),
    );
    commit(d, "2025-06-10T10:00:00Z", "edit alice");
    // Rename and rewrite almost everything in one commit: no similarity.
    run(d, None, &["mv", "people/alice-chen.md", "people/a-chen.md"]);
    write(d, "people/a-chen.md", "---\nid: ent_alice\nname: A. Chen\n---\nCompletely new text, nothing in common with before at all.\nSecond completely different line here.\nThird one too, different again.\n");
    commit(d, "2025-09-10T10:00:00Z", "rename and rewrite");
    dir
}

#[test]
fn health_of_a_clean_repo() {
    let dir = history_repo();
    let h = Health::inspect(&git_for(dir.path())).unwrap();
    assert!(h.present && h.is_vault_root);
    assert_eq!(h.branch.as_deref(), Some("main"));
    assert_eq!(h.commits, Some(4));
    assert_eq!(
        (h.staged, h.modified, h.untracked, h.unmerged),
        (0, 0, 0, 0)
    );
    assert!(h.operation.is_none() && !h.unborn && !h.detached && !h.shallow);
    assert!(h.remotes.is_empty());
}

#[test]
fn health_counts_dirty_files_and_reports_states() {
    let dir = history_repo();
    let d = dir.path();
    write(
        d,
        "people/bob.md",
        "---\nid: ent_bob\nname: Bob Edited\n---\n",
    );
    write(d, "people/new.md", "---\nname: New\n---\n");
    run(d, None, &["add", "people/new.md"]);
    write(d, "scratch.txt", "x");
    run(
        d,
        None,
        &[
            "remote",
            "add",
            "origin",
            "https://user:secret-token@example.com/vault.git",
        ],
    );

    let h = Health::inspect(&git_for(d)).unwrap();
    assert_eq!((h.staged, h.modified, h.untracked), (1, 1, 1));
    assert_eq!(h.remotes, vec!["origin"]);
    let json = serde_json::to_string(&h).unwrap();
    assert!(
        !json.contains("secret-token") && !json.contains("example.com"),
        "remote URLs must never be reported: {json}"
    );
    assert!(!h.identity_configured, "global config is ignored in tests");
    assert!(h.warnings.iter().any(|w| w.contains("user.name")));
}

#[test]
fn health_flags_unborn_not_a_repo_and_nested_vaults() {
    let plain = tempfile::tempdir().unwrap();
    let h = Health::inspect(&git_for(plain.path())).unwrap();
    assert!(!h.present && h.toplevel.is_none());

    let fresh = tempfile::tempdir().unwrap();
    run(fresh.path(), None, &["init", "-q"]);
    let h = Health::inspect(&git_for(fresh.path())).unwrap();
    assert!(h.present && h.unborn && h.commits.is_none());
    assert!(h.warnings.iter().any(|w| w.contains("no commits")));

    let outer = history_repo();
    let nested = outer.path().join("vault");
    write(&nested, "people/x.md", "---\nname: X\n---\n");
    let h = Health::inspect(&git_for(&nested)).unwrap();
    assert!(h.present && !h.is_vault_root);
    assert!(h.warnings.iter().any(|w| w.contains("larger repository")));
}

#[test]
fn health_detects_a_merge_in_progress_with_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    run(d, None, &["init", "-q", "-b", "main"]);
    write(d, "people/a.md", "---\nname: A\n---\nbase\n");
    commit(d, "2025-01-01T00:00:00Z", "base");
    run(d, None, &["checkout", "-q", "-b", "other"]);
    write(d, "people/a.md", "---\nname: A\n---\nother side\n");
    commit(d, "2025-01-02T00:00:00Z", "other");
    run(d, None, &["checkout", "-q", "main"]);
    write(d, "people/a.md", "---\nname: A\n---\nmain side\n");
    commit(d, "2025-01-03T00:00:00Z", "main");
    let merge = Command::new("git")
        .arg("-C")
        .arg(d)
        .args(["merge", "other"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e")
        .output()
        .unwrap();
    assert!(!merge.status.success());
    let h = Health::inspect(&git_for(d)).unwrap();
    assert_eq!(h.operation.as_deref(), Some("merge"));
    assert_eq!(h.unmerged, 1);
}

#[test]
fn history_follows_renames_including_a_rewrite_that_defeats_similarity() {
    let dir = history_repo();
    let g = git_for(dir.path());

    // Plain --follow loses the trail at the rewrite; the id supplement recovers it.
    let h = git::record_history(&g, "people/a-chen.md", Some("ent_alice"), 0).unwrap();
    let subjects: Vec<&str> = h.entries.iter().map(|e| e.subject.as_str()).collect();
    assert_eq!(
        subjects,
        vec![
            "rename and rewrite",
            "edit alice",
            "rename alice",
            "add alice and bob"
        ]
    );
    for p in [
        "people/a-chen.md",
        "people/alice-chen.md",
        "people/alice.md",
    ] {
        assert!(h.paths.contains(&p.to_string()), "{p} in {:?}", h.paths);
    }
    assert!(!h.paths.contains(&"people/bob.md".to_string()));

    // The 'rename alice' commit is reported as a rename with both paths.
    let rename = h
        .entries
        .iter()
        .find(|e| e.subject == "rename alice")
        .unwrap();
    assert_eq!(rename.changes[0].status, 'R');
    assert_eq!(
        rename.changes[0].old_path.as_deref(),
        Some("people/alice.md")
    );

    // Without an id only --follow runs, and it stops at the rewrite.
    let plain = git::record_history(&g, "people/a-chen.md", None, 0).unwrap();
    assert!(
        plain.entries.len() < 4,
        "similarity cannot link the rewrite: {}",
        plain.entries.len()
    );
}

#[test]
fn history_for_a_follow_only_record_and_limits() {
    let dir = history_repo();
    let g = git_for(dir.path());
    let h = git::record_history(&g, "people/alice-chen.md", None, 0).unwrap();
    assert_eq!(
        h.entries.len(),
        4,
        "add, rename, edit, and the commit that moved it away"
    );
    let h = git::record_history(&g, "people/alice-chen.md", None, 2).unwrap();
    assert_eq!(h.entries.len(), 2);
    assert_eq!(h.entries[0].subject, "rename and rewrite");
    assert!(h.entries[0].timestamp > h.entries[1].timestamp);
}

#[test]
fn history_of_unknown_paths_empty_repos_and_non_repos() {
    let dir = history_repo();
    let g = git_for(dir.path());
    assert!(git::record_history(&g, "people/never.md", None, 0)
        .unwrap()
        .entries
        .is_empty());

    let fresh = tempfile::tempdir().unwrap();
    run(fresh.path(), None, &["init", "-q"]);
    assert!(
        git::record_history(&git_for(fresh.path()), "people/a.md", None, 0)
            .unwrap()
            .entries
            .is_empty()
    );

    let plain = tempfile::tempdir().unwrap();
    let err = git::record_history(&git_for(plain.path()), "people/a.md", None, 0).unwrap_err();
    assert!(err.to_string().contains("not a git repository"), "{err}");
}

#[test]
fn history_rejects_unsafe_paths_and_ids() {
    let dir = history_repo();
    let g = git_for(dir.path());
    for bad in [
        "",
        "/etc/passwd",
        "../x.md",
        "people/../../x",
        "a//b",
        "people\\x.md",
        "-rf",
    ] {
        assert!(
            git::record_history(&g, bad, None, 0).is_err() || bad == "-rf",
            "{bad:?}"
        );
    }
    assert!(git::record_history(&g, "people/a.md", Some("x$(touch pwned)"), 0).is_err());
    assert!(git::record_history(&g, "people/a.md", Some("a b"), 0).is_err());
    assert!(!dir.path().join("pwned").exists());
}

#[test]
fn history_works_when_the_vault_is_nested_in_a_larger_repo() {
    let outer = tempfile::tempdir().unwrap();
    let d = outer.path();
    run(d, None, &["init", "-q", "-b", "main"]);
    write(d, "README.md", "outer");
    write(
        d,
        "vault/people/a.md",
        "---\nid: ent_a\nname: A\n---\none\n",
    );
    commit(d, "2025-01-01T00:00:00Z", "add");
    write(
        d,
        "vault/people/a.md",
        "---\nid: ent_a\nname: A\n---\ntwo\n",
    );
    commit(d, "2025-02-01T00:00:00Z", "edit");
    let g = git_for(&d.join("vault"));
    let h = git::record_history(&g, "people/a.md", Some("ent_a"), 0).unwrap();
    assert_eq!(h.entries.len(), 2);
    assert_eq!(
        h.entries[0].changes[0].path, "people/a.md",
        "paths are relative to the vault"
    );
}

#[test]
fn diff_since_a_date_and_between_two_points() {
    let dir = history_repo();
    let d = dir.path();
    let g = git_for(d);
    let paths: Vec<String> = git::record_history(&g, "people/a-chen.md", Some("ent_alice"), 0)
        .unwrap()
        .paths;

    // As of 2025-06-30 the record said "garden" (after the June edit).
    let since = RevSpec::parse("2025-06-30").unwrap();
    let diff = git::diff_paths(&g, &paths, &since, None).unwrap();
    assert!(
        diff.patch.contains("-name: Alice Chen") || diff.patch.contains("Alice Chen"),
        "{}",
        diff.patch
    );
    assert!(diff.patch.contains("+name: A. Chen"));
    assert!(diff.base.is_some() && diff.until.is_none());

    // Between two dates: only the rename+edit between March and June.
    let between = git::diff_paths(
        &g,
        &paths,
        &RevSpec::parse("2025-02-01").unwrap(),
        Some(&RevSpec::parse("2025-06-30").unwrap()),
    )
    .unwrap();
    assert!(
        between.patch.contains("garden") && between.patch.contains("-Works on the kitchen"),
        "{}",
        between.patch
    );
    assert!(
        between.patch.contains("rename"),
        "rename is shown as a rename: {}",
        between.patch
    );

    // Before the first commit the record did not exist: diff against nothing.
    let from_nothing =
        git::diff_paths(&g, &paths, &RevSpec::parse("2024-01-01").unwrap(), None).unwrap();
    assert!(from_nothing.base.is_none());
    assert!(
        from_nothing.patch.contains("+++ b/people/a-chen.md"),
        "{}",
        from_nothing.patch
    );

    // Working-tree changes are included.
    write(
        d,
        "people/a-chen.md",
        "---\nid: ent_alice\nname: A. Chen Today\n---\n",
    );
    let live = git::diff_paths(&g, &paths, &RevSpec::parse("2025-09-30").unwrap(), None).unwrap();
    assert!(live.patch.contains("+name: A. Chen Today"));
}

#[test]
fn diff_and_revspec_reject_bad_input_without_reaching_git() {
    let dir = history_repo();
    let g = git_for(dir.path());
    assert!(RevSpec::parse("--output=/tmp/pwned").is_err());
    assert!(RevSpec::parse("HEAD~1").is_err());
    assert!(RevSpec::parse("not-a-date").is_err());
    let unknown = RevSpec::parse("deadbeef").unwrap();
    assert!(git::resolve_rev(&g, &unknown)
        .unwrap_err()
        .to_string()
        .contains("no such commit"));
    assert!(git::diff_paths(
        &g,
        &["../x".to_string()],
        &RevSpec::parse("2025-01-01").unwrap(),
        None
    )
    .is_err());
}

#[test]
fn rewind_extracts_the_vault_as_it_was_without_touching_the_repo() {
    let dir = history_repo();
    let d = dir.path();
    let g = git_for(d);
    write(
        d,
        "people/a-chen.md",
        "---\nname: uncommitted change\n---\n",
    );
    write(d, "untracked.md", "keep me");

    let state = |d: &Path| {
        (
            run(d, None, &["rev-parse", "HEAD"]),
            run(d, None, &["status", "--porcelain"]),
            fs::read(d.join(".git/index")).unwrap(),
            fs::read(d.join("people/a-chen.md")).unwrap(),
        )
    };
    let before = state(d);

    let dest_parent = tempfile::tempdir().unwrap();
    let dest = dest_parent.path().join("snap");
    let info = git::snapshot(&g, &RevSpec::parse("2025-04-01").unwrap(), &dest, d).unwrap();
    assert_eq!(info.files, 2);
    // At 2025-04-01 the record was renamed but not yet edited.
    assert_eq!(
        fs::read_to_string(dest.join("people/alice-chen.md")).unwrap(),
        ALICE_V1
    );
    assert!(!dest.join("people/alice.md").exists() && !dest.join("untracked.md").exists());
    assert!(!dest.join(".git").exists());
    assert_eq!(
        fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
        0o700
    );

    assert_eq!(state(d), before, "worktree, index and HEAD are untouched");

    // The snapshot is itself a readable vault.
    let index = majordomo::vault::scan(&dest).unwrap();
    assert_eq!(index.records.len(), 2);
    assert_eq!(index.get("ent_alice").unwrap().path, "people/alice-chen.md");
}

use std::os::unix::fs::PermissionsExt;

#[test]
fn rewind_destination_rules() {
    let dir = history_repo();
    let d = dir.path();
    let g = git_for(d);
    let when = RevSpec::parse("2025-04-01").unwrap();

    for inside in [d.join("snap"), d.join(".git/snap"), d.join("people/snap")] {
        let err = git::snapshot(&g, &when, &inside, d)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("outside the vault") || err.contains(".git"),
            "{err}"
        );
        assert!(!inside.exists());
    }
    assert!(git::snapshot(&g, &when, Path::new("relative/snap"), d).is_err());
    assert!(git::snapshot(&g, &when, &d.join("../escape"), d).is_err());

    let out = tempfile::tempdir().unwrap();
    // Non-empty directory is refused and left alone.
    write(out.path(), "keep.txt", "mine");
    assert!(git::snapshot(&g, &when, out.path(), d)
        .unwrap_err()
        .to_string()
        .contains("not empty"));
    assert_eq!(
        fs::read_to_string(out.path().join("keep.txt")).unwrap(),
        "mine"
    );

    // Existing empty directory is accepted and stays after a later failure.
    let empty = out.path().join("empty");
    fs::create_dir(&empty).unwrap();
    git::snapshot(&g, &when, &empty, d).unwrap();
    assert!(empty.join("people").is_dir());

    // A symlinked destination is refused.
    let link = out.path().join("link");
    std::os::unix::fs::symlink(out.path(), &link).unwrap();
    assert!(git::snapshot(&g, &when, &link, d).is_err());

    // Before the first commit: nothing to extract, nothing created.
    let before_all = out.path().join("none");
    let err = git::snapshot(&g, &RevSpec::parse("2020-01-01").unwrap(), &before_all, d)
        .unwrap_err()
        .to_string();
    assert!(err.contains("no commit"), "{err}");
    assert!(!before_all.exists());
}

#[test]
fn rewind_skips_symlinks_in_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    run(d, None, &["init", "-q", "-b", "main"]);
    write(d, "people/a.md", "---\nname: A\n---\n");
    std::os::unix::fs::symlink("/etc/passwd", d.join("people/leak.md")).unwrap();
    commit(d, "2025-01-01T00:00:00Z", "with symlink");
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("s");
    let info = git::snapshot(
        &git_for(d),
        &RevSpec::parse("2025-12-31").unwrap(),
        &dest,
        d,
    )
    .unwrap();
    assert_eq!((info.files, info.skipped_links), (1, 1));
    assert!(!dest.join("people/leak.md").exists());
}
