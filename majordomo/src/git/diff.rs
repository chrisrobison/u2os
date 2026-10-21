//! Revision resolution and read-only diffs.

use super::{validate_path, Git};
use crate::date;
use crate::error::{Error, Result};
use serde::Serialize;

const MAX_PATCH_BYTES: usize = 1 << 20;

/// A point in history: a commit id, or "the last commit at or before a time".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevSpec {
    Commit(String),
    At(String),
}

impl RevSpec {
    /// A hex commit id (7-64 characters) or a date accepted by [`crate::date`].
    pub fn parse(input: &str) -> Result<RevSpec> {
        let hex = (7..=64).contains(&input.len()) && input.bytes().all(|b| b.is_ascii_hexdigit());
        if hex {
            return Ok(RevSpec::Commit(input.to_ascii_lowercase()));
        }
        date::normalize(input).map(RevSpec::At)
    }
}

/// The commit a spec denotes, or `None` if the time precedes every commit.
pub fn resolve_rev(git: &Git, spec: &RevSpec) -> Result<Option<String>> {
    match spec {
        RevSpec::Commit(hex) => {
            let arg = format!("{hex}^{{commit}}");
            let out = git.run(&["rev-parse", "--verify", "--quiet", &arg])?;
            if out.code != 0 {
                return Err(Error::Invalid(format!("no such commit: {hex}")));
            }
            Ok(Some(
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            ))
        }
        RevSpec::At(ts) => {
            let before = format!("--before={ts}");
            let out = git.run(&["rev-list", "-1", &before, "HEAD"])?;
            if out.code != 0 {
                // An unborn HEAD has nothing before any time.
                return Ok(None);
            }
            let commit = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok((!commit.is_empty()).then_some(commit))
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    /// Commit compared from; `None` means the record did not exist yet.
    pub base: Option<String>,
    /// Commit compared to; `None` means the working tree.
    pub until: Option<String>,
    pub patch: String,
    pub truncated: bool,
}

/// What changed in `paths` from `since` to `until` (default: the working tree).
/// Read-only: it neither refreshes the index nor runs configured diff programs.
pub fn diff_paths(
    git: &Git,
    paths: &[String],
    since: &RevSpec,
    until: Option<&RevSpec>,
) -> Result<DiffResult> {
    for p in paths {
        validate_path(p)?;
    }
    let base = resolve_rev(git, since)?;
    let base_arg = match &base {
        Some(c) => c.clone(),
        None => git
            .run_text(&["hash-object", "-t", "tree", "/dev/null"])?
            .trim()
            .to_string(),
    };
    let until_commit = match until {
        Some(spec) => Some(
            resolve_rev(git, spec)?
                .ok_or_else(|| Error::Invalid("no commit at or before the end date".into()))?,
        ),
        None => None,
    };

    let mut args: Vec<&str> = vec![
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        "--relative",
        &base_arg,
    ];
    if let Some(u) = &until_commit {
        args.push(u);
    }
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    let out = git.run_ok(&args)?;

    let mut patch = String::from_utf8_lossy(&out).into_owned();
    let truncated = patch.len() > MAX_PATCH_BYTES;
    if truncated {
        let mut cut = MAX_PATCH_BYTES;
        while !patch.is_char_boundary(cut) {
            cut -= 1;
        }
        patch.truncate(cut);
    }
    Ok(DiffResult {
        base,
        until: until_commit,
        patch,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rev_specs() {
        assert_eq!(
            RevSpec::parse("ABCDEF1").unwrap(),
            RevSpec::Commit("abcdef1".into())
        );
        assert_eq!(
            RevSpec::parse("2025-06-01").unwrap(),
            RevSpec::At("2025-06-01T23:59:59Z".into())
        );
        assert!(RevSpec::parse("HEAD").is_err());
        assert!(RevSpec::parse("--output=/tmp/x").is_err());
        assert!(RevSpec::parse("main").is_err());
    }
}
