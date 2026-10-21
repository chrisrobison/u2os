//! Read-only historical snapshots: the vault as it was at some commit,
//! extracted into a separate directory. The working tree, index and HEAD are
//! never touched.

use super::{resolve_rev, Git, RevSpec};
use crate::error::{Error, Result};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 200_000;
const MAX_BYTES: u64 = 2 << 30;
const MAX_TIME: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub commit: String,
    pub dest: PathBuf,
    pub files: usize,
    pub bytes: u64,
    /// Symlinks and hard links in the archive are not extracted.
    pub skipped_links: usize,
}

/// Extract the tree of `rev` into `dest` (a new or empty directory, created
/// mode 0700). `vault_root` is used to refuse destinations inside the vault.
pub fn snapshot(git: &Git, rev: &RevSpec, dest: &Path, vault_root: &Path) -> Result<SnapshotInfo> {
    let commit = resolve_rev(git, rev)?
        .ok_or_else(|| Error::Invalid("no commit at or before that time".into()))?;
    let toplevel = git
        .run_text(&["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    check_destination(dest, vault_root, Path::new(&toplevel))?;

    let created = prepare(dest)?;
    match extract(git, &commit, dest) {
        Ok(info) => Ok(info),
        Err(e) => {
            if created {
                // We made this directory moments ago; remove only that.
                let _ = fs::remove_dir_all(dest);
            }
            Err(e)
        }
    }
}

fn check_destination(dest: &Path, vault_root: &Path, toplevel: &Path) -> Result<()> {
    let bad = |why: &str| {
        Err(Error::Invalid(format!(
            "snapshot destination {why}: {}",
            dest.display()
        )))
    };
    if !dest.is_absolute() {
        return bad("must be an absolute path");
    }
    if dest
        .components()
        .any(|c| matches!(c, Component::ParentDir) || c.as_os_str() == ".git")
    {
        return bad("must not contain .. or .git");
    }
    // Resolve through the nearest existing ancestor so symlinks cannot hide a
    // location inside the vault or repository.
    let mut existing = dest;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| Error::Invalid("snapshot destination has no existing parent".into()))?;
    }
    let tail = dest.strip_prefix(existing).unwrap_or(Path::new(""));
    let resolved = fs::canonicalize(existing)
        .map_err(Error::io(format!("resolve {}", existing.display())))?
        .join(tail);
    for protected in [vault_root, toplevel] {
        if let Ok(p) = fs::canonicalize(protected) {
            if resolved.starts_with(&p) || p.starts_with(&resolved) {
                return bad("must be outside the vault and its repository");
            }
        }
    }
    Ok(())
}

/// Create `dest` (mode 0700) or accept an existing empty directory. Returns
/// whether we created it.
fn prepare(dest: &Path) -> Result<bool> {
    match fs::symlink_metadata(dest) {
        Ok(m) if m.file_type().is_symlink() => {
            Err(Error::Invalid("snapshot destination is a symlink".into()))
        }
        Ok(m) if m.is_dir() => {
            let empty = fs::read_dir(dest)
                .map_err(Error::io(format!("read {}", dest.display())))?
                .next()
                .is_none();
            if empty {
                Ok(false)
            } else {
                Err(Error::Invalid(format!(
                    "snapshot destination is not empty: {}",
                    dest.display()
                )))
            }
        }
        Ok(_) => Err(Error::Invalid(
            "snapshot destination exists and is not a directory".into(),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dest)
                .map_err(Error::io(format!("create {}", dest.display())))?;
            fs::set_permissions(dest, fs::Permissions::from_mode(0o700))
                .map_err(Error::io(format!("chmod {}", dest.display())))?;
            Ok(true)
        }
        Err(e) => Err(Error::io(format!("stat {}", dest.display()))(e)),
    }
}

fn extract(git: &Git, commit: &str, dest: &Path) -> Result<SnapshotInfo> {
    let mut child = git.spawn_stdout(&["archive", "--format=tar", commit])?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Git("no archive output".into()))?;
    let mut stderr = child.stderr.take();

    let mut info = SnapshotInfo {
        commit: commit.to_string(),
        dest: dest.to_path_buf(),
        files: 0,
        bytes: 0,
        skipped_links: 0,
    };
    let started = Instant::now();
    let result = (|| -> Result<()> {
        let mut archive = tar::Archive::new(stdout);
        archive.set_preserve_permissions(false);
        archive.set_unpack_xattrs(false);
        let entries = archive.entries().map_err(Error::io("read git archive"))?;
        for (n, entry) in entries.enumerate() {
            let mut entry = entry.map_err(Error::io("read git archive entry"))?;
            if n >= MAX_ENTRIES || info.bytes > MAX_BYTES || started.elapsed() > MAX_TIME {
                return Err(Error::Invalid(
                    "snapshot is larger or slower than the allowed limits".into(),
                ));
            }
            let kind = entry.header().entry_type();
            if kind.is_symlink() || kind.is_hard_link() {
                info.skipped_links += 1;
                continue;
            }
            if !(kind.is_file() || kind.is_dir()) {
                continue; // pax headers and anything exotic
            }
            let size = entry.size();
            if !entry
                .unpack_in(dest)
                .map_err(Error::io("extract snapshot"))?
            {
                return Err(Error::Invalid(
                    "archive entry would escape the snapshot directory".into(),
                ));
            }
            if kind.is_file() {
                info.files += 1;
                info.bytes += size;
            }
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(Error::io("wait for git archive"))?;
    result?;
    if !status.success() {
        let mut err = String::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.take(2000).read_to_string(&mut err);
        }
        return Err(Error::Git(format!(
            "`git archive` failed: {}",
            err.lines().next().unwrap_or("")
        )));
    }
    Ok(info)
}
