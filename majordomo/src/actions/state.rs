//! The action state machine: statuses, triggers and the transition table.
//!
//! This table is the single source of truth for what may happen to an action.
//! Every state change in [`super::store::ActionStore`] goes through [`next`];
//! an illegal pair returns [`IllegalTransition`] and the caller changes
//! nothing. The same table is compared with Node's real queue behaviour in
//! `tests/fixtures/actions-parity.json`.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Consequential action waiting for the owner. Not in Node's queue table
    /// (Node keeps this in `agent_actions.status = 'pending'`).
    AwaitingApproval,
    Queued,
    Leased,
    Executing,
    RetryWait,
    Completed,
    Failed,
    DeadLetter,
    Cancelled,
    /// The effect may or may not have happened. Waits for owner review and is
    /// never retried automatically. Node expresses this as `failed` with
    /// `error_class = 'outcome_uncertain'`.
    OutcomeUncertain,
}

pub const ALL_STATUSES: [Status; 10] = [
    Status::AwaitingApproval,
    Status::Queued,
    Status::Leased,
    Status::Executing,
    Status::RetryWait,
    Status::Completed,
    Status::Failed,
    Status::DeadLetter,
    Status::Cancelled,
    Status::OutcomeUncertain,
];

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::AwaitingApproval => "awaiting_approval",
            Status::Queued => "queued",
            Status::Leased => "leased",
            Status::Executing => "executing",
            Status::RetryWait => "retry_wait",
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::DeadLetter => "dead_letter",
            Status::Cancelled => "cancelled",
            Status::OutcomeUncertain => "outcome_uncertain",
        }
    }

    pub fn parse(text: &str) -> Option<Status> {
        ALL_STATUSES.into_iter().find(|s| s.as_str() == text)
    }

    /// No transition leaves this status (except via an owner command).
    pub fn is_terminal(self) -> bool {
        matches!(self, Status::Completed | Status::DeadLetter)
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What happens to an action. Triggers are facts, not requests: the store
/// decides which one applies, the table decides whether it is allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    Approve,
    Reject,
    /// Owner or system cancels an action that has not started.
    Cancel,
    Lease,
    /// A lease ran out: leased returns to the queue, executing is uncertain.
    ExpireLease,
    BeginAttempt,
    Complete,
    FailRetry,
    FailDeadLetter,
    FailTerminal,
    /// The capability reported that the outcome is unknown.
    MarkUncertain,
    StopFailed,
    StopCancelled,
    StopDeadLetter,
    Requeue,
    ResolveDone,
    ResolveNotDone,
}

pub const ALL_TRIGGERS: [Trigger; 17] = [
    Trigger::Approve,
    Trigger::Reject,
    Trigger::Cancel,
    Trigger::Lease,
    Trigger::ExpireLease,
    Trigger::BeginAttempt,
    Trigger::Complete,
    Trigger::FailRetry,
    Trigger::FailDeadLetter,
    Trigger::FailTerminal,
    Trigger::MarkUncertain,
    Trigger::StopFailed,
    Trigger::StopCancelled,
    Trigger::StopDeadLetter,
    Trigger::Requeue,
    Trigger::ResolveDone,
    Trigger::ResolveNotDone,
];

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Approve => "approve",
            Trigger::Reject => "reject",
            Trigger::Cancel => "cancel",
            Trigger::Lease => "lease",
            Trigger::ExpireLease => "expire_lease",
            Trigger::BeginAttempt => "begin_attempt",
            Trigger::Complete => "complete",
            Trigger::FailRetry => "fail_retry",
            Trigger::FailDeadLetter => "fail_dead_letter",
            Trigger::FailTerminal => "fail_terminal",
            Trigger::MarkUncertain => "mark_uncertain",
            Trigger::StopFailed => "stop_failed",
            Trigger::StopCancelled => "stop_cancelled",
            Trigger::StopDeadLetter => "stop_dead_letter",
            Trigger::Requeue => "requeue",
            Trigger::ResolveDone => "resolve_done",
            Trigger::ResolveNotDone => "resolve_not_done",
        }
    }

    pub fn parse(text: &str) -> Option<Trigger> {
        ALL_TRIGGERS.into_iter().find(|t| t.as_str() == text)
    }
}

impl fmt::Display for Trigger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

use Status as S;
use Trigger as T;

/// Every legal `(from, trigger, to)`. Anything not listed is illegal.
pub const TRANSITIONS: &[(Status, Trigger, Status)] = &[
    (S::AwaitingApproval, T::Approve, S::Queued),
    (S::AwaitingApproval, T::Reject, S::Cancelled),
    (S::AwaitingApproval, T::Cancel, S::Cancelled),
    (S::Queued, T::Cancel, S::Cancelled),
    (S::RetryWait, T::Cancel, S::Cancelled),
    (S::Queued, T::Lease, S::Leased),
    (S::RetryWait, T::Lease, S::Leased),
    (S::Leased, T::ExpireLease, S::Queued),
    (S::Leased, T::BeginAttempt, S::Executing),
    (S::Leased, T::StopFailed, S::Failed),
    (S::Leased, T::StopCancelled, S::Cancelled),
    (S::Leased, T::StopDeadLetter, S::DeadLetter),
    (S::Executing, T::Complete, S::Completed),
    (S::Executing, T::FailRetry, S::RetryWait),
    (S::Executing, T::FailDeadLetter, S::DeadLetter),
    (S::Executing, T::FailTerminal, S::Failed),
    (S::Executing, T::MarkUncertain, S::OutcomeUncertain),
    (S::Executing, T::ExpireLease, S::OutcomeUncertain),
    (S::Failed, T::Requeue, S::Queued),
    (S::Cancelled, T::Requeue, S::Queued),
    (S::OutcomeUncertain, T::ResolveDone, S::Completed),
    (S::OutcomeUncertain, T::ResolveNotDone, S::Queued),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("illegal transition: {trigger} is not allowed from {from}")]
pub struct IllegalTransition {
    pub from: Status,
    pub trigger: Trigger,
}

/// The status reached by applying `trigger` to `from`, or an error that means
/// "change nothing".
pub fn next(from: Status, trigger: Trigger) -> Result<Status, IllegalTransition> {
    TRANSITIONS
        .iter()
        .find(|(f, t, _)| *f == from && *t == trigger)
        .map(|(_, _, to)| *to)
        .ok_or(IllegalTransition { from, trigger })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_has_no_duplicate_pairs_and_names_round_trip() {
        for (i, (f, t, _)) in TRANSITIONS.iter().enumerate() {
            assert!(
                !TRANSITIONS[i + 1..]
                    .iter()
                    .any(|(f2, t2, _)| f == f2 && t == t2),
                "duplicate {f} {t}"
            );
        }
        for s in ALL_STATUSES {
            assert_eq!(Status::parse(s.as_str()), Some(s));
        }
        for t in ALL_TRIGGERS {
            assert_eq!(Trigger::parse(t.as_str()), Some(t));
        }
    }

    #[test]
    fn every_pair_is_either_in_the_table_or_rejected() {
        let mut legal = 0;
        for s in ALL_STATUSES {
            for t in ALL_TRIGGERS {
                match next(s, t) {
                    Ok(to) => {
                        assert!(TRANSITIONS.contains(&(s, t, to)));
                        legal += 1;
                    }
                    Err(e) => assert_eq!(
                        e,
                        IllegalTransition {
                            from: s,
                            trigger: t
                        }
                    ),
                }
            }
        }
        assert_eq!(legal, TRANSITIONS.len());
    }

    #[test]
    fn terminal_statuses_have_no_exits_and_uncertain_cannot_requeue_directly() {
        for t in ALL_TRIGGERS {
            assert!(next(Status::Completed, t).is_err());
            assert!(next(Status::DeadLetter, t).is_err());
        }
        assert!(next(Status::OutcomeUncertain, Trigger::Requeue).is_err());
        assert!(next(Status::OutcomeUncertain, Trigger::Lease).is_err());
    }

    #[test]
    fn nothing_reaches_executing_except_a_leased_attempt() {
        for (_, t, to) in TRANSITIONS {
            if *to == Status::Executing {
                assert_eq!(*t, Trigger::BeginAttempt);
            }
        }
        // And only an owner-resolved or approved path leads back to queued/leased
        // from a state that may have produced an effect.
        for (f, t, to) in TRANSITIONS {
            if matches!(f, Status::Executing) {
                assert!(!matches!(to, Status::Queued | Status::Leased), "{t}");
            }
        }
    }
}
