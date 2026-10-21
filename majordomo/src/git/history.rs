//! Per-record history that survives renames.

use super::{validate_path, Git};
use crate::error::{Error, Result};
use serde::Serialize;
use std::collections::HashMap;

const MAX_COMMITS: usize = 2000;
const SOURCES: [&str; 4] = ["me.md", "people", "projects", "commitments"];
const FORMAT: &str = "--format=%x1e%H%x1f%an%x1f%at%x1f%aI%x1f%s";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// `A`dded, `M`odified, `D`eleted, `R`enamed, `C`opied or `T`ype change.
    pub status: char,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub commit: String,
    pub author: String,
    /// Author time, seconds since the epoch.
    pub timestamp: i64,
    /// Author time, ISO 8601 with offset.
    pub date: String,
    pub subject: String,
    pub changes: Vec<Change>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// Newest first.
    pub entries: Vec<Entry>,
    /// Every path the record has had.
    pub paths: Vec<String>,
}

/// History of the record currently at (or last known at) `path`.
///
/// `git log --follow` tracks renames by content similarity, which can lose a
/// record that was renamed and heavily edited in one commit. A record whose
/// file carries `id:` therefore also searches history for that id and follows
/// every other path the id appeared under.
pub fn record_history(
    git: &Git,
    path: &str,
    bound_id: Option<&str>,
    limit: usize,
) -> Result<History> {
    validate_path(path)?;
    let mut by_commit: HashMap<String, Entry> = HashMap::new();
    let mut paths: Vec<String> = vec![path.to_string()];

    merge(&mut by_commit, &mut paths, follow(git, path)?);

    if let Some(id) = bound_id {
        for other in paths_mentioning_id(git, id)? {
            if !paths.contains(&other) {
                paths.push(other.clone());
                merge(&mut by_commit, &mut paths, follow(git, &other)?);
            }
        }
    }

    let mut entries: Vec<Entry> = by_commit.into_values().collect();
    entries.sort_by(|a, b| {
        b.timestamp
            .cmp(&a.timestamp)
            .then_with(|| a.commit.cmp(&b.commit))
    });
    if limit > 0 {
        entries.truncate(limit);
    }
    Ok(History { entries, paths })
}

fn follow(git: &Git, path: &str) -> Result<Vec<Entry>> {
    let max = format!("--max-count={MAX_COMMITS}");
    let out = git.run(&[
        "log",
        "-z",
        "--follow",
        "-M",
        "--relative",
        "--name-status",
        FORMAT,
        &max,
        "--",
        path,
    ])?;
    if out.code != 0 {
        if out.stderr.contains("not a git repository") {
            return Err(Error::Invalid("the vault is not a git repository".into()));
        }
        // An empty repository, or a path git has never seen, has no history.
        if out.stderr.contains("does not have any commits")
            || out.stderr.contains("bad default revision")
        {
            return Ok(Vec::new());
        }
        return Err(Error::Git(format!(
            "`git log` failed: {}",
            out.stderr.lines().next().unwrap_or("")
        )));
    }
    Ok(parse_log(&String::from_utf8_lossy(&out.stdout)))
}

fn paths_mentioning_id(git: &Git, id: &str) -> Result<Vec<String>> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::Invalid("malformed record id".into()));
    }
    let pattern = format!("^id:[[:space:]]*[\"']?{id}[\"']?[[:space:]]*$");
    let max = format!("--max-count={MAX_COMMITS}");
    let mut args: Vec<&str> = vec![
        "log",
        "-z",
        "--relative",
        "--name-status",
        FORMAT,
        &max,
        "-G",
        &pattern,
        "--",
    ];
    args.extend(SOURCES);
    let out = git.run(&args)?;
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let mut found: Vec<String> = Vec::new();
    for entry in parse_log(&String::from_utf8_lossy(&out.stdout)) {
        for c in entry.changes {
            for p in [Some(c.path), c.old_path].into_iter().flatten() {
                if validate_path(&p).is_ok() && !found.contains(&p) {
                    found.push(p);
                }
            }
        }
    }
    Ok(found)
}

fn merge(into: &mut HashMap<String, Entry>, paths: &mut Vec<String>, entries: Vec<Entry>) {
    for entry in entries {
        for c in &entry.changes {
            for p in [Some(&c.path), c.old_path.as_ref()].into_iter().flatten() {
                if !paths.contains(p) {
                    paths.push(p.clone());
                }
            }
        }
        match into.get_mut(&entry.commit) {
            Some(existing) => {
                for c in entry.changes {
                    if !existing.changes.contains(&c) {
                        existing.changes.push(c);
                    }
                }
            }
            None => {
                into.insert(entry.commit.clone(), entry);
            }
        }
    }
}

/// Parses `git log -z --name-status` with [`FORMAT`]:
/// `\x1e HASH \x1f NAME \x1f EPOCH \x1f ISO \x1f SUBJECT \0 \n (STATUS \0 PATH \0 [PATH2 \0])*`.
fn parse_log(text: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    for chunk in text.split('\x1e').filter(|c| !c.trim().is_empty()) {
        let mut tokens = chunk.split('\0');
        let Some(header) = tokens.next() else {
            continue;
        };
        let mut f = header.split('\x1f');
        let (Some(commit), Some(author), Some(ts), Some(date), Some(subject)) =
            (f.next(), f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        let mut changes = Vec::new();
        while let Some(raw) = tokens.next() {
            let status_token = raw.trim_start_matches('\n');
            let Some(status) = status_token.chars().next() else {
                continue;
            };
            let Some(path) = tokens.next() else { break };
            if status == 'R' || status == 'C' {
                let Some(new_path) = tokens.next() else { break };
                changes.push(Change {
                    status,
                    path: new_path.to_string(),
                    old_path: Some(path.to_string()),
                });
            } else {
                changes.push(Change {
                    status,
                    path: path.to_string(),
                    old_path: None,
                });
            }
        }
        entries.push(Entry {
            commit: commit.trim().to_string(),
            author: author.to_string(),
            timestamp: ts.parse().unwrap_or(0),
            date: date.to_string(),
            subject: subject.to_string(),
            changes,
        });
    }
    entries
}

/// The vault path (and, if the file carries one, the id) to look up history
/// for. `key` is a record id, or a vault-relative path, which also works for
/// records that have since been deleted.
pub fn target_for(
    index: &crate::memory::MemoryIndex,
    key: &str,
) -> Result<(String, Option<String>)> {
    if let Some(r) = index.get(key).or_else(|| index.vault.by_path(key)) {
        return Ok((r.path.clone(), r.id_from_file.then(|| r.id.clone())));
    }
    if key.ends_with(".md") && validate_path(key).is_ok() {
        return Ok((key.to_string(), None));
    }
    Err(Error::Invalid(format!("no memory with id or path: {key}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_with_renames() {
        let text = "\x1eaaa\x1fAl\x1f200\x1f2026-01-02T00:00:00+00:00\x1fedit\0\nM\0people/b.md\0\
                    \x1ebbb\x1fAl\x1f100\x1f2026-01-01T00:00:00+00:00\x1frename\0\nR100\0people/a.md\0people/b.md\0";
        let entries = parse_log(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].changes,
            vec![Change {
                status: 'M',
                path: "people/b.md".into(),
                old_path: None
            }]
        );
        assert_eq!(
            entries[1].changes[0].old_path.as_deref(),
            Some("people/a.md")
        );
        assert_eq!(entries[1].changes[0].status, 'R');
        assert_eq!(entries[1].timestamp, 100);
    }
}
