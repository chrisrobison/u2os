//! The `u2 forget` command line, against a temporary repository.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

const U2: &str = env!("CARGO_BIN_EXE_u2");

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
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
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn u2(vault: &Path, args: &[&str]) -> Output {
    Command::new(U2)
        .args(args)
        .arg("--vault")
        .arg(vault)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("U2OS_HOME", vault.join("home-not-used"))
        .output()
        .unwrap()
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn vault() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjfc").tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    fs::create_dir_all(d.join("people")).unwrap();
    fs::write(d.join("people/a.md"), "---\nid: ent_a\n---\nHUSH\n").unwrap();
    fs::write(d.join("people/b.md"), "---\nid: ent_b\n---\nb\n").unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", "start"]);
    dir
}

#[test]
fn forget_says_plainly_that_history_still_holds_it() {
    let dir = vault();
    let d = dir.path();
    let out = u2(d, &["forget", "ent_b"]);
    let t = text(&out);
    assert!(out.status.success(), "{t}");
    assert!(t.contains("removed people/b.md"), "{t}");
    assert!(
        t.contains("Git history still holds the removed material"),
        "{t}"
    );
    assert!(t.contains("unaffected"), "{t}");
    assert!(!d.join("people/b.md").exists());
    assert_eq!(
        git(d, &["log", "-1", "--format=%s"]),
        "vault: remove people/b.md"
    );
}

#[test]
fn scrub_flags_are_all_required_and_nothing_is_assumed() {
    let dir = vault();
    let d = dir.path();
    let head = git(d, &["rev-parse", "HEAD"]);

    // confirmation flags without --scrub-history
    let out = u2(d, &["forget", "ent_a", "--confirm-scrub", "people/a.md"]);
    assert!(!out.status.success());
    assert!(text(&out).contains("only apply with --scrub-history"));

    // --scrub-history alone only explains, and changes nothing
    let out = u2(d, &["forget", "ent_a", "--scrub-history"]);
    assert!(!out.status.success());
    let t = text(&out);
    assert!(t.contains("--confirm-scrub people/a.md"), "{t}");
    // an environment variable is not a confirmation
    let out = Command::new(U2)
        .args(["forget", "ent_a", "--scrub-history", "--vault"])
        .arg(d)
        .env("U2_CONFIRM", "1")
        .env("U2OS_CONFIRM_SCRUB", "people/a.md")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(!out.status.success());

    // wrong confirmation
    let out = u2(
        d,
        &[
            "forget",
            "ent_a",
            "--scrub-history",
            "--confirm-scrub",
            "ent_a",
        ],
    );
    assert!(!out.status.success());
    assert!(text(&out).contains("must exactly equal"));

    assert_eq!(git(d, &["rev-parse", "HEAD"]), head);
    assert!(d.join("people/a.md").exists());
}

#[test]
fn confirmed_scrub_then_restore() {
    let dir = vault();
    let d = dir.path();
    let out = u2(
        d,
        &[
            "forget",
            "ent_a",
            "--scrub-history",
            "--confirm-scrub",
            "people/a.md",
        ],
    );
    let t = text(&out);
    assert!(out.status.success(), "{t}");
    assert!(
        t.contains("safety backup") && t.contains("--restore-scrub"),
        "{t}"
    );
    assert_eq!(
        git(d, &["log", "--branches", "--format=%H", "-S", "HUSH"]),
        ""
    );

    let id = t
        .split("scrub-backup/")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .unwrap()
        .to_string();
    let out = u2(d, &["forget", "--restore-scrub", &id]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(!git(d, &["log", "--branches", "--format=%H", "-S", "HUSH"]).is_empty());
}
