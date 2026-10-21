//! Repository detection and health.

use super::Git;
use crate::error::Result;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub git_version: String,
    /// The vault is inside a Git work tree.
    pub present: bool,
    pub toplevel: Option<String>,
    /// The vault directory is the repository's top level. Majordomo only ever
    /// acts on a repository it is the root of, never on a larger one that
    /// happens to contain the vault.
    pub is_vault_root: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    /// The repository has no commits yet.
    pub unborn: bool,
    pub commits: Option<u64>,
    pub staged: usize,
    pub modified: usize,
    pub untracked: usize,
    pub unmerged: usize,
    /// `merge`, `rebase`, `cherry-pick`, `revert` or `bisect` in progress.
    pub operation: Option<String>,
    pub shallow: bool,
    /// Remote names only. URLs can carry credentials and are never reported.
    pub remotes: Vec<String>,
    pub identity_configured: bool,
    pub warnings: Vec<String>,
}

impl Health {
    pub fn inspect(git: &Git) -> Result<Health> {
        let mut h = Health {
            git_version: git.version()?,
            ..Health::default()
        };

        let top = git.run(&["rev-parse", "--show-toplevel"])?;
        if top.code != 0 {
            if top.stderr.contains("dubious ownership") {
                h.warnings.push("git refuses this directory (safe.directory); the vault is owned by another user".into());
            }
            return Ok(h);
        }
        h.present = true;
        let toplevel = String::from_utf8_lossy(&top.stdout).trim().to_string();
        h.is_vault_root = same_dir(Path::new(&toplevel), git.root());
        h.toplevel = Some(toplevel);

        let git_dir = git
            .run_text(&["rev-parse", "--absolute-git-dir"])?
            .trim()
            .to_string();
        h.shallow = git
            .run_text(&["rev-parse", "--is-shallow-repository"])?
            .trim()
            == "true";

        let status = git.run_ok(&["status", "--porcelain=v2", "--branch", "-z"])?;
        parse_status(&String::from_utf8_lossy(&status), &mut h);

        if !h.unborn {
            h.commits = git
                .run_text(&["rev-list", "--count", "HEAD"])
                .ok()
                .and_then(|s| s.trim().parse().ok());
        }
        h.remotes = git
            .run_text(&["remote"])?
            .lines()
            .map(str::to_string)
            .collect();
        h.identity_configured = ["user.name", "user.email"].iter().all(|k| {
            git.run(&["config", "--get", k])
                .is_ok_and(|o| o.code == 0 && !o.stdout.is_empty())
        });
        h.operation = in_progress(Path::new(&git_dir));

        if !h.is_vault_root {
            h.warnings.push(
                "the vault is inside a larger repository; Majordomo will not commit to it".into(),
            );
        }
        if h.unborn {
            h.warnings.push("the repository has no commits yet".into());
        }
        if h.detached {
            h.warnings.push("HEAD is detached".into());
        }
        if let Some(op) = &h.operation {
            h.warnings.push(format!("a {op} is in progress"));
        }
        if h.unmerged > 0 {
            h.warnings
                .push(format!("{} file(s) have unresolved conflicts", h.unmerged));
        }
        if h.shallow {
            h.warnings
                .push("shallow clone: history is incomplete".into());
        }
        if !h.identity_configured {
            h.warnings
                .push("git user.name/user.email are not set".into());
        }
        Ok(h)
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn in_progress(git_dir: &Path) -> Option<String> {
    [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ]
    .iter()
    .find(|(name, _)| git_dir.join(name).exists())
    .map(|(_, op)| (*op).to_string())
}

/// `git status --porcelain=v2 --branch -z`.
fn parse_status(text: &str, h: &mut Health) {
    let mut tokens = text.split('\0');
    while let Some(t) = tokens.next() {
        if let Some(rest) = t.strip_prefix("# branch.oid ") {
            if rest == "(initial)" {
                h.unborn = true;
            } else {
                h.head = Some(rest.to_string());
            }
        } else if let Some(rest) = t.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                h.detached = true;
            } else {
                h.branch = Some(rest.to_string());
            }
        } else if t.starts_with("1 ") || t.starts_with("2 ") {
            let xy = t.as_bytes().get(2..4).unwrap_or(b"..");
            if xy[0] != b'.' {
                h.staged += 1;
            }
            if xy[1] != b'.' {
                h.modified += 1;
            }
            if t.starts_with("2 ") {
                tokens.next(); // original path of a rename
            }
        } else if t.starts_with("u ") {
            h.unmerged += 1;
        } else if t.starts_with("? ") {
            h.untracked += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let text = "# branch.oid abc123\0# branch.head main\0# branch.ab +0 -0\0\
                    1 .M N... 100644 100644 100644 a b people/a.md\0\
                    1 M. N... 100644 100644 100644 a b people/b.md\0\
                    2 R. N... 100644 100644 100644 a b R100 people/new.md\0people/old.md\0\
                    u UU N... 100644 100644 100644 100644 a b c people/c.md\0\
                    ? notes.txt\0! ignored.log\0";
        let mut h = Health::default();
        parse_status(text, &mut h);
        assert_eq!(
            (h.head.as_deref(), h.branch.as_deref()),
            (Some("abc123"), Some("main"))
        );
        assert_eq!(
            (h.staged, h.modified, h.unmerged, h.untracked),
            (2, 1, 1, 1)
        );
        assert!(!h.unborn && !h.detached);
    }

    #[test]
    fn unborn_and_detached() {
        let mut h = Health::default();
        parse_status("# branch.oid (initial)\0# branch.head (detached)\0", &mut h);
        assert!(h.unborn && h.detached && h.head.is_none() && h.branch.is_none());
    }
}
