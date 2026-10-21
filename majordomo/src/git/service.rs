//! Background check-in: a quiet period after the vault changes, then one
//! commit. Driven by the index's change announcements, plus one pass at
//! startup for whatever was left dirty while the daemon was down.

use super::{checkin, CheckinStatus, Git};
use crate::memory::IndexChange;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

pub const DEFAULT_QUIET: Duration = Duration::from_secs(5);
const BUSY_RETRY: Duration = Duration::from_secs(2);
const BUSY_ATTEMPTS: u32 = 5;

pub struct CheckinService {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl CheckinService {
    pub fn spawn(
        git: Git,
        changes: broadcast::Receiver<Arc<IndexChange>>,
        quiet: Duration,
    ) -> CheckinService {
        let (stop, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run(git, changes, quiet, stop_rx));
        CheckinService { stop, task }
    }

    /// Stop after any commit in flight finishes.
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = self.task.await;
    }
}

async fn run(
    git: Git,
    mut changes: broadcast::Receiver<Arc<IndexChange>>,
    quiet: Duration,
    mut stop: watch::Receiver<bool>,
) {
    let mut pending = true; // startup pass
    loop {
        if !pending {
            tokio::select! {
                _ = stop.changed() => return,
                r = changes.recv() => match r {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            }
        }
        // Wait for quiet: every further change restarts the clock.
        loop {
            tokio::select! {
                _ = stop.changed() => return,
                _ = tokio::time::sleep(quiet) => break,
                r = changes.recv() => {
                    if matches!(r, Err(broadcast::error::RecvError::Closed)) {
                        return;
                    }
                }
            }
        }
        pending = false;

        for attempt in 1..=BUSY_ATTEMPTS {
            let g = git.clone();
            match tokio::task::spawn_blocking(move || checkin(&g)).await {
                Ok(Ok(r)) => match r.status {
                    CheckinStatus::Committed => tracing::info!(
                        files = r.files,
                        commit = r.commit.as_deref().unwrap_or(""),
                        conflicts_resolved = r.resolved_conflicts.len(),
                        "checked in vault changes"
                    ),
                    CheckinStatus::Clean => {}
                    CheckinStatus::Skipped => tracing::warn!(
                        reason = r.reason.as_deref().unwrap_or(""),
                        "check-in skipped"
                    ),
                    CheckinStatus::Busy => {
                        if attempt < BUSY_ATTEMPTS {
                            tokio::select! {
                                _ = stop.changed() => return,
                                _ = tokio::time::sleep(BUSY_RETRY) => {}
                            }
                            continue;
                        }
                        tracing::warn!("check-in gave up: the repository stayed locked");
                    }
                },
                Ok(Err(e)) => tracing::warn!(error = %e, "check-in failed"),
                Err(e) => tracing::error!(error = %e, "check-in task failed"),
            }
            break;
        }
    }
}
