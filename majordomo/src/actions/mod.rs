//! Durable action state machine (Phase 4a of the Rust Majordomo migration).
//!
//! **Node remains authoritative.** Nothing here is wired to Node's action
//! queue, `u2os.sqlite` or runtime lock, and the daemon does not run this
//! runtime: it only offers read-only inspection. Only mock capabilities exist;
//! execution-time authorization is an injected [`exec::Authorizer`] whose real
//! policy parity is Phase 5. The scheduler is Phase 4b.

pub mod classify;
pub mod exec;
pub mod mock;
pub mod state;
pub mod store;

pub use classify::{ErrorClass, ErrorInfo, RetryPolicy};
pub use exec::{
    Authorization, Authorizer, Capability, CapabilityError, CapabilityRegistry, ExecRequest,
    Outcome, Runtime,
};
pub use state::{IllegalTransition, Status, Trigger};
pub use store::{
    Action, ActionError, ActionStore, Attempt, NewAction, RecoveryReport, Resolution, StopStatus,
    Submission,
};
