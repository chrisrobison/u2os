//! Execution of leased actions through injected capabilities.
//!
//! Mirrors `server/agent/action-queue-worker.js` for the checks that apply to
//! mock capabilities. Real policy re-evaluation is Phase 5: the injected
//! [`Authorizer`] stands in for it.

use super::classify::{classify, ErrorClass, ErrorInfo, RetryPolicy};
use super::state::Status;
use super::store::{arguments_sha256, Action, ActionError, ActionStore, StopStatus};
use crate::clock::Clock;
use crate::events::EventBus;
use serde_json::Value;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ExecRequest<'a> {
    pub action_id: &'a str,
    pub tool: &'a str,
    pub arguments: &'a Value,
    pub idempotency_key: &'a str,
    pub correlation_id: Option<&'a str>,
    pub attempt_number: u32,
}

#[derive(Debug, Clone, Default)]
pub struct CapabilityError {
    pub message: String,
    pub info: ErrorInfo,
    /// The failure is known to have happened before any effect (Node:
    /// `error.safeToRetry`).
    pub safe_to_retry: bool,
}

impl CapabilityError {
    pub fn new(message: impl Into<String>) -> Self {
        CapabilityError {
            message: message.into(),
            ..Default::default()
        }
    }

    pub fn with_code(mut self, code: &str) -> Self {
        self.info.code = Some(code.to_string());
        self
    }

    pub fn with_class(mut self, class: ErrorClass) -> Self {
        self.info.action_error_class = Some(class.as_str().to_string());
        self
    }

    pub fn safe_to_retry(mut self) -> Self {
        self.safe_to_retry = true;
        self
    }
}

pub trait Capability: Send + Sync {
    /// Whether the provider honours the idempotency key (Node:
    /// `tool.supportsIdempotency`).
    fn supports_idempotency(&self) -> bool {
        false
    }
    fn execute(&self, request: &ExecRequest<'_>) -> Result<(), CapabilityError>;
}

#[derive(Default, Clone)]
pub struct CapabilityRegistry {
    tools: HashMap<String, Arc<dyn Capability>>,
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: &str, capability: Arc<dyn Capability>) {
        self.tools.insert(tool.to_string(), capability);
    }

    pub fn get(&self, tool: &str) -> Option<&Arc<dyn Capability>> {
        self.tools.get(tool)
    }
}

pub enum Authorization {
    Allow,
    Deny { reason: String, class: ErrorClass },
}

/// Execution-time authorization hook. Phase 4a ships mocks only; the real
/// policy engine arrives in Phase 5.
pub trait Authorizer: Send + Sync {
    fn authorize(&self, action: &Action) -> Authorization;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub action_id: String,
    pub status: Status,
    pub error_class: Option<ErrorClass>,
}

pub struct Runtime {
    actions: ActionStore,
    bus: Arc<EventBus>,
    capabilities: CapabilityRegistry,
    authorizer: Arc<dyn Authorizer>,
    clock: Arc<dyn Clock>,
    worker_id: String,
    lease_ms: i64,
    retry: RetryPolicy,
}

impl Runtime {
    pub fn new(
        actions: ActionStore,
        bus: Arc<EventBus>,
        capabilities: CapabilityRegistry,
        authorizer: Arc<dyn Authorizer>,
        clock: Arc<dyn Clock>,
        worker_id: impl Into<String>,
    ) -> Self {
        Runtime {
            actions,
            bus,
            capabilities,
            authorizer,
            clock,
            worker_id: worker_id.into(),
            lease_ms: 30_000,
            retry: RetryPolicy::default(),
        }
    }

    pub fn with_lease_ms(mut self, lease_ms: i64) -> Self {
        self.lease_ms = lease_ms;
        self
    }

    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    pub fn actions(&self) -> &ActionStore {
        &self.actions
    }

    fn announce(&self) {
        if let Err(e) = self.bus.deliver_pending() {
            tracing::warn!(error = %e, "event delivery failed");
        }
    }

    /// Recover expired leases (call at start-up and on every tick).
    pub fn recover(&self) -> Result<super::store::RecoveryReport, ActionError> {
        let report = self.actions.recover(self.clock.now_ms())?;
        self.announce();
        Ok(report)
    }

    pub fn process_next(&self) -> Result<Option<Outcome>, ActionError> {
        let leased =
            self.actions
                .lease_next(&self.worker_id, self.lease_ms, self.clock.now_ms())?;
        self.announce();
        leased.map(|a| self.execute(a)).transpose()
    }

    pub fn process_action(&self, id: &str) -> Result<Option<Outcome>, ActionError> {
        let leased =
            self.actions
                .lease_action(id, &self.worker_id, self.lease_ms, self.clock.now_ms())?;
        self.announce();
        leased.map(|a| self.execute(a)).transpose()
    }

    fn stop(
        &self,
        a: &Action,
        status: StopStatus,
        message: &str,
        class: ErrorClass,
    ) -> Result<Outcome, ActionError> {
        let stopped = self.actions.stop_leased(
            &a.id,
            &self.worker_id,
            status,
            message,
            class,
            self.clock.now_ms(),
        )?;
        self.announce();
        Ok(Outcome {
            action_id: stopped.id,
            status: stopped.status,
            error_class: stopped.error_class,
        })
    }

    fn execute(&self, a: Action) -> Result<Outcome, ActionError> {
        let Some(capability) = self.capabilities.get(&a.tool).cloned() else {
            return self.stop(
                &a,
                StopStatus::Failed,
                "No capability is registered for this tool",
                ErrorClass::NonRetryable,
            );
        };
        if let Authorization::Deny { reason, class } = self.authorizer.authorize(&a) {
            return self.stop(&a, StopStatus::Cancelled, &reason, class);
        }
        if a.consequential && a.approved_at_ms.is_none() {
            return self.stop(
                &a,
                StopStatus::Failed,
                "Current policy requires owner approval",
                ErrorClass::OwnerAttentionRequired,
            );
        }
        if arguments_sha256(&a.arguments) != a.arguments_sha256 {
            return self.stop(
                &a,
                StopStatus::Failed,
                "Queued payload differs from the approved proposal",
                ErrorClass::OwnerAttentionRequired,
            );
        }

        let attempt = self
            .actions
            .begin_attempt(&a.id, &self.worker_id, self.clock.now_ms())?;
        self.announce();
        let request = ExecRequest {
            action_id: &a.id,
            tool: &a.tool,
            arguments: &a.arguments,
            idempotency_key: &a.idempotency_key,
            correlation_id: a.correlation_id.as_deref(),
            attempt_number: attempt.attempt_number,
        };
        let result = catch_unwind(AssertUnwindSafe(|| capability.execute(&request)));
        let settled = match result {
            Ok(Ok(())) => {
                self.actions
                    .complete_attempt(&attempt.id, &self.worker_id, self.clock.now_ms())
            }
            Ok(Err(err)) => {
                let mut class = classify(&err.info);
                if class == ErrorClass::Retryable
                    && !capability.supports_idempotency()
                    && !err.safe_to_retry
                {
                    class = ErrorClass::OwnerAttentionRequired;
                }
                self.actions.fail_attempt(
                    &attempt.id,
                    &self.worker_id,
                    &err.message,
                    class,
                    self.retry,
                    self.clock.now_ms(),
                )
            }
            // A panic mid-capability: the effect may have happened.
            Err(_) => self.actions.fail_attempt(
                &attempt.id,
                &self.worker_id,
                "capability panicked; the outcome is unknown",
                ErrorClass::OutcomeUncertain,
                self.retry,
                self.clock.now_ms(),
            ),
        };
        self.announce();
        let done = settled?;
        Ok(Outcome {
            action_id: done.id,
            status: done.status,
            error_class: done.error_class,
        })
    }
}
