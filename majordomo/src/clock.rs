//! Time source for the operational store. Operations take explicit
//! millisecond timestamps (as Node's queue takes `now`), so tests can drive
//! lease expiry and backoff deterministically.

use std::sync::atomic::{AtomicI64, Ordering};

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }
}

/// A clock that only moves when told to. For tests and fixtures.
#[derive(Debug, Default)]
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(start_ms: i64) -> Self {
        ManualClock(AtomicI64::new(start_ms))
    }

    pub fn set(&self, ms: i64) {
        self.0.store(ms, Ordering::SeqCst);
    }

    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
