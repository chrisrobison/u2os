//! `forget` and the explicit history scrub. Every test builds its own
//! temporary repository with isolated git config; nothing touches a real
//! vault, a real home, or the network.

use majordomo::git::{forget, restore_scrub_backup, Git, ScrubRequest};
use std::fs;
use std::path::Path;
use std::process::Command;

const TOKEN: &str = "SECRETTOKEN-4711";

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

fn commit_all(dir: &Path, msg: &str) {
    run(dir, &["add", "-A"]);
    run(dir, &["commit", "-q", "-m", msg]);
}

/// alice (id ent_a, holds TOKEN) is renamed to ally; a side branch and two
/// tags also hold her; bob is unrelated.
fn repo() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("mjf").tempdir().unwrap();
    let d = dir.path();
    run(d, &["init", "-q", "-b", "main"]);
    write(
        d,
        "people/alice.md",
        &format!("---\nid: ent_a\nname: Alice\n---\n{TOKEN}\n"),
    );
    write(d, "people/bob.md", "---\nid: ent_b\nname: Bob\n---\nbob\n");
    commit_all(d, "start");
    run(d, &["tag", "v1"]);
    run(d, &["checkout", "-q", "-b", "side"]);
    write(
        d,
        "people/alice.md",
        &format!("---\nid: ent_a\nname: Alice\n---\n{TOKEN} side\n"),
    );
    commit_all(d, "side edit");
    run(d, &["checkout", "-q", "main"]);
    run(d, &["mv", "people/alice.md", "people/ally.md"]);
    write(
        d,
        "people/ally.md",
        &format!("---\nid: ent_a\nname: Ally\n---\n{TOKEN} renamed and rewritten\nmore\nlines\n"),
    );
    commit_all(d, "rename");
    run(d, &["tag", "-a", "v2", "-m", "annotated"]);
    dir
}

fn head(d: &Path) -> String {
    run(d, &["rev-parse", "HEAD"])
}

fn count(d: &Path) -> usize {
    run(d, &["rev-list", "--count", "HEAD"]).parse().unwrap()
}

fn all_refs(d: &Path) -> String {
    run(d, &["for-each-ref", "--format=%(refname) %(objectname)"])
}

/// Does any branch, tag or remote-tracking ref (not Majordomo's backups) hold
/// the token anywhere in its history?
fn history_has_token(d: &Path) -> bool {
    !run(
        d,
        &[
            "log",
            "--branches",
            "--tags",
            "--remotes",
            "--format=%H",
            "-S",
            TOKEN,
        ],
    )
    .is_empty()
}

fn confirm(p: &str) -> ScrubRequest {
    ScrubRequest {
        confirm: Some(p.to_string()),
        acknowledge_remotes: false,
    }
}

fn refused(d: &Path, key: &str, scrub: Option<&ScrubRequest>) -> String {
    let before = (all_refs(d), run(d, &["status", "--porcelain"]));
    let err = forget(&git_for(d), key, scrub).unwrap_err().to_string();
    assert_eq!(
        before,
        (all_refs(d), run(d, &["status", "--porcelain"])),
        "a refusal must change nothing"
    );
    err
}

#[test]
fn forget_by_path_removes_checks_in_and_history_keeps_it() {
    let dir = repo();
    let d = dir.path();
    let before = count(d);
    let r = forget(&git_for(d), "people/bob.md", None).unwrap();
    assert!(r.removed && !r.history_scrubbed);
    assert!(!d.join("people/bob.md").exists());
    assert_eq!(count(d), before + 1);
    assert_eq!(
        run(d, &["log", "-1", "--format=%s"]),
        "vault: remove people/bob.md"
    );
    assert_eq!(r.commit.as_deref(), Some(head(d).as_str()));
    assert_eq!(run(d, &["status", "--porcelain"]), "");
    // history still holds it
    assert!(run(d, &["show", "HEAD~1:people/bob.md"]).contains("bob"));
    let text = r.notices.join("\n");
    assert!(
        text.contains("Git history still holds the removed material"),
        "{text}"
    );
    assert!(text.contains("unaffected"), "{text}");
    assert!(r.scrub.is_none());
}

#[test]
fn forget_by_id_and_absolute_path() {
    let dir = repo();
    let d = dir.path();
    let r = forget(&git_for(d), "ent_b", None).unwrap();
    assert_eq!(r.path, "people/bob.md");
    assert_eq!(r.id.as_deref(), Some("ent_b"));
    assert!(!d.join("people/bob.md").exists());

    let abs = fs::canonicalize(d).unwrap().join("people/ally.md");
    let r = forget(&git_for(d), abs.to_str().unwrap(), None).unwrap();
    assert_eq!(r.path, "people/ally.md");
}

#[test]
fn pending_edits_are_checked_in_separately_first() {
    let dir = repo();
    let d = dir.path();
    write(
        d,
        "people/bob.md",
        "---\nid: ent_b\nname: Bob\n---\nedited elsewhere\n",
    );
    write(d, "notes.txt", "x\n");
    let before = count(d);
    forget(&git_for(d), "ent_b", None).unwrap();
    assert_eq!(count(d), before + 2);
    // the edit made elsewhere is recoverable
    assert!(run(d, &["show", "HEAD~1:people/bob.md"]).contains("edited elsewhere"));
    assert_eq!(
        run(d, &["log", "-1", "--format=%s"]),
        "vault: remove people/bob.md"
    );
}

#[test]
fn refusals_leave_everything_alone() {
    let dir = repo();
    let d = dir.path();
    write(d, "notes/x.md", "---\nid: ent_n\n---\n");
    write(d, "people/.hidden.md", "---\nid: ent_h\n---\n");
    write(d, "people/a.txt", "t\n");
    write(d, "people/sub/deep.md", "---\nid: ent_d\n---\n");
    write(d, "me.md", "---\nname: Me\n---\n");
    commit_all(d, "more");
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "people/evil.md", "---\nid: ent_e\n---\n");
    std::os::unix::fs::symlink(
        outside.path().join("people/evil.md"),
        d.join("people/link.md"),
    )
    .unwrap();
    commit_all(d, "link");

    for (key, needle) in [
        ("../outside.md", "invalid vault path"),
        ("people/../me.md", "invalid vault path"),
        ("notes/x.md", "not a vault record"),
        ("people/.hidden.md", "not a vault record"),
        ("people/a.txt", "not a vault record"),
        ("people/sub/deep.md", "not a vault record"),
        ("me.md", "owner record"),
        ("people/link.md", "symlink"),
        ("people/nobody.md", "no such record"),
        ("ent_unknown", "no record has the id"),
    ] {
        let msg = refused(d, key, None);
        assert!(msg.contains(needle), "{key}: {msg}");
    }
    let abs = outside.path().join("people/evil.md");
    let msg = refused(d, abs.to_str().unwrap(), None);
    assert!(msg.contains("outside the vault"), "{msg}");
    assert!(outside.path().join("people/evil.md").exists());
    assert!(d.join("people/bob.md").exists());
}

#[test]
fn symlinked_collection_dir_is_refused() {
    let dir = repo();
    let d = dir.path();
    let other = tempfile::tempdir().unwrap();
    write(other.path(), "z.md", "---\nid: ent_z\n---\n");
    std::os::unix::fs::symlink(other.path(), d.join("projects")).unwrap();
    let msg = refused(d, "projects/z.md", None);
    assert!(msg.contains("symlink"), "{msg}");
    assert!(other.path().join("z.md").exists());
}

#[test]
fn ambiguous_id_is_refused() {
    let dir = repo();
    let d = dir.path();
    write(
        d,
        "people/bob2.md",
        "---\nid: ent_b\nname: Other Bob\n---\n",
    );
    commit_all(d, "dup");
    let msg = refused(d, "ent_b", None);
    assert!(msg.contains("ambiguous"), "{msg}");
    assert!(d.join("people/bob.md").exists() && d.join("people/bob2.md").exists());
}

#[test]
fn ignored_record_is_not_removed() {
    let dir = repo();
    let d = dir.path();
    write(d, ".gitignore", "people/secret.md\n");
    write(d, "people/secret.md", "---\nid: ent_s\n---\nonly here\n");
    commit_all(d, "ignore");
    let msg = refused(d, "people/secret.md", None);
    assert!(msg.contains("not tracked"), "{msg}");
    assert!(d.join("people/secret.md").exists());
}

#[test]
fn not_a_repository_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "people/a.md", "---\nid: ent_a\n---\n");
    let err = forget(&git_for(dir.path()), "people/a.md", None)
        .unwrap_err()
        .to_string();
    assert!(err.contains("not a git repository"), "{err}");
    assert!(dir.path().join("people/a.md").exists());
}

#[test]
fn operation_in_progress_is_refused() {
    let dir = repo();
    let d = dir.path();
    fs::write(d.join(".git/MERGE_HEAD"), format!("{}\n", head(d))).unwrap();
    let msg = refused(d, "ent_b", None);
    assert!(msg.contains("merge is in progress"), "{msg}");
    assert!(d.join("people/bob.md").exists());
}

#[test]
fn scrub_needs_exact_confirmation_and_changes_nothing_without_it() {
    let dir = repo();
    let d = dir.path();
    let none = ScrubRequest::default();
    let msg = refused(d, "ent_a", Some(&none));
    assert!(msg.contains("confirmation is required"), "{msg}");
    assert!(msg.contains("--confirm-scrub people/ally.md"), "{msg}");
    assert!(
        msg.contains("people/alice.md"),
        "plan lists the rename trail: {msg}"
    );
    for wrong in [
        "ent_a",
        "people/alice.md",
        "people/ally.md ",
        "",
        "yes",
        "people/*",
    ] {
        let msg = refused(d, "ent_a", Some(&confirm(wrong)));
        assert!(msg.contains("must exactly equal"), "{wrong:?}: {msg}");
    }
    assert!(d.join("people/ally.md").exists());
    assert!(history_has_token(d));
    assert!(raw(d, &["for-each-ref", "refs/majordomo"])
        .stdout
        .is_empty());
}

#[test]
fn scrub_removes_the_record_and_its_rename_trail_from_every_ref() {
    let dir = repo();
    let d = dir.path();
    assert!(history_has_token(d));
    let old_blob = run(d, &["rev-parse", "v1:people/alice.md"]);
    let bob_before = run(d, &["log", "--all", "--format=%s", "--", "people/bob.md"]);
    let old_refs = all_refs(d);

    let r = forget(&git_for(d), "ent_a", Some(&confirm("people/ally.md"))).unwrap();
    let s = r.scrub.as_ref().unwrap();
    assert!(r.history_scrubbed && r.removed && s.verified);
    assert!(s.paths.contains(&"people/ally.md".to_string()));
    assert!(s.paths.contains(&"people/alice.md".to_string()));

    // gone from every branch and tag, including side and the annotated tag
    assert!(!history_has_token(d));
    assert!(!d.join("people/ally.md").exists());
    for rev in ["main", "side", "v1", "v2"] {
        assert_eq!(
            run(
                d,
                &[
                    "log",
                    rev,
                    "--format=%H",
                    "--",
                    "people/alice.md",
                    "people/ally.md"
                ]
            ),
            "",
            "{rev}"
        );
    }
    // unrelated record and branch names survive
    assert_eq!(
        bob_before,
        run(
            d,
            &[
                "log",
                "--exclude=refs/majordomo/*",
                "--all",
                "--format=%s",
                "--",
                "people/bob.md"
            ]
        )
    );
    assert!(run(d, &["show", "main:people/bob.md"]).contains("bob"));
    assert_eq!(run(d, &["status", "--porcelain"]), "");
    assert_eq!(run(d, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    // filter-branch leftovers are gone
    assert_eq!(run(d, &["for-each-ref", "refs/original"]), "");
    assert!(!d.join(".git-rewrite").exists());

    // backup exists and still has the old history
    let backup = format!("refs/majordomo/scrub-backup/{}/heads/main", s.backup_id);
    assert!(run(d, &["log", &backup, "--format=%H", "-S", TOKEN]).len() > 10);
    assert!(raw(d, &["cat-file", "-e", &old_blob]).status.success());
    let text = r.notices.join("\n");
    assert!(
        text.contains("safety backup") && text.contains("--restore-scrub"),
        "{text}"
    );

    // restore brings everything back
    let n = restore_scrub_backup(&git_for(d), &s.backup_id).unwrap();
    assert_eq!(n, s.backup_refs);
    let restored = all_refs(d);
    // everything except main (which also gained the removal commit) is as before
    for line in old_refs.lines().filter(|l| !l.contains("refs/heads/main")) {
        assert!(restored.contains(line), "{line} not restored");
    }
    assert_eq!(
        run(d, &["log", "-1", "--format=%s", "main"]),
        "vault: remove people/ally.md"
    );
    assert!(history_has_token(d));
    assert_eq!(run(d, &["status", "--porcelain"]), "");
}

#[test]
fn scrub_really_erases_once_the_backup_is_deleted() {
    let dir = repo();
    let d = dir.path();
    let old_blob = run(d, &["rev-parse", "v1:people/alice.md"]);
    let r = forget(&git_for(d), "ent_a", Some(&confirm("people/ally.md"))).unwrap();
    let id = r.scrub.unwrap().backup_id;
    let prefix = format!("refs/majordomo/scrub-backup/{id}/");
    for name in run(d, &["for-each-ref", "--format=%(refname)", &prefix]).lines() {
        run(d, &["update-ref", "-d", name]);
    }
    run(d, &["reflog", "expire", "--expire=now", "--all"]);
    run(d, &["gc", "--prune=now", "-q"]);
    assert!(!raw(d, &["cat-file", "-e", &old_blob]).status.success());
}

#[test]
fn scrub_of_an_already_removed_record_by_path_follows_its_trail() {
    let dir = repo();
    let d = dir.path();
    forget(&git_for(d), "ent_a", None).unwrap();
    assert!(history_has_token(d));
    // an id cannot name a removed record; its path can
    let msg = refused(d, "ent_a", Some(&confirm("people/ally.md")));
    assert!(msg.contains("no record has the id"), "{msg}");
    let r = forget(
        &git_for(d),
        "people/ally.md",
        Some(&confirm("people/ally.md")),
    )
    .unwrap();
    assert!(!r.removed && r.history_scrubbed);
    assert_eq!(r.id.as_deref(), Some("ent_a"));
    assert!(!history_has_token(d));
}

#[test]
fn scrub_refuses_a_dirty_tree() {
    let dir = repo();
    let d = dir.path();
    write(d, "scratch.txt", "x");
    let msg = refused(d, "ent_a", Some(&confirm("people/ally.md")));
    assert!(msg.contains("uncommitted changes"), "{msg}");
    fs::remove_file(d.join("scratch.txt")).unwrap();
    write(d, "people/bob.md", "---\nid: ent_b\n---\nchanged\n");
    let msg = refused(d, "ent_a", Some(&confirm("people/ally.md")));
    assert!(msg.contains("uncommitted changes"), "{msg}");
    assert!(d.join("people/ally.md").exists());
}

#[test]
fn scrub_refuses_a_trail_path_that_is_in_use_again() {
    let dir = repo();
    let d = dir.path();
    write(
        d,
        "people/alice.md",
        "---\nid: ent_new\nname: Another Alice\n---\n",
    );
    commit_all(d, "reuse the name");
    let msg = refused(d, "ent_a", Some(&confirm("people/ally.md")));
    assert!(msg.contains("exists in the vault now"), "{msg}");
}

/// A bare repository next to the vault, pushed to by the test only.
fn with_remote(d: &Path) -> tempfile::TempDir {
    let remote = tempfile::Builder::new().prefix("mjr").tempdir().unwrap();
    run(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    run(
        d,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    run(d, &["push", "-q", "origin", "--all"]);
    run(d, &["push", "-q", "origin", "--tags"]);
    remote
}

#[test]
fn scrub_with_a_remote_needs_acknowledgement_and_never_touches_it() {
    let dir = repo();
    let d = dir.path();
    let remote = with_remote(d);
    let remote_before = all_refs(remote.path());
    let remote_files = run(remote.path(), &["count-objects", "-v"]);

    let msg = refused(d, "ent_a", Some(&confirm("people/ally.md")));
    assert!(
        msg.contains("remote(s) (origin)") && msg.contains("--acknowledge-remotes"),
        "{msg}"
    );
    assert_eq!(remote_before, all_refs(remote.path()));

    let req = ScrubRequest {
        confirm: Some("people/ally.md".into()),
        acknowledge_remotes: true,
    };
    let r = forget(&git_for(d), "ent_a", Some(&req)).unwrap();
    assert!(r.history_scrubbed);
    let text = r.notices.join("\n");
    assert!(
        text.contains("Remote copies are NOT erased") && text.contains("origin"),
        "{text}"
    );
    assert!(text.contains("never pushes"), "{text}");
    // the remote is exactly as it was: same refs, same objects, still has it
    assert_eq!(remote_before, all_refs(remote.path()));
    assert_eq!(remote_files, run(remote.path(), &["count-objects", "-v"]));
    assert!(!run(remote.path(), &["log", "main", "--format=%H", "-S", TOKEN]).is_empty());
}

#[test]
fn plain_forget_with_an_unreachable_remote_never_uses_it() {
    let dir = repo();
    let d = dir.path();
    // If anything tried to fetch or push, this would fail or hang.
    run(
        d,
        &["remote", "add", "origin", "/nonexistent/never/there.git"],
    );
    let r = forget(&git_for(d), "ent_b", None).unwrap();
    assert_eq!(r.remotes, vec!["origin".to_string()]);
    assert!(r
        .notices
        .join("\n")
        .contains("never pushes or contacts a remote"));
}

#[test]
fn vault_inside_a_larger_repository_is_refused() {
    let outer = tempfile::Builder::new().prefix("mjo").tempdir().unwrap();
    let o = outer.path();
    run(o, &["init", "-q", "-b", "main"]);
    write(
        o,
        "vault/people/a.md",
        &format!("---\nid: ent_a\n---\n{TOKEN}\n"),
    );
    write(o, "code/app.txt", "app\n");
    commit_all(o, "all");
    let vault = o.join("vault");
    let before = all_refs(o);
    for scrub in [None, Some(confirm("people/a.md"))] {
        let err = forget(&git_for(&vault), "people/a.md", scrub.as_ref())
            .unwrap_err()
            .to_string();
        assert!(err.contains("larger repository"), "{err}");
    }
    assert!(vault.join("people/a.md").exists());
    assert_eq!(before, all_refs(o));
    assert_eq!(run(o, &["status", "--porcelain"]), "");
    assert!(o.join("code/app.txt").exists());
}

#[test]
fn a_failed_rewrite_leaves_the_backup_and_puts_everything_back() {
    use std::os::unix::fs::PermissionsExt;
    let uid = Command::new("id").arg("-u").output().unwrap();
    if String::from_utf8_lossy(&uid.stdout).trim() == "0" {
        eprintln!("running as root: permissions cannot make git fail; skipping");
        return;
    }
    let dir = repo();
    let d = dir.path();
    // Remove first, so the failure happens during the rewrite itself.
    forget(&git_for(d), "ent_a", None).unwrap();
    let refs_before = all_refs(d);
    let head_before = head(d);

    // Make the object store unwritable so the rewrite cannot create commits.
    let objects = d.join(".git/objects");
    let set = |mode: u32| {
        let mut stack = vec![objects.clone()];
        while let Some(p) = stack.pop() {
            if p.is_dir() {
                if mode == 0o555 {
                    for e in fs::read_dir(&p).unwrap() {
                        stack.push(e.unwrap().path());
                    }
                    fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
                } else {
                    fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
                    for e in fs::read_dir(&p).unwrap() {
                        stack.push(e.unwrap().path());
                    }
                }
            }
        }
    };
    set(0o555);
    let result = forget(
        &git_for(d),
        "people/ally.md",
        Some(&confirm("people/ally.md")),
    );
    set(0o755);

    let err = result.unwrap_err().to_string();
    assert!(err.contains("history rewrite failed"), "{err}");
    assert!(
        err.contains("refs/majordomo/scrub-backup/") && err.contains("--restore-scrub"),
        "{err}"
    );
    assert!(err.contains("put back"), "{err}");
    // refs exactly as before, tree consistent, no leftovers, backup intact
    let after = all_refs(d);
    for line in refs_before.lines() {
        assert!(after.contains(line), "{line} changed");
    }
    assert_eq!(head(d), head_before);
    assert_eq!(run(d, &["status", "--porcelain"]), "");
    assert!(!d.join(".git-rewrite").exists());
    assert_eq!(run(d, &["for-each-ref", "refs/original"]), "");
    let backups = run(
        d,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/majordomo/scrub-backup",
        ],
    );
    assert!(backups.contains("/heads/main"), "{backups}");
    assert!(history_has_token(d));

    // and the owner can still try again
    forget(
        &git_for(d),
        "people/ally.md",
        Some(&confirm("people/ally.md")),
    )
    .unwrap();
    assert!(!history_has_token(d));
}

#[test]
fn restore_refuses_bad_ids_and_dirty_trees() {
    let dir = repo();
    let d = dir.path();
    assert!(restore_scrub_backup(&git_for(d), "../x").is_err());
    assert!(restore_scrub_backup(&git_for(d), "20990101000000")
        .unwrap_err()
        .to_string()
        .contains("no scrub backup"));
    write(d, "x.txt", "x");
    assert!(restore_scrub_backup(&git_for(d), "20990101000000")
        .unwrap_err()
        .to_string()
        .contains("uncommitted"));
}
