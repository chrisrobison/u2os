//! Removing a record, and (only when explicitly asked) scrubbing it from Git
//! history.
//!
//! Removal is an ordinary check-in of a deleted file. Git history keeps the
//! material, and every result says so. Rewriting history happens only through
//! [`ScrubRequest`], which needs an exact confirmation of the record's path,
//! an explicit acknowledgement when remotes exist, a clean tree and a vault
//! that is the root of its own repository. Before any rewrite every ref is
//! saved under `refs/majordomo/scrub-backup/<id>/`; if anything fails the refs
//! are put back and the backup stays. Nothing here ever contacts a remote.

use super::{checkin, validate_path, CheckinStatus, Git, Health};
use crate::error::{Error, Result};
use crate::vault;
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

const COLLECTIONS: [&str; 3] = ["people", "projects", "commitments"];
const BACKUP_NS: &str = "refs/majordomo/scrub-backup";
const SCRUB_TIMEOUT: Duration = Duration::from_secs(900);
/// Same bound as `history::MAX_COMMITS`: a trail this long may be incomplete.
const TRACE_LIMIT: usize = 2000;

/// Explicit request to rewrite history.
#[derive(Debug, Clone, Default)]
pub struct ScrubRequest {
    /// Must equal the record's vault-relative path exactly.
    pub confirm: Option<String>,
    /// Required when the repository has remotes.
    pub acknowledge_remotes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrubReport {
    /// Names the backup: `refs/majordomo/scrub-backup/<id>/...`.
    pub backup_id: String,
    pub backup_refs: usize,
    /// Every historical path removed from history (the rename trail).
    pub paths: Vec<String>,
    pub commits_touching: usize,
    pub refs_rewritten: usize,
    /// No rewritten ref reaches a commit that touches the paths.
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetReport {
    pub path: String,
    pub id: Option<String>,
    /// The file was removed by this call (false if it was already gone).
    pub removed: bool,
    pub commit: Option<String>,
    pub history_scrubbed: bool,
    pub remotes: Vec<String>,
    pub scrub: Option<ScrubReport>,
    /// Plain statements for the owner, to be shown verbatim.
    pub notices: Vec<String>,
}

struct Target {
    path: String,
    id: Option<String>,
    exists: bool,
}

/// Remove the record `key` (id or vault-relative path), check the removal in,
/// and optionally scrub its history. All refusals happen before anything is
/// changed.
pub fn forget(git: &Git, key: &str, scrub: Option<&ScrubRequest>) -> Result<ForgetReport> {
    let git = &git.clone().with_timeout(Duration::from_secs(120));
    let health = Health::inspect(git)?;
    ensure_repo(git, &health, "forget")?;

    let target = resolve(git, key, scrub.is_some())?;
    if !target.exists && scrub.is_none() {
        return Err(Error::Invalid(format!(
            "{} is not in the vault (already removed?). To scrub its history use --scrub-history with its path",
            target.path
        )));
    }

    let plan = match scrub {
        Some(req) => Some(preflight_scrub(git, &health, &target, req)?),
        None => None,
    };

    let mut commit = None;
    if target.exists {
        commit = Some(remove_and_checkin(git, &target.path)?);
    }

    let mut report = ForgetReport {
        path: target.path.clone(),
        id: target.id.clone(),
        removed: target.exists,
        commit,
        history_scrubbed: false,
        remotes: health.remotes.clone(),
        scrub: None,
        notices: Vec::new(),
    };

    match plan {
        None => {
            report.notices.push(retained_notice(&report.path));
            report.notices.push(remote_notice(&health.remotes, false));
        }
        Some(plan) => {
            // The removal commit is part of what gets rewritten, so the trail
            // is re-checked against the tree as it now is.
            ensure_trail_absent(git, &plan.paths, None)?;
            let s = scrub_history(git, plan)?;
            report.history_scrubbed = true;
            report.notices.push(scrub_notice(&s));
            report.notices.push(remote_notice(&health.remotes, true));
            report.scrub = Some(s);
        }
    }
    Ok(report)
}

fn ensure_repo(git: &Git, h: &Health, what: &str) -> Result<()> {
    let no = |why: &str| Err(Error::Invalid(format!("refusing to {what}: {why}")));
    if !h.present {
        return no("the vault is not a git repository (nothing to check the removal in)");
    }
    if !h.is_vault_root {
        return no("the vault is inside a larger repository; Majordomo only acts on a repository it is the root of");
    }
    match fs::symlink_metadata(git.root().join(".git")) {
        Ok(m) if m.is_dir() => {}
        _ => return no("the vault's .git is not a plain directory (linked worktree or submodule)"),
    }
    if h.unborn {
        return no("the repository has no commits yet");
    }
    if h.detached {
        return no("HEAD is detached");
    }
    if let Some(op) = &h.operation {
        return no(&format!("a {op} is in progress; finish or abort it first"));
    }
    if h.unmerged > 0 {
        return no("there are unresolved conflicts");
    }
    Ok(())
}

// ---------------------------------------------------------------- resolving

fn record_shaped(rel: &str) -> bool {
    let mut it = rel.split('/');
    match (it.next(), it.next(), it.next()) {
        (Some(dir), Some(name), None) => {
            COLLECTIONS.contains(&dir)
                && !name.starts_with('.')
                && name.to_lowercase().ends_with(".md")
        }
        _ => false,
    }
}

fn looks_like_id(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 200
        && !key.to_lowercase().ends_with(".md")
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn frontmatter_id(text: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?m)^id:[ \t]*["']?([A-Za-z0-9_-]+)["']?[ \t]*\r?$"#).expect("regex")
    });
    let head: String = text.chars().take(64 * 1024).collect();
    re.captures(&head).map(|c| c[1].to_string())
}

/// Turn what the owner typed into a vault-relative record path.
fn relative_path(root: &Path, key: &str) -> Result<String> {
    if !key.starts_with('/') {
        validate_path(key)?;
        return Ok(key.to_string());
    }
    // An absolute path is accepted only if it is inside this vault.
    let outside = || {
        Error::Invalid(format!(
            "{key} is outside the vault; forget only removes vault records"
        ))
    };
    let p = Path::new(key);
    let (parent, name) = (p.parent().ok_or_else(outside)?, p.file_name());
    let parent = fs::canonicalize(parent).map_err(|_| outside())?;
    let root = fs::canonicalize(root).map_err(|_| outside())?;
    let rel = parent.strip_prefix(&root).map_err(|_| outside())?;
    let name = name.and_then(|n| n.to_str()).ok_or_else(outside)?;
    let rel = if rel.as_os_str().is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", rel.to_str().ok_or_else(outside)?, name)
    };
    validate_path(&rel)?;
    Ok(rel)
}

fn resolve(git: &Git, key: &str, allow_missing: bool) -> Result<Target> {
    let root = git.root();
    let not_record = |p: &str| {
        Error::Invalid(format!(
            "{p} is not a vault record (records are visible .md files directly in people/, projects/ or commitments/)"
        ))
    };

    let path = if looks_like_id(key) {
        let index = vault::scan(root)?;
        let record = index
            .get(key)
            .ok_or_else(|| Error::Invalid(format!("no record has the id {key}")))?;
        let needle = format!("({})", record.path);
        if index
            .invalid
            .iter()
            .any(|f| f.error.starts_with("Another vault file") && f.error.ends_with(&needle))
        {
            return Err(Error::Invalid(format!(
                "the id {key} is ambiguous (several files claim it); use the path"
            )));
        }
        record.path.clone()
    } else {
        relative_path(root, key)?
    };

    if path == "me.md" {
        return Err(Error::Invalid(
            "me.md is the owner record and is not removed by forget".into(),
        ));
    }
    if !record_shaped(&path) {
        return Err(not_record(&path));
    }
    if path.chars().any(char::is_control) {
        return Err(Error::Invalid("path contains control characters".into()));
    }

    // Neither the collection directory nor the file may be a symlink.
    let dir = path.split('/').next().unwrap_or("");
    if fs::symlink_metadata(root.join(dir)).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Error::Invalid(format!("{dir}/ is a symlink; refusing")));
    }
    match fs::symlink_metadata(root.join(&path)) {
        Ok(m) if m.file_type().is_symlink() => {
            Err(Error::Invalid(format!("{path} is a symlink; refusing")))
        }
        Ok(m) if !m.is_file() => Err(not_record(&path)),
        Ok(_) => {
            let text = fs::read(root.join(&path))
                .map(|b| String::from_utf8_lossy(&b[..b.len().min(256 * 1024)]).into_owned())
                .unwrap_or_default();
            Ok(Target {
                id: frontmatter_id(&text),
                path,
                exists: true,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !allow_missing {
                return Err(Error::Invalid(format!("no such record: {path}")));
            }
            Ok(Target {
                id: last_known_id(git, &path),
                path,
                exists: false,
            })
        }
        Err(e) => Err(Error::io(format!("stat {path}"))(e)),
    }
}

/// The `id:` a since-removed file had in the last commit that held it.
fn last_known_id(git: &Git, path: &str) -> Option<String> {
    let commit = git
        .run_text(&["log", "-1", "--format=%H", "--", path])
        .ok()?
        .trim()
        .to_string();
    if commit.is_empty() {
        return None;
    }
    for spec in [format!("{commit}^:{path}"), format!("{commit}:{path}")] {
        if let Ok(text) = git.run_text(&["show", &spec]) {
            if let Some(id) = frontmatter_id(&text) {
                return Some(id);
            }
        }
    }
    None
}

// ------------------------------------------------------------------ removal

/// Check in what is pending, delete the file, check the deletion in. If the
/// deletion cannot be committed the file is put back.
fn remove_and_checkin(git: &Git, path: &str) -> Result<String> {
    let declined = |r: super::CheckinResult| {
        Error::Invalid(format!(
            "nothing was removed: check-in {}: {}",
            if r.status == CheckinStatus::Busy {
                "is busy"
            } else {
                "declined"
            },
            r.reason.unwrap_or_default()
        ))
    };
    // Make sure the record's current content is in history first, so removing
    // the file can always be undone from Git.
    let pre = checkin(git)?;
    if matches!(pre.status, CheckinStatus::Skipped | CheckinStatus::Busy) {
        return Err(declined(pre));
    }
    if git.run(&["ls-files", "--error-unmatch", "--", path])?.code != 0 {
        return Err(Error::Invalid(format!(
            "{path} is not tracked by git (ignored?); removing it would not be recoverable, so it was left alone"
        )));
    }

    fs::remove_file(git.root().join(path)).map_err(Error::io(format!("removing {path}")))?;
    let restore = |why: String| -> Error {
        let _ = git.run(&[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            path,
        ]);
        Error::Invalid(format!("{why}; {path} was restored"))
    };
    match checkin(git) {
        Ok(r) if r.status == CheckinStatus::Committed => Ok(r.commit.unwrap_or_default()),
        Ok(r) => Err(restore(format!(
            "the removal could not be checked in ({})",
            r.reason.unwrap_or_else(|| "no change recorded".into())
        ))),
        Err(e) => Err(restore(format!(
            "the removal could not be checked in ({e})"
        ))),
    }
}

// -------------------------------------------------------------------- scrub

struct Plan {
    paths: Vec<String>,
    commits_touching: usize,
}

fn preflight_scrub(
    git: &Git,
    health: &Health,
    target: &Target,
    req: &ScrubRequest,
) -> Result<Plan> {
    let refuse = |m: String| Err(Error::Invalid(format!("refusing to scrub history: {m}")));
    if health.shallow {
        return refuse("this is a shallow clone; its history is incomplete".into());
    }
    if health.staged + health.modified + health.untracked > 0 {
        return refuse(
            "the working tree has uncommitted changes; run `u2 git checkin` (or discard them) first".into(),
        );
    }
    let history = super::record_history(git, &target.path, target.id.as_deref(), 0)?;
    if history.entries.len() >= TRACE_LIMIT {
        return refuse(format!(
            "this record has {TRACE_LIMIT} or more commits; its trail cannot be traced completely"
        ));
    }
    for p in &history.paths {
        validate_path(p)?;
        if p.chars().any(char::is_control) {
            return refuse("a historical path contains control characters".into());
        }
    }
    let paths = history.paths;
    let listing = paths.join(", ");
    let flag = format!(
        "--scrub-history --confirm-scrub {}{}",
        target.path,
        if health.remotes.is_empty() {
            ""
        } else {
            " --acknowledge-remotes"
        }
    );
    match req.confirm.as_deref() {
        None => {
            return refuse(format!(
                "confirmation is required. This would erase {} commit(s) of history for: {listing}. \
                 Nothing was changed. To proceed, repeat the command with: {flag}",
                history.entries.len()
            ))
        }
        Some(c) if c != target.path => {
            return refuse(format!(
                "--confirm-scrub must exactly equal the record's path ({}); got {c:?}. Nothing was changed",
                target.path
            ))
        }
        Some(_) => {}
    }
    if !health.remotes.is_empty() && !req.acknowledge_remotes {
        return refuse(format!(
            "the repository has remote(s) ({}). Scrubbing rewrites only this local copy; remote and other clones keep the material and a later push would need a force-push, which Majordomo never does. \
             Repeat with --acknowledge-remotes to proceed anyway. Nothing was changed",
            health.remotes.join(", ")
        ));
    }
    if git
        .run(&[
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            "refs/original/",
        ])?
        .stdout
        .iter()
        .any(|b| !b.is_ascii_whitespace())
    {
        return refuse(
            "refs/original/ exists from an earlier filter-branch; remove it first".into(),
        );
    }
    if fs::symlink_metadata(git.root().join(".git-rewrite")).is_ok() {
        return refuse(".git-rewrite exists from an earlier filter-branch; remove it first".into());
    }
    // The record's own file goes away in the removal step; any other trail
    // path still present would be deleted from the tree by the rewrite.
    ensure_trail_absent(git, &paths, Some(&target.path))?;

    let refs = rewritable_refs(git)?;
    if refs.is_empty() {
        return refuse("no branches or tags to rewrite".into());
    }
    let commits_touching = commits_touching(git, &refs, &paths)?;
    Ok(Plan {
        paths,
        commits_touching,
    })
}

fn ensure_trail_absent(git: &Git, paths: &[String], except: Option<&str>) -> Result<()> {
    for p in paths.iter().filter(|p| Some(p.as_str()) != except) {
        let in_head = git.run(&["cat-file", "-e", &format!("HEAD:{p}")])?.code == 0;
        if in_head || fs::symlink_metadata(git.root().join(p)).is_ok() {
            return Err(Error::Invalid(format!(
                "refusing to scrub history: {p} is part of this record's rename trail but exists in the vault now (a different record may have reused the name). Nothing was changed"
            )));
        }
    }
    Ok(())
}

/// Branches, tags and the like; not Majordomo's backups, not symbolic refs.
fn rewritable_refs(git: &Git) -> Result<Vec<(String, String)>> {
    let text = git.run_text(&[
        "for-each-ref",
        "--format=%(refname)\t%(objectname)\t%(objecttype)\t%(*objecttype)\t%(symref)",
    ])?;
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 5 {
            continue;
        }
        let (name, oid, kind, peeled, symref) = (f[0], f[1], f[2], f[3], f[4]);
        if name.starts_with("refs/majordomo/") || name.starts_with("refs/original/") {
            continue;
        }
        if !symref.is_empty() {
            continue;
        }
        let commit_like = kind == "commit" || (kind == "tag" && peeled == "commit");
        if commit_like {
            out.push((name.to_string(), oid.to_string()));
        }
    }
    Ok(out)
}

fn commits_touching(git: &Git, refs: &[(String, String)], paths: &[String]) -> Result<usize> {
    let mut args: Vec<&str> = vec!["rev-list"];
    args.extend(refs.iter().map(|(r, _)| r.as_str()));
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    Ok(git.run_text(&args)?.lines().count())
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn backup_name(id: &str, refname: &str) -> String {
    format!(
        "{BACKUP_NS}/{id}/{}",
        refname.strip_prefix("refs/").unwrap_or(refname)
    )
}

fn scrub_history(git: &Git, plan: Plan) -> Result<ScrubReport> {
    let git = &git
        .clone()
        .with_timeout(SCRUB_TIMEOUT)
        .with_env("FILTER_BRANCH_SQUELCH_WARNING", "1")
        .with_env("GIT_LITERAL_PATHSPECS", "1");

    // Refs may have moved because of the removal commit: read them again.
    let refs = rewritable_refs(git)?;
    let stamp: String = crate::date::format_utc(crate::date::now_epoch())
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    // Digits only: the timestamp plus a sequence number, first unused.
    let mut id = String::new();
    for seq in 0..100 {
        let candidate = format!("{stamp}{seq:02}");
        let taken = git
            .run_text(&[
                "for-each-ref",
                "--count=1",
                &format!("{BACKUP_NS}/{candidate}/"),
            ])?
            .trim()
            != "";
        if !taken {
            id = candidate;
            break;
        }
    }
    if id.is_empty() {
        return Err(Error::Invalid(
            "too many scrub backups with this timestamp. Nothing was changed".into(),
        ));
    }

    // 1. Backup: every ref, before anything is rewritten.
    for (name, oid) in &refs {
        let b = backup_name(&id, name);
        let out = git.run(&["update-ref", &b, oid, ""])?;
        if out.code != 0 {
            drop_backup(git, &id);
            return Err(Error::Git(format!(
                "could not create the backup ref {b}; nothing was changed ({})",
                out.stderr.lines().next().unwrap_or("")
            )));
        }
    }

    // 2. Rewrite every ref without the paths.
    let quoted: Vec<String> = plan.paths.iter().map(|p| sh_quote(p)).collect();
    let script = format!(
        "git --literal-pathspecs rm --cached --ignore-unmatch -q -- {}",
        quoted.join(" ")
    );
    let mut args: Vec<&str> = vec![
        "-c",
        "core.hooksPath=/dev/null",
        "filter-branch",
        "--index-filter",
        &script,
        "--prune-empty",
        "--tag-name-filter",
        "cat",
        "--",
    ];
    args.extend(refs.iter().map(|(r, _)| r.as_str()));
    let rewrite = git.run(&args);
    let failure = match &rewrite {
        Ok(o) if o.code == 0 => None,
        Ok(o) => Some(o.stderr.lines().last().unwrap_or("").to_string()),
        Err(e) => Some(e.to_string()),
    };
    if let Some(why) = failure {
        let restored = restore_refs(git, &id).is_ok();
        let _ = fs::remove_dir_all(git.root().join(".git-rewrite"));
        delete_refs_under(git, "refs/original/");
        let _ = git.run(&["reset", "-q", "--hard", "HEAD"]);
        return Err(Error::Git(format!(
            "the history rewrite failed ({why}). {} The backup is intact at {BACKUP_NS}/{id}/; restore it with `u2 forget --restore-scrub {id}`. No remote was contacted",
            if restored {
                "Branches and tags were put back as they were."
            } else {
                "Putting the branches and tags back also failed; restore them from the backup."
            }
        )));
    }

    // 3. Drop filter-branch's own copies, expire reflogs, prune.
    delete_refs_under(git, "refs/original/");
    let tidy = git
        .run(&[
            "reflog",
            "expire",
            "--expire=now",
            "--expire-unreachable=now",
            "--all",
        ])
        .and_then(|_| git.run(&["gc", "--prune=now", "-q"]));
    if !matches!(&tidy, Ok(o) if o.code == 0) {
        return Err(Error::Git(format!(
            "history was rewritten but cleanup (reflog expiry / prune) failed; run `git reflog expire --expire=now --all && git gc --prune=now` in the vault. The backup is at {BACKUP_NS}/{id}/ (restore with `u2 forget --restore-scrub {id}`)"
        )));
    }

    let after = rewritable_refs(git)?;
    let residue = commits_touching(git, &after, &plan.paths)?;
    Ok(ScrubReport {
        backup_id: id,
        backup_refs: refs.len(),
        paths: plan.paths,
        commits_touching: plan.commits_touching,
        refs_rewritten: after.len(),
        verified: residue == 0,
    })
}

fn delete_refs_under(git: &Git, prefix: &str) {
    if let Ok(text) = git.run_text(&["for-each-ref", "--format=%(refname)", prefix]) {
        for name in text.lines().filter(|l| !l.is_empty()) {
            let _ = git.run(&["update-ref", "-d", name]);
        }
    }
}

fn drop_backup(git: &Git, id: &str) {
    delete_refs_under(git, &format!("{BACKUP_NS}/{id}/"));
}

/// Point every ref saved in backup `id` back at what it was.
fn restore_refs(git: &Git, id: &str) -> Result<usize> {
    let prefix = format!("{BACKUP_NS}/{id}/");
    let text = git.run_text(&[
        "for-each-ref",
        "--format=%(refname)\t%(objectname)",
        &prefix,
    ])?;
    let mut n = 0;
    for line in text.lines() {
        let Some((name, oid)) = line.split_once('\t') else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let original = format!("refs/{rest}");
        let out = git.run(&["update-ref", &original, oid])?;
        if out.code != 0 {
            return Err(Error::Git(format!("could not restore {original}")));
        }
        n += 1;
    }
    if n == 0 {
        return Err(Error::Invalid(format!("no scrub backup named {id}")));
    }
    Ok(n)
}

/// Undo a scrub: put every branch and tag back to the saved state. The material
/// that was scrubbed is in history again afterwards.
pub fn restore_scrub_backup(git: &Git, id: &str) -> Result<usize> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Invalid(
            "a backup id is the digits shown by forget".into(),
        ));
    }
    let health = Health::inspect(git)?;
    ensure_repo(git, &health, "restore a scrub backup")?;
    if health.staged + health.modified + health.untracked > 0 {
        return Err(Error::Invalid(
            "refusing to restore: the working tree has uncommitted changes".into(),
        ));
    }
    let n = restore_refs(git, id)?;
    git.run_ok(&["reset", "-q", "--hard", "HEAD"])?;
    Ok(n)
}

// ------------------------------------------------------------------ notices

fn retained_notice(path: &str) -> String {
    format!(
        "Git history still holds the removed material: earlier commits can bring {path} back. \
         To erase it from this repository's history too, run: u2 forget {path} --scrub-history --confirm-scrub {path}"
    )
}

fn remote_notice(remotes: &[String], scrubbed: bool) -> String {
    if remotes.is_empty() {
        "Any other copies (backups, other clones, synced folders) are unaffected.".into()
    } else if scrubbed {
        format!(
            "Remote copies are NOT erased: {} still hold the material and were not contacted. Majordomo never pushes; \
             publishing rewritten history would need a force-push that you must make yourself, and other clones and backups keep their copies.",
            remotes.join(", ")
        )
    } else {
        format!(
            "Remote copies ({}) and any backups are unaffected; Majordomo never pushes or contacts a remote.",
            remotes.join(", ")
        )
    }
}

fn scrub_notice(s: &ScrubReport) -> String {
    let mut m = format!(
        "History was rewritten in this repository: {} commit(s) touching {} path(s) dropped across {} ref(s). ",
        s.commits_touching,
        s.paths.len(),
        s.refs_rewritten
    );
    if !s.verified {
        m.push_str("WARNING: verification still found commits touching those paths. ");
    }
    m.push_str(&format!(
        "A safety backup of the ORIGINAL history, which still contains the material, is kept at {BACKUP_NS}/{id}/. \
         Undo with `u2 forget --restore-scrub {id}`. When you are sure, delete the backup to finish erasing: \
         git for-each-ref --format='%(refname)' {BACKUP_NS}/{id}/ | xargs -n1 git update-ref -d && git reflog expire --expire=now --all && git gc --prune=now",
        id = s.backup_id
    ));
    m
}
