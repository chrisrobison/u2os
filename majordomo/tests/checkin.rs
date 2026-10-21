//! Checking the working tree in: dirty trees, conflicts, refusals, and the
//! background service. All against real repositories in temp directories.

use majordomo::git::{checkin, CheckinStatus, Git};
use majordomo::{Config, Daemon};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn raw(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Owner")
        .env("GIT_AUTHOR_EMAIL", "owner@example.com")
        .env("GIT_COMMITTER_NAME", "Owner")
        .env("GIT_COMMITTER_EMAIL", "owner@example.com")
        .output()
        .unwrap()
}

fn run(dir: &Path, args: &[&str]) -> String {
    let out = raw(dir, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// No identity anywhere, so the fallback author is what gets used.
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

fn repo() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjc").tempdir().unwrap();
    run(dir.path(), &["init", "-q", "-b", "main"]);
    write(
        dir.path(),
        "people/alice.md",
        "---\nid: ent_a\n---\nhello\n",
    );
    write(dir.path(), "people/bob.md", "---\nid: ent_b\n---\nbob\n");
    run(dir.path(), &["add", "-A"]);
    run(dir.path(), &["commit", "-q", "-m", "start"]);
    dir
}

fn count(dir: &Path) -> usize {
    run(dir, &["rev-list", "--count", "HEAD"]).parse().unwrap()
}

#[test]
fn dirty_tree_is_checked_in_with_a_message_naming_the_records() {
    let dir = repo();
    let d = dir.path();
    write(
        d,
        "people/alice.md",
        "---\nid: ent_a\n---\nedited elsewhere\n",
    );
    write(d, "notes/new.md", "---\nid: ent_n\n---\nnew\n");
    fs::remove_file(d.join("people/bob.md")).unwrap();

    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Committed, "{r:?}");
    assert_eq!(r.files, 3);
    assert_eq!(count(d), 2);
    assert_eq!(run(d, &["status", "--porcelain"]), "");

    let subject = run(d, &["log", "-1", "--format=%s"]);
    assert!(subject.starts_with("vault: update "), "{subject}");
    assert!(subject.contains("people/alice.md"));
    let body = run(d, &["log", "-1", "--format=%b"]);
    assert!(body.contains("A notes/new.md") && body.contains("D people/bob.md"));
    // No git identity was configured: the fallback author is used.
    assert_eq!(
        run(d, &["log", "-1", "--format=%an <%ae>"]),
        "Majordomo <majordomo@localhost>"
    );
}

#[test]
fn configured_identity_is_respected_and_clean_trees_make_no_commit() {
    let dir = repo();
    let d = dir.path();
    run(d, &["config", "user.name", "Real Owner"]);
    run(d, &["config", "user.email", "real@example.com"]);
    assert_eq!(checkin(&git_for(d)).unwrap().status, CheckinStatus::Clean);
    assert_eq!(count(d), 1);
    write(d, "a.md", "x\n");
    assert_eq!(
        checkin(&git_for(d)).unwrap().status,
        CheckinStatus::Committed
    );
    assert_eq!(
        run(d, &["log", "-1", "--format=%an <%ae>"]),
        "Real Owner <real@example.com>"
    );
}

#[test]
fn first_commit_in_an_unborn_repository() {
    let dir = tempfile::Builder::new().prefix("mjc").tempdir().unwrap();
    let d = dir.path();
    run(d, &["init", "-q", "-b", "main"]);
    write(d, "people/a.md", "x\n");
    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Committed, "{r:?}");
    assert_eq!(count(d), 1);
}

#[test]
fn refuses_when_the_vault_is_not_the_repository_root() {
    let dir = repo();
    let d = dir.path();
    write(d, "vault/a.md", "x\n");
    let r = checkin(&git_for(&d.join("vault"))).unwrap();
    assert_eq!(r.status, CheckinStatus::Skipped);
    assert!(r.reason.unwrap().contains("larger repository"));
    assert_eq!(count(d), 1);
    assert!(run(d, &["status", "--porcelain"]).contains("vault"));
}

#[test]
fn refuses_without_a_repository_on_a_detached_head_and_during_a_rebase() {
    let plain = tempfile::tempdir().unwrap();
    write(plain.path(), "a.md", "x\n");
    assert_eq!(
        checkin(&git_for(plain.path())).unwrap().status,
        CheckinStatus::Skipped
    );
    assert!(!plain.path().join(".git").exists(), "must not git init");

    let dir = repo();
    let d = dir.path();
    write(d, "a.md", "x\n");
    fs::create_dir(d.join(".git/rebase-merge")).unwrap();
    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Skipped);
    assert!(r.reason.unwrap().contains("rebase"));
    fs::remove_dir(d.join(".git/rebase-merge")).unwrap();

    let head = run(d, &["rev-parse", "HEAD"]);
    run(d, &["checkout", "-q", "--detach", &head]);
    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Skipped);
    assert!(r.reason.unwrap().contains("detached"));
    assert_eq!(count(d), 1);
}

#[test]
fn a_locked_index_is_busy_and_the_lock_is_left_alone() {
    let dir = repo();
    let d = dir.path();
    write(d, "a.md", "x\n");
    let lock = d.join(".git/index.lock");
    fs::write(&lock, "").unwrap();
    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Busy);
    assert!(lock.exists(), "another process may own this lock");
    fs::remove_file(&lock).unwrap();
    assert_eq!(
        checkin(&git_for(d)).unwrap().status,
        CheckinStatus::Committed
    );
}

#[test]
fn hooks_and_signing_cannot_block_an_unattended_commit() {
    let dir = repo();
    let d = dir.path();
    let hook = d.join(".git/hooks/pre-commit");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "#!/bin/sh\necho blocked >&2\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    run(d, &["config", "commit.gpgsign", "true"]);
    run(d, &["config", "gpg.program", "/nonexistent/gpg"]);
    write(d, "a.md", "x\n");
    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Committed, "{r:?}");
}

/// main and `other` both change line 2 of the same file; the merge stops with
/// conflict markers in the working tree.
fn conflicted() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjc").tempdir().unwrap();
    let d = dir.path();
    run(d, &["init", "-q", "-b", "main"]);
    write(d, "people/f.md", "a\nb\nc\n");
    write(d, "people/g.md", "a\nb\nc\n");
    run(d, &["add", "-A"]);
    run(d, &["commit", "-q", "-m", "base"]);
    run(d, &["checkout", "-q", "-b", "other"]);
    write(d, "people/f.md", "a\ntheirs\nc\n");
    write(d, "people/g.md", "a\ntheirs\nc\n");
    run(d, &["commit", "-qam", "theirs"]);
    run(d, &["checkout", "-q", "main"]);
    write(d, "people/f.md", "a\nours\nc\n");
    write(d, "people/g.md", "a\nours\nc\n");
    run(d, &["commit", "-qam", "ours"]);
    let merge = raw(d, &["merge", "other"]);
    assert!(!merge.status.success(), "expected a conflict");
    assert!(fs::read_to_string(d.join("people/f.md"))
        .unwrap()
        .contains("<<<<<<<"));
    dir
}

#[test]
fn conflict_markers_are_never_committed_the_current_content_wins() {
    let dir = conflicted();
    let d = dir.path();
    // g.md: the owner already fixed it by hand; f.md still has markers.
    write(d, "people/g.md", "a\nhand merged\nc\n");

    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Committed, "{r:?}");
    let mut resolved = r.resolved_conflicts.clone();
    resolved.sort();
    assert_eq!(resolved, ["people/f.md", "people/g.md"]);

    // f.md keeps this branch's own version; g.md keeps what the owner wrote.
    assert_eq!(run(d, &["show", "HEAD:people/f.md"]), "a\nours\nc");
    assert_eq!(run(d, &["show", "HEAD:people/g.md"]), "a\nhand merged\nc");
    assert_eq!(
        fs::read_to_string(d.join("people/f.md")).unwrap(),
        "a\nours\nc\n"
    );
    for path in ["people/f.md", "people/g.md"] {
        let blob = run(d, &["show", &format!("HEAD:{path}")]);
        assert!(!blob.contains("<<<<<<<") && !blob.contains(">>>>>>>"));
    }
    // The merge is concluded, as a merge commit; nothing is left unmerged.
    assert_eq!(run(d, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
    assert_eq!(run(d, &["ls-files", "-u"]), "");
    assert!(!d.join(".git/MERGE_HEAD").exists());
    assert!(run(d, &["log", "-1", "--format=%b"]).contains("Conflicts resolved"));
}

#[test]
fn a_file_deleted_during_a_conflict_stays_deleted() {
    let dir = conflicted();
    let d = dir.path();
    fs::remove_file(d.join("people/g.md")).unwrap();
    write(d, "people/f.md", "a\nowner's pick\nc\n");
    let r = checkin(&git_for(d)).unwrap();
    assert_eq!(r.status, CheckinStatus::Committed, "{r:?}");
    assert!(!raw(d, &["cat-file", "-e", "HEAD:people/g.md"])
        .status
        .success());
    assert_eq!(run(d, &["show", "HEAD:people/f.md"]), "a\nowner's pick\nc");
}

// ---- background service ----

fn poll(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn config(home: &Path, vault: &Path, enabled: bool) -> Config {
    let mut c = Config::for_home(home).unwrap();
    c.vault_dir = vault.to_path_buf();
    c.checkin = enabled;
    c.checkin_quiet = Duration::from_millis(300);
    c
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_checks_in_changes_in_the_background_when_enabled() {
    let home = tempfile::Builder::new().prefix("mjh").tempdir().unwrap();
    let vault = repo();
    let d = vault.path().to_path_buf();
    // Left dirty while the daemon was "down".
    write(&d, "people/alice.md", "---\nid: ent_a\n---\nbefore start\n");

    let daemon = Daemon::start(config(home.path(), &d, true)).await.unwrap();
    // Raw `git` here, with the isolated config, so the check is not racy.
    poll("startup check-in", || count(&d) == 2);

    // An external edit made later is picked up through the watcher.
    write(&d, "people/carol.md", "---\nid: ent_c\n---\nnew person\n");
    poll("watcher-driven check-in", || count(&d) == 3);
    assert_eq!(run(&d, &["status", "--porcelain"]), "");
    assert!(run(&d, &["log", "-1", "--format=%s"]).contains("people/carol.md"));
    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_does_not_commit_unless_enabled() {
    let home = tempfile::Builder::new().prefix("mjh").tempdir().unwrap();
    let vault = repo();
    let d = vault.path().to_path_buf();
    write(&d, "people/alice.md", "---\nid: ent_a\n---\nchanged\n");
    let daemon = Daemon::start(config(home.path(), &d, false)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(count(&d), 1);
    daemon.shutdown().await.unwrap();
}
