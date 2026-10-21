//! Keeps an [`IndexHandle`] current without waiting for a request.
//!
//! A filesystem watcher (inotify / FSEvents via `notify`) wakes the index soon
//! after a relevant file changes; a periodic reconcile catches anything the
//! watcher missed (event overflow, a vault created after start, network
//! filesystems). Both just call [`IndexHandle::refresh`], so there is one
//! rescan path and one change announcement. The watcher never writes.

use super::IndexHandle;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct WatchOptions {
    /// Wait for this much quiet after the last event before rescanning, so a
    /// burst of saves becomes one rescan.
    pub debounce: Duration,
    /// Rescan check interval independent of events.
    pub reconcile: Duration,
}

impl Default for WatchOptions {
    fn default() -> Self {
        WatchOptions {
            debounce: Duration::from_millis(200),
            reconcile: Duration::from_secs(30),
        }
    }
}

enum Msg {
    Fs(Event),
    Stop,
}

/// Stops (and joins) the watcher thread when dropped.
pub struct VaultWatcher {
    stop: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
}

impl VaultWatcher {
    pub fn spawn(handle: Arc<IndexHandle>, options: WatchOptions) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let stop = tx.clone();
        let thread = std::thread::Builder::new()
            .name("vault-watcher".into())
            .spawn(move || run(&handle, options, &tx, &rx))?;
        Ok(VaultWatcher {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(Msg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(handle: &IndexHandle, options: WatchOptions, tx: &Sender<Msg>, rx: &mpsc::Receiver<Msg>) {
    let mut watcher: Option<(RecommendedWatcher, Vec<PathBuf>)> = None;
    let mut dirty_since: Option<Instant> = None;
    let mut last_reconcile = Instant::now();

    loop {
        if watcher.is_none() {
            watcher = establish(handle.root(), tx);
            if watcher.is_some() {
                // Anything that happened before the watch existed.
                refresh(handle);
            }
        }

        let timeout = match dirty_since {
            Some(since) => options.debounce.saturating_sub(since.elapsed()),
            None => options.reconcile.saturating_sub(last_reconcile.elapsed()),
        };
        match rx.recv_timeout(timeout) {
            Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Msg::Fs(event)) => {
                if let Some((_, roots)) = &watcher {
                    if event.paths.iter().any(|p| relevant(p, roots)) {
                        dirty_since = Some(Instant::now());
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if dirty_since.take().is_some() {
                    refresh(handle);
                    last_reconcile = Instant::now();
                } else {
                    refresh(handle);
                    last_reconcile = Instant::now();
                    // A vault replaced or moved while we watched its old inode.
                    if !handle.root().is_dir() {
                        watcher = None;
                    }
                }
            }
        }
    }
}

fn refresh(handle: &IndexHandle) {
    match handle.refresh() {
        Ok(_) => {
            let (generation, last) = handle.generation();
            if let Some(change) = last.filter(|c| c.generation == generation) {
                tracing::info!(
                    generation,
                    added = change.added.len(),
                    modified = change.modified.len(),
                    removed = change.removed.len(),
                    invalid = change.invalid_files,
                    "vault changed"
                );
            }
        }
        Err(e) => tracing::debug!(error = %e, "vault not readable yet"),
    }
}

/// Start watching `root` if it exists. Returns the watcher and the path
/// prefixes (as given and canonical) events may use.
fn establish(root: &Path, tx: &Sender<Msg>) -> Option<(RecommendedWatcher, Vec<PathBuf>)> {
    let canonical = std::fs::canonicalize(root).ok()?;
    let sender = tx.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let _ = sender.send(Msg::Fs(event));
        }
    })
    .map_err(|e| tracing::warn!(error = %e, "cannot create filesystem watcher; relying on periodic reconcile"))
    .ok()?;
    watcher
        .watch(&canonical, RecursiveMode::Recursive)
        .map_err(
            |e| tracing::warn!(error = %e, "cannot watch the vault; relying on periodic reconcile"),
        )
        .ok()?;
    let mut roots = vec![canonical];
    roots.push(root.to_path_buf());
    Some((watcher, roots))
}

/// Only `me.md` and the three collection folders matter; journal writes, a
/// `.git` directory and other files do not wake the index.
fn relevant(path: &Path, roots: &[PathBuf]) -> bool {
    for root in roots {
        if let Ok(rel) = path.strip_prefix(root) {
            let mut parts = rel.components().filter_map(|c| match c {
                Component::Normal(s) => s.to_str(),
                _ => None,
            });
            return match parts.next() {
                None => true,
                Some("me.md" | "people" | "projects" | "commitments") => true,
                Some(_) => false,
            };
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_vault_sources_are_relevant() {
        let roots = vec![PathBuf::from("/v")];
        assert!(relevant(Path::new("/v/people/a.md"), &roots));
        assert!(relevant(Path::new("/v/me.md"), &roots));
        assert!(relevant(Path::new("/v/commitments"), &roots));
        assert!(relevant(Path::new("/v"), &roots));
        assert!(!relevant(Path::new("/v/journal/2026-10.jsonl"), &roots));
        assert!(!relevant(Path::new("/v/.git/index"), &roots));
        assert!(!relevant(Path::new("/elsewhere/people/a.md"), &roots));
    }
}
