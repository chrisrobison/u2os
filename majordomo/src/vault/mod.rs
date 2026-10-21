//! Read-only access to the owner's vault: plain Markdown files with YAML
//! frontmatter (docs/vault.md, ADR 0007).
//!
//! This module reproduces how the Node indexer (`server/vault/`) interprets
//! the vault today, so Majordomo and Node agree on what the files mean. It
//! never writes, creates directories, or follows symlinks. Differences from
//! Node are listed in docs/majordomo.md.

mod locate;
mod markdown;
mod record;
mod scanner;

pub use locate::locate;
pub use markdown::{parse_markdown, Parsed, MAX_VAULT_FILE_BYTES};
pub use record::{describe, path_derived_id, Classification, Fact, Record, RecordKind};
pub use scanner::{scan, signature, InvalidFile, VaultIndex};

/// A vault file that cannot be interpreted. The message is for the owner.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct VaultError(pub String);

impl VaultError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        VaultError(message.into())
    }
}
