//! Walks the vault and builds the in-memory index. Strictly read-only.

use super::record::{describe, Record, RecordKind};
use super::{parse_markdown, VaultError, MAX_VAULT_FILE_BYTES};
use crate::error::{Error, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const ME_FILE: &str = "me.md";
const COLLECTIONS: [(&str, RecordKind); 3] = [
    ("people", RecordKind::Person),
    ("projects", RecordKind::Project),
    ("commitments", RecordKind::Commitment),
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InvalidFile {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct VaultIndex {
    pub root: String,
    /// Source files considered (valid or not).
    pub files: usize,
    pub records: Vec<Record>,
    /// Files that could not be interpreted. They are reported, never hidden,
    /// and their content is left untouched.
    pub invalid: Vec<InvalidFile>,
    pub notes: Vec<String>,
    #[serde(skip)]
    by_id: HashMap<String, usize>,
    #[serde(skip)]
    by_path: HashMap<String, usize>,
}

impl VaultIndex {
    pub fn get(&self, id: &str) -> Option<&Record> {
        self.by_id.get(id).map(|&i| &self.records[i])
    }

    pub fn by_path(&self, path: &str) -> Option<&Record> {
        self.by_path.get(path).map(|&i| &self.records[i])
    }

    pub fn of_type<'a>(&'a self, type_name: &'a str) -> impl Iterator<Item = &'a Record> + 'a {
        self.records
            .iter()
            .filter(move |r| r.kind.type_name() == type_name)
    }
}

/// Build the index for the vault rooted at `root`. Fails only if the root
/// itself is unusable; problems in individual files are reported in the index.
pub fn scan(root: &Path) -> Result<VaultIndex> {
    let meta = fs::metadata(root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            Error::Config(format!("vault directory not found: {}", root.display()))
        }
        _ => Error::io(format!("stat vault {}", root.display()))(e),
    })?;
    if !meta.is_dir() {
        return Err(Error::Config(format!(
            "vault path is not a directory: {}",
            root.display()
        )));
    }

    let mut index = VaultIndex {
        root: root.display().to_string(),
        ..VaultIndex::default()
    };

    let mut sources: Vec<(String, RecordKind)> = Vec::new();
    if fs::symlink_metadata(root.join(ME_FILE)).is_ok_and(|m| m.is_file()) {
        sources.push((ME_FILE.to_string(), RecordKind::Owner));
    }
    for (dir, kind) in COLLECTIONS {
        for rel in list_markdown_files(root, dir, &mut index.notes) {
            sources.push((rel, kind));
        }
    }

    let mut claimed: HashMap<String, String> = HashMap::new();
    for (rel, kind) in sources {
        index.files += 1;
        match read_and_describe(root, &rel, kind) {
            Ok(record) => {
                // The owner file is linked to the account's entity by Node, so it
                // takes no part in duplicate-id detection.
                if kind != RecordKind::Owner {
                    if let Some(first) = claimed.get(&record.id) {
                        index.invalid.push(InvalidFile {
                            path: rel,
                            error: format!(
                                "Another vault file already describes this record ({first})"
                            ),
                        });
                        continue;
                    }
                    claimed.insert(record.id.clone(), rel.clone());
                }
                let at = index.records.len();
                index.by_id.entry(record.id.clone()).or_insert(at);
                index.by_path.insert(record.path.clone(), at);
                index.records.push(record);
            }
            Err(e) => index.invalid.push(InvalidFile {
                path: rel,
                error: e.0,
            }),
        }
    }
    Ok(index)
}

/// Regular, non-hidden `.md` files directly inside `dir`. Symlinks (including
/// a symlinked collection directory) are never followed.
fn list_markdown_files(root: &Path, dir: &str, notes: &mut Vec<String>) -> Vec<String> {
    let absolute = root.join(dir);
    match fs::symlink_metadata(&absolute) {
        Ok(m) if m.file_type().is_symlink() => {
            notes.push(format!("{dir}/ is a symlink and was skipped"));
            return Vec::new();
        }
        Ok(m) if m.is_dir() => {}
        _ => return Vec::new(),
    }
    let Ok(entries) = fs::read_dir(&absolute) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.') && name.to_lowercase().ends_with(".md"))
        .map(|name| format!("{dir}/{name}"))
        .collect();
    out.sort();
    out
}

fn read_and_describe(
    root: &Path,
    rel: &str,
    kind: RecordKind,
) -> std::result::Result<Record, VaultError> {
    let text = read_vault_file(&root.join(rel))?;
    describe(rel, kind, &parse_markdown(&text)?)
}

/// Opens without following symlinks and reads at most the size limit.
fn read_vault_file(path: &Path) -> std::result::Result<String, VaultError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)
        .map_err(|_| VaultError::new("Not a regular file"))?;
    let meta = file
        .metadata()
        .map_err(|e| VaultError::new(format!("Cannot read file: {e}")))?;
    if !meta.is_file() {
        return Err(VaultError::new("Not a regular file"));
    }
    if meta.len() > MAX_VAULT_FILE_BYTES {
        return Err(VaultError::new(format!(
            "File exceeds {MAX_VAULT_FILE_BYTES} bytes"
        )));
    }
    let mut bytes = Vec::new();
    file.take(MAX_VAULT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| VaultError::new(format!("Cannot read file: {e}")))?;
    if bytes.len() as u64 > MAX_VAULT_FILE_BYTES {
        return Err(VaultError::new(format!(
            "File exceeds {MAX_VAULT_FILE_BYTES} bytes"
        )));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
