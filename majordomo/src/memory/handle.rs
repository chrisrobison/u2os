use super::MemoryIndex;
use crate::vault;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

const CHANNEL_CAPACITY: usize = 64;

/// A record that appeared, changed or disappeared between two scans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedRecord {
    pub id: String,
    pub path: String,
}

/// What a rescan found different from the previous index. A rename shows up as
/// one removal and one addition; following identity across renames is the job
/// of the history layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexChange {
    /// Increases by one with every rescan, starting at 1 for the first scan.
    pub generation: u64,
    pub at_unix: u64,
    pub added: Vec<ChangedRecord>,
    pub modified: Vec<ChangedRecord>,
    pub removed: Vec<ChangedRecord>,
    /// Files that cannot currently be interpreted.
    pub invalid_files: usize,
}

impl IndexChange {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.removed.is_empty()
    }
}

/// A refreshed index over one vault. Callers see edits made in any editor
/// without a restart: [`current`] checks a cheap fingerprint of the vault
/// files and rescans only when it changed, and a [`super::VaultWatcher`] can
/// call [`refresh`] as soon as the filesystem reports a change. Every rescan
/// is announced to [`subscribe`]rs. Nothing is written.
///
/// [`current`]: IndexHandle::current
/// [`refresh`]: IndexHandle::refresh
/// [`subscribe`]: IndexHandle::subscribe
#[derive(Debug)]
pub struct IndexHandle {
    root: PathBuf,
    min_interval: Duration,
    state: Mutex<State>,
    changes: broadcast::Sender<Arc<IndexChange>>,
}

#[derive(Debug, Default)]
struct State {
    index: Option<Arc<MemoryIndex>>,
    signature: Option<u64>,
    checked: Option<Instant>,
    generation: u64,
    last_change: Option<Arc<IndexChange>>,
}

impl IndexHandle {
    pub fn new(root: PathBuf) -> Self {
        Self::with_interval(root, Duration::from_millis(500))
    }

    /// `min_interval` bounds how often [`current`](Self::current) examines the
    /// filesystem; zero checks on every call.
    pub fn with_interval(root: PathBuf, min_interval: Duration) -> Self {
        let (changes, _) = broadcast::channel(CHANNEL_CAPACITY);
        IndexHandle {
            root,
            min_interval,
            state: Mutex::new(State::default()),
            changes,
        }
    }

    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// Be told about every rescan. A receiver that falls more than 64 events
    /// behind sees `Lagged` and should call [`current`](Self::current).
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<IndexChange>> {
        self.changes.subscribe()
    }

    /// `(generation, most recent rescan that found a difference)`.
    pub fn generation(&self) -> (u64, Option<Arc<IndexChange>>) {
        self.state
            .lock()
            .map(|s| (s.generation, s.last_change.clone()))
            .unwrap_or((0, None))
    }

    /// The current index, rescanning first if the vault changed. Fails if the
    /// vault directory is missing or unreadable.
    pub fn current(&self) -> Result<Arc<MemoryIndex>, String> {
        self.update(false)
    }

    /// Like [`current`](Self::current) but ignores the throttle. Used by the
    /// watcher after a filesystem event and by periodic reconciliation.
    pub fn refresh(&self) -> Result<Arc<MemoryIndex>, String> {
        self.update(true)
    }

    fn update(&self, force: bool) -> Result<Arc<MemoryIndex>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "index lock poisoned".to_string())?;
        if !force {
            if let (Some(index), Some(checked)) = (&state.index, state.checked) {
                if checked.elapsed() < self.min_interval {
                    return Ok(index.clone());
                }
            }
        }
        let signature = vault::signature(&self.root);
        state.checked = Some(Instant::now());
        if let (Some(index), Some(previous)) = (&state.index, state.signature) {
            if previous == signature {
                return Ok(index.clone());
            }
        }
        let scanned = vault::scan(&self.root).map_err(|e| e.to_string())?;
        let index = Arc::new(MemoryIndex::build(scanned));
        state.generation += 1;
        let change = Arc::new(diff(state.generation, state.index.as_deref(), &index));
        if state.index.is_some() && !change.is_empty() {
            state.last_change = Some(change.clone());
        }
        let announce = state.index.is_some();
        state.index = Some(index.clone());
        state.signature = Some(signature);
        if announce {
            // No subscribers is fine.
            let _ = self.changes.send(change);
        }
        Ok(index)
    }
}

fn diff(generation: u64, old: Option<&MemoryIndex>, new: &MemoryIndex) -> IndexChange {
    let at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut change = IndexChange {
        generation,
        at_unix,
        added: Vec::new(),
        modified: Vec::new(),
        removed: Vec::new(),
        invalid_files: new.vault.invalid.len(),
    };
    let Some(old) = old else { return change };
    let old_by_path: HashMap<&str, &vault::Record> = old
        .vault
        .records
        .iter()
        .map(|r| (r.path.as_str(), r))
        .collect();
    let changed = |r: &vault::Record| ChangedRecord {
        id: r.id.clone(),
        path: r.path.clone(),
    };
    for record in &new.vault.records {
        match old_by_path.get(record.path.as_str()) {
            None => change.added.push(changed(record)),
            Some(previous) if *previous != record => change.modified.push(changed(record)),
            Some(_) => {}
        }
    }
    let new_paths: std::collections::HashSet<&str> =
        new.vault.records.iter().map(|r| r.path.as_str()).collect();
    for record in &old.vault.records {
        if !new_paths.contains(record.path.as_str()) {
            change.removed.push(changed(record));
        }
    }
    change
}
