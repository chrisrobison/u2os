use super::MemoryIndex;
use crate::vault;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A lazily refreshed index over one vault. Each call to [`current`] checks a
/// cheap fingerprint of the vault files and rescans only when it changed, so
/// edits made in any editor are seen without a restart. Nothing is written.
///
/// [`current`]: IndexHandle::current
#[derive(Debug)]
pub struct IndexHandle {
    root: PathBuf,
    min_interval: Duration,
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    index: Option<Arc<MemoryIndex>>,
    signature: Option<u64>,
    checked: Option<Instant>,
}

impl IndexHandle {
    pub fn new(root: PathBuf) -> Self {
        Self::with_interval(root, Duration::from_millis(500))
    }

    /// `min_interval` bounds how often the filesystem is examined; zero checks
    /// on every call.
    pub fn with_interval(root: PathBuf, min_interval: Duration) -> Self {
        IndexHandle {
            root,
            min_interval,
            state: Mutex::new(State::default()),
        }
    }

    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// The current index, rescanning first if the vault changed. Fails if the
    /// vault directory is missing or unreadable.
    pub fn current(&self) -> Result<Arc<MemoryIndex>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "index lock poisoned".to_string())?;
        if let (Some(index), Some(checked)) = (&state.index, state.checked) {
            if checked.elapsed() < self.min_interval {
                return Ok(index.clone());
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
        state.index = Some(index.clone());
        state.signature = Some(signature);
        Ok(index)
    }
}
