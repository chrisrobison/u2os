//! Check the vault's working tree in to its own Git repository.
//!
//! The owner's decisions: edits made outside U2OS are pulled in and committed;
//! when a path is in conflict, the *current* content wins and conflict-marker
//! text is never committed; nothing is ever pushed, and history is never
//! rewritten. Majordomo only acts when the vault directory is the repository's
//! top level and HEAD is on a branch.
//!
//! The commit runs unattended, so it never signs, never runs user hooks and
//! never prompts. It uses the owner's configured identity, falling back to a
//! Majordomo author only when none is set.

use super::{Git, Health};
use crate::error::{Error, Result};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Duration;

/// Conflicted files larger than this are not scanned for markers.
const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;
const CHECKIN_TIMEOUT: Duration = Duration::from_secs(120);
const BODY_LINES: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckinStatus {
    /// A commit was made.
    Committed,
    /// Nothing to check in.
    Clean,
    /// Majordomo declined to act; `reason` says why.
    Skipped,
    /// Another git process holds the index lock; try again shortly.
    Busy,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckinResult {
    pub status: CheckinStatus,
    pub commit: Option<String>,
    /// Files in the commit.
    pub files: usize,
    /// Paths that were in conflict and were resolved to their current content.
    pub resolved_conflicts: Vec<String>,
    pub reason: Option<String>,
}

impl CheckinResult {
    fn of(status: CheckinStatus, reason: Option<String>) -> Self {
        CheckinResult {
            status,
            commit: None,
            files: 0,
            resolved_conflicts: Vec::new(),
            reason,
        }
    }
    fn skipped(reason: impl Into<String>) -> Self {
        Self::of(CheckinStatus::Skipped, Some(reason.into()))
    }
    fn busy() -> Self {
        Self::of(
            CheckinStatus::Busy,
            Some("another git process is using the repository (index.lock)".into()),
        )
    }
}

/// Commit everything dirty in the vault. Safe to call at any time and from
/// several places: git's own index lock serialises writers, and a locked index
/// is reported as [`CheckinStatus::Busy`] rather than waited on or removed.
pub fn checkin(git: &Git) -> Result<CheckinResult> {
    let git = &git.clone().with_timeout(CHECKIN_TIMEOUT);
    let health = Health::inspect(git)?;
    if !health.present {
        return Ok(CheckinResult::skipped("the vault is not a git repository"));
    }
    if !health.is_vault_root {
        return Ok(CheckinResult::skipped(
            "the vault is inside a larger repository; Majordomo only commits to a repository it is the root of",
        ));
    }
    if health.detached {
        return Ok(CheckinResult::skipped(
            "HEAD is detached; a commit here would not belong to any branch",
        ));
    }
    let concluding_merge = match health.operation.as_deref() {
        None => false,
        Some("merge") => true,
        Some(other) => {
            return Ok(CheckinResult::skipped(format!(
                "a {other} is in progress; finish or abort it first"
            )))
        }
    };

    let git_dir = git
        .run_text(&["rev-parse", "--absolute-git-dir"])?
        .trim()
        .to_string();
    if Path::new(&git_dir).join("index.lock").exists() {
        return Ok(CheckinResult::busy());
    }

    let resolved = match resolve_conflicts(git)? {
        Resolution::Done(paths) => paths,
        Resolution::Busy => return Ok(CheckinResult::busy()),
        Resolution::Unresolvable(path) => {
            return Ok(CheckinResult::skipped(format!(
                "{path} is in conflict and has no current version to keep; resolve it by hand"
            )))
        }
    };

    let add = git.run(&["add", "-A", "--", "."])?;
    if add.code != 0 {
        return if is_lock_error(&add.stderr) {
            Ok(CheckinResult::busy())
        } else {
            Err(Error::Git(format!(
                "`git add` failed: {}",
                first_line(&add.stderr)
            )))
        };
    }

    let staged = staged_changes(git)?;
    if staged.is_empty() && !concluding_merge {
        return Ok(CheckinResult::of(CheckinStatus::Clean, None));
    }

    let (subject, body) = message(&staged, &resolved, concluding_merge);
    let mut args: Vec<&str> = Vec::new();
    if !health.identity_configured {
        args.extend([
            "-c",
            "user.name=Majordomo",
            "-c",
            "user.email=majordomo@localhost",
        ]);
    }
    args.extend([
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-verify",
        "-q",
        "-m",
        &subject,
        "-m",
        &body,
    ]);
    let commit = git.run(&args)?;
    if commit.code != 0 {
        return if is_lock_error(&commit.stderr) {
            Ok(CheckinResult::busy())
        } else {
            Err(Error::Git(format!(
                "`git commit` failed: {}",
                first_line(&commit.stderr)
            )))
        };
    }

    let head = git.run_text(&["rev-parse", "HEAD"])?.trim().to_string();
    Ok(CheckinResult {
        status: CheckinStatus::Committed,
        commit: Some(head),
        files: staged.len(),
        resolved_conflicts: resolved,
        reason: None,
    })
}

enum Resolution {
    Done(Vec<String>),
    Busy,
    Unresolvable(String),
}

/// For every unmerged path keep what is on disk now. If the file on disk still
/// carries conflict markers, keep this branch's own version instead, so marker
/// text never reaches a commit.
fn resolve_conflicts(git: &Git) -> Result<Resolution> {
    let listing = git.run_ok(&["ls-files", "-u", "-z"])?;
    let mut paths: Vec<(String, bool)> = Vec::new(); // (path, has "ours" stage)
    for entry in String::from_utf8_lossy(&listing).split('\0') {
        // "<mode> <sha> <stage>\t<path>"
        let Some((meta, path)) = entry.split_once('\t') else {
            continue;
        };
        let stage = meta.rsplit(' ').next().unwrap_or("");
        match paths.iter_mut().find(|(p, _)| p == path) {
            Some(existing) => existing.1 |= stage == "2",
            None => paths.push((path.to_string(), stage == "2")),
        }
    }

    let mut resolved = Vec::new();
    for (path, has_ours) in paths {
        super::validate_path(&path)?;
        let abs = git.root().join(&path);
        let meta = fs::symlink_metadata(&abs).ok();
        let keep_working_tree = match &meta {
            // Deleted on disk: the current content is "gone".
            None => {
                stage_ok(git.run(&["rm", "-q", "--cached", "--", &path])?)?;
                resolved.push(path);
                continue;
            }
            Some(m) if m.file_type().is_file() => !has_markers(&abs, m.len()),
            // A symlink or directory is taken as it stands.
            Some(_) => true,
        };
        if !keep_working_tree {
            if !has_ours {
                return Ok(Resolution::Unresolvable(path));
            }
            let out = git.run(&["checkout", "--ours", "--", &path])?;
            if is_lock_error(&out.stderr) {
                return Ok(Resolution::Busy);
            }
            stage_ok(out)?;
        }
        let out = git.run(&["add", "--", &path])?;
        if is_lock_error(&out.stderr) {
            return Ok(Resolution::Busy);
        }
        stage_ok(out)?;
        resolved.push(path);
    }
    Ok(Resolution::Done(resolved))
}

fn stage_ok(out: super::Output) -> Result<()> {
    if out.code == 0 {
        Ok(())
    } else {
        Err(Error::Git(format!(
            "resolving a conflict failed: {}",
            first_line(&out.stderr)
        )))
    }
}

/// All three marker kinds at the start of a line, as git writes them.
fn has_markers(path: &Path, len: u64) -> bool {
    if len > MAX_SCAN_BYTES {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    let (mut open, mut mid, mut close) = (false, false, false);
    for line in text.lines() {
        open |= line.starts_with("<<<<<<< ") || line == "<<<<<<<";
        mid |= line == "=======";
        close |= line.starts_with(">>>>>>> ") || line == ">>>>>>>";
    }
    open && mid && close
}

#[derive(Debug, Clone)]
struct Staged {
    status: char,
    path: String,
}

fn staged_changes(git: &Git) -> Result<Vec<Staged>> {
    let out = git.run_ok(&[
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "-M",
        "--no-ext-diff",
    ])?;
    let text = String::from_utf8_lossy(&out);
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let mut staged = Vec::new();
    while let Some(status) = tokens.next() {
        let status = status.chars().next().unwrap_or('M');
        let first = tokens.next().unwrap_or("");
        let path = if matches!(status, 'R' | 'C') {
            tokens.next().unwrap_or(first)
        } else {
            first
        };
        staged.push(Staged {
            status,
            path: path.to_string(),
        });
    }
    Ok(staged)
}

fn clean(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

fn verb(c: char) -> &'static str {
    match c {
        'A' => "add",
        'D' => "remove",
        'R' => "rename",
        _ => "update",
    }
}

fn message(staged: &[Staged], resolved: &[String], merge: bool) -> (String, String) {
    let subject = if staged.is_empty() {
        "vault: conclude merge".to_string()
    } else {
        let same = staged.iter().all(|s| s.status == staged[0].status);
        let v = if same {
            verb(staged[0].status)
        } else {
            "update"
        };
        let names: Vec<String> = staged.iter().take(3).map(|s| clean(&s.path)).collect();
        let mut s = format!("vault: {v} {}", names.join(", "));
        if staged.len() > 3 {
            s.push_str(&format!(" and {} more", staged.len() - 3));
        }
        s.chars().take(200).collect()
    };

    let mut body = String::from("Checked in by Majordomo.\n");
    if merge {
        body.push_str("\nThis concludes a merge in progress, keeping the current content.\n");
    }
    if !resolved.is_empty() {
        body.push_str("\nConflicts resolved by keeping the current content:\n");
        for p in resolved.iter().take(BODY_LINES) {
            body.push_str(&format!("  {}\n", clean(p)));
        }
    }
    body.push('\n');
    for s in staged.iter().take(BODY_LINES) {
        body.push_str(&format!("{} {}\n", s.status, clean(&s.path)));
    }
    if staged.len() > BODY_LINES {
        body.push_str(&format!("... and {} more\n", staged.len() - BODY_LINES));
    }
    (subject, body)
}

fn is_lock_error(stderr: &str) -> bool {
    stderr.contains("index.lock") || stderr.contains("Unable to create") && stderr.contains(".lock")
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_need_all_three_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        let write = |t: &str| {
            fs::write(&p, t).unwrap();
            has_markers(&p, t.len() as u64)
        };
        assert!(write("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\nb\n"));
        assert!(!write("a\n<<<<<<< HEAD\nonly one\n"));
        assert!(!write("Setext heading\n=======\ntext\n"));
        assert!(!write("  <<<<<<< indented\n=======\n  >>>>>>> x\n"));
    }

    #[test]
    fn message_names_the_records() {
        let s = |c: char, p: &str| Staged {
            status: c,
            path: p.into(),
        };
        let (subj, body) = message(&[s('M', "people/a.md")], &[], false);
        assert_eq!(subj, "vault: update people/a.md");
        assert!(body.contains("M people/a.md"));
        let many: Vec<Staged> = (0..5).map(|i| s('A', &format!("n/{i}.md"))).collect();
        let (subj, _) = message(&many, &[], false);
        assert_eq!(subj, "vault: add n/0.md, n/1.md, n/2.md and 2 more");
        let (subj, _) = message(&[s('A', "a.md"), s('D', "b.md")], &[], false);
        assert!(subj.starts_with("vault: update "));
        let (subj, body) = message(&[s('M', "bad\nname.md")], &["c.md".into()], false);
        assert!(!subj.contains('\n') && !body.contains("bad\nname"));
        assert!(body.contains("Conflicts resolved"));
    }
}
