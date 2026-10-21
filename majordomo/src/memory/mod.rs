//! Queries over the vault index: lookup, filtering, full-text search, links
//! and backlinks. Everything here is derived from the files and can be
//! rebuilt at any time; nothing is stored.

mod handle;
mod index;
mod links;
mod search;
pub mod view;
mod watcher;

pub use handle::{ChangedRecord, IndexChange, IndexHandle};
pub use index::{MemoryIndex, Warning};
pub use links::{Link, LinkKind};
pub use search::{Hit, Page, Query};
pub use watcher::{VaultWatcher, WatchOptions};
