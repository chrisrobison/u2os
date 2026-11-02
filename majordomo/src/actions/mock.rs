//! Mock capabilities and authorizers. No real connectors: these exist so the
//! state machine can be tested, including crashes. Effects are recorded in an
//! [`EffectLog`], optionally mirrored to a file so they survive SIGKILL.

use super::classify::ErrorClass;
use super::exec::{Authorization, Authorizer, Capability, CapabilityError, ExecRequest};
use super::store::Action;
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

#[derive(Debug, Default)]
pub struct EffectLog {
    entries: Mutex<Vec<String>>,
    file: Option<PathBuf>,
}

impl EffectLog {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Also append each effect to `path` (fsynced), so a killed process leaves
    /// evidence of exactly the effects it produced.
    pub fn with_file(path: PathBuf) -> Arc<Self> {
        Arc::new(EffectLog {
            entries: Mutex::new(Vec::new()),
            file: Some(path),
        })
    }

    pub fn record(&self, idempotency_key: &str) {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(idempotency_key.to_string());
        if let Some(path) = &self.file {
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{idempotency_key}");
                let _ = f.sync_all();
            }
        }
    }

    pub fn count(&self) -> usize {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    pub fn entries(&self) -> Vec<String> {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

/// Number of effects recorded in a ledger file.
pub fn count_ledger(path: &std::path::Path) -> usize {
    std::fs::read_to_string(path)
        .map(|t| t.lines().filter(|l| !l.is_empty()).count())
        .unwrap_or(0)
}

/// Records one effect per successful call.
pub struct CountingCapability {
    pub log: Arc<EffectLog>,
    idempotent: bool,
}

impl CountingCapability {
    pub fn new(log: Arc<EffectLog>) -> Self {
        CountingCapability {
            log,
            idempotent: false,
        }
    }

    pub fn idempotent(mut self) -> Self {
        self.idempotent = true;
        self
    }
}

impl Capability for CountingCapability {
    fn supports_idempotency(&self) -> bool {
        self.idempotent
    }

    fn execute(&self, request: &ExecRequest<'_>) -> Result<(), CapabilityError> {
        self.log.record(request.idempotency_key);
        Ok(())
    }
}

/// Fails with each scripted error in turn (no effect), then succeeds.
pub struct FailingCapability {
    pub log: Arc<EffectLog>,
    script: Mutex<VecDeque<CapabilityError>>,
    idempotent: bool,
}

impl FailingCapability {
    pub fn new(log: Arc<EffectLog>, errors: Vec<CapabilityError>) -> Self {
        FailingCapability {
            log,
            script: Mutex::new(errors.into()),
            idempotent: false,
        }
    }

    pub fn idempotent(mut self) -> Self {
        self.idempotent = true;
        self
    }
}

impl Capability for FailingCapability {
    fn supports_idempotency(&self) -> bool {
        self.idempotent
    }

    fn execute(&self, request: &ExecRequest<'_>) -> Result<(), CapabilityError> {
        let next = self
            .script
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pop_front();
        match next {
            Some(e) => Err(e),
            None => {
                self.log.record(request.idempotency_key);
                Ok(())
            }
        }
    }
}

/// Records the effect, signals `started`, then blocks until released (or
/// forever when there is no release channel): the effect was handed off but
/// the caller never learns the outcome.
pub struct HangingCapability {
    pub log: Arc<EffectLog>,
    started: Mutex<Option<Sender<()>>>,
    release: Mutex<Option<Receiver<()>>>,
}

impl HangingCapability {
    pub fn new(
        log: Arc<EffectLog>,
        started: Option<Sender<()>>,
        release: Option<Receiver<()>>,
    ) -> Self {
        HangingCapability {
            log,
            started: Mutex::new(started),
            release: Mutex::new(release),
        }
    }
}

impl Capability for HangingCapability {
    fn execute(&self, request: &ExecRequest<'_>) -> Result<(), CapabilityError> {
        self.log.record(request.idempotency_key);
        if let Some(tx) = self
            .started
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            let _ = tx.send(());
        }
        let release = self
            .release
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        match release {
            Some(rx) => {
                let _ = rx.recv();
            }
            None => loop {
                std::thread::park();
            },
        }
        Ok(())
    }
}

/// Records the effect, then panics.
pub struct PanicCapability {
    pub log: Arc<EffectLog>,
}

impl Capability for PanicCapability {
    fn execute(&self, request: &ExecRequest<'_>) -> Result<(), CapabilityError> {
        self.log.record(request.idempotency_key);
        panic!("mock capability crashed after its effect");
    }
}

/// Allows everything unless told to deny.
#[derive(Default)]
pub struct MockAuthorizer {
    deny: Mutex<Option<(String, ErrorClass)>>,
}

impl MockAuthorizer {
    pub fn allow_all() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn deny_all(reason: &str, class: ErrorClass) -> Arc<Self> {
        Arc::new(MockAuthorizer {
            deny: Mutex::new(Some((reason.to_string(), class))),
        })
    }

    pub fn set_deny(&self, deny: Option<(String, ErrorClass)>) {
        *self.deny.lock().unwrap_or_else(|p| p.into_inner()) = deny;
    }
}

impl Authorizer for MockAuthorizer {
    fn authorize(&self, _action: &Action) -> Authorization {
        match self.deny.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            Some((reason, class)) => Authorization::Deny { reason, class },
            None => Authorization::Allow,
        }
    }
}
