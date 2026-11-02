//! Durable action storage and transitions in `majordomo.sqlite`.
//!
//! Every operation takes an explicit `now` in milliseconds (as Node's queue
//! takes `now`) and runs in one `BEGIN IMMEDIATE` transaction that also appends
//! the transition's event, so a state change without its event, or the reverse,
//! cannot be committed. Legality always comes from [`super::state::next`]; an
//! illegal request returns [`ActionError::Illegal`] and writes nothing.
//!
//! Crash semantics: `begin_attempt` commits the `executing` status *before*
//! any capability runs. If the process dies afterwards, the lease eventually
//! expires and [`ActionStore::recover`] moves the action to `outcome_uncertain`;
//! nothing in this module ever moves an action out of that state except
//! [`ActionStore::resolve_uncertain`], an explicit owner decision.

use super::classify::{failure_outcome, retry_delay_ms, ErrorClass, FailureOutcome, RetryPolicy};
use super::state::{next, IllegalTransition, Status, Trigger};
use crate::events::{self, EventError, NewEvent, Party};
use crate::store::{new_id, Store, StoreError};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const MAX_ARGUMENT_BYTES: usize = 256 * 1024;
pub const MAX_ERROR_CHARS: usize = 1_000;
const MAX_NAME_CHARS: usize = 256;
pub const EVENT_SOURCE: &str = "action-queue";
pub const EVENT_TYPE: &str = "action.transition";

#[derive(Debug, thiserror::Error)]
pub enum ActionError {
    #[error("no such action: {0}")]
    NotFound(String),
    #[error("action {id}: {source}")]
    Illegal {
        id: String,
        #[source]
        source: IllegalTransition,
    },
    #[error("action {0} is not leased to this owner")]
    LeaseNotHeld(String),
    #[error("attempt {0} is not executing for this owner")]
    AttemptNotExecuting(String),
    #[error("action {0} needs owner review and cannot be requeued: {1}")]
    ReviewRequired(String, &'static str),
    #[error("action {0} is consequential and has not been approved")]
    ApprovalRequired(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Event(#[from] EventError),
}

impl From<rusqlite::Error> for ActionError {
    fn from(e: rusqlite::Error) -> Self {
        ActionError::Store(StoreError::Sqlite(e))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Action {
    pub id: String,
    pub idempotency_key: String,
    pub tool: String,
    pub arguments: Value,
    pub arguments_sha256: String,
    pub consequential: bool,
    pub correlation_id: Option<String>,
    pub actor: Option<Value>,
    pub status: Status,
    pub attempt_count: u32,
    pub next_attempt_at_ms: i64,
    pub lease_owner: Option<String>,
    pub lease_expires_at_ms: Option<i64>,
    pub last_error: Option<String>,
    pub error_class: Option<ErrorClass>,
    pub approved_by: Option<String>,
    pub approved_at_ms: Option<i64>,
    pub last_event_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attempt {
    pub id: String,
    pub action_id: String,
    pub attempt_number: u32,
    pub lease_owner: String,
    /// `executing`, `completed`, `failed` or `uncertain`.
    pub status: String,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub error: Option<String>,
    pub error_class: Option<ErrorClass>,
}

#[derive(Debug, Clone)]
pub struct NewAction {
    /// Caller-chosen id (Node: `agent_actions.id`); generated when absent.
    pub action_id: Option<String>,
    pub tool: String,
    pub arguments: Value,
    /// Defaults to [`idempotency_key`] of `tool`, `correlation_id`, `action_id`.
    pub idempotency_key: Option<String>,
    /// Needs owner approval before it may be leased.
    pub consequential: bool,
    pub correlation_id: Option<String>,
    pub actor: Option<Value>,
}

impl NewAction {
    pub fn new(tool: impl Into<String>, arguments: Value) -> Self {
        NewAction {
            action_id: None,
            tool: tool.into(),
            arguments,
            idempotency_key: None,
            consequential: false,
            correlation_id: None,
            actor: None,
        }
    }

    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.action_id = Some(id.into());
        self
    }

    pub fn key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    pub fn consequential(mut self) -> Self {
        self.consequential = true;
        self
    }

    pub fn correlation(mut self, id: impl Into<String>) -> Self {
        self.correlation_id = Some(id.into());
        self
    }
}

#[derive(Debug, Clone)]
pub struct Submission {
    pub action: Action,
    /// `false` when the idempotency key (or id) already existed: the stored
    /// action is returned untouched.
    pub created: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RecoveryReport {
    /// Leased but never executing: returned to the queue.
    pub requeued: Vec<String>,
    /// Executing when the lease expired: now `outcome_uncertain`.
    pub uncertain: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// The owner checked: the effect happened. Becomes `completed`.
    ConfirmedDone,
    /// The owner checked: the effect did not happen. Returns to `queued`.
    ConfirmedNotDone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopStatus {
    Failed,
    Cancelled,
    DeadLetter,
}

/// Node: `${tool}:${correlationId || actionId}:${actionId}`.
pub fn idempotency_key(
    tool: &str,
    correlation_id: Option<&str>,
    action_id: &str,
) -> Result<String, ActionError> {
    if tool.is_empty() || action_id.is_empty() {
        return Err(ActionError::Invalid(
            "tool and action id are required for an idempotency key".into(),
        ));
    }
    let middle = correlation_id
        .filter(|c| !c.is_empty())
        .unwrap_or(action_id);
    Ok(format!("{tool}:{middle}:{action_id}"))
}

fn bounded_error(error: &str) -> String {
    error.chars().take(MAX_ERROR_CHARS).collect()
}

pub fn arguments_sha256(arguments: &Value) -> String {
    let canonical = serde_json::to_string(arguments).unwrap_or_default();
    Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

const ACTION_COLUMNS: &str = "id, idempotency_key, tool, arguments, arguments_sha256, \
    consequential, correlation_id, actor, status, attempt_count, next_attempt_at_ms, \
    lease_owner, lease_expires_at_ms, last_error, error_class, approved_by, approved_at_ms, \
    last_event_id, created_at_ms, updated_at_ms";

fn corrupt(idx: usize, ty: rusqlite::types::Type) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnType(idx, "stored value".into(), ty)
}

fn row_to_action(r: &Row<'_>) -> rusqlite::Result<Action> {
    let arguments: String = r.get(3)?;
    let actor: Option<String> = r.get(7)?;
    let status: String = r.get(8)?;
    let class: Option<String> = r.get(14)?;
    Ok(Action {
        id: r.get(0)?,
        idempotency_key: r.get(1)?,
        tool: r.get(2)?,
        arguments: serde_json::from_str(&arguments)
            .map_err(|_| corrupt(3, rusqlite::types::Type::Text))?,
        arguments_sha256: r.get(4)?,
        consequential: r.get::<_, i64>(5)? != 0,
        correlation_id: r.get(6)?,
        actor: actor
            .map(|a| serde_json::from_str(&a))
            .transpose()
            .map_err(|_| corrupt(7, rusqlite::types::Type::Text))?,
        status: Status::parse(&status).ok_or_else(|| corrupt(8, rusqlite::types::Type::Text))?,
        attempt_count: r.get(9)?,
        next_attempt_at_ms: r.get(10)?,
        lease_owner: r.get(11)?,
        lease_expires_at_ms: r.get(12)?,
        last_error: r.get(13)?,
        error_class: class
            .map(|c| ErrorClass::parse(&c).ok_or_else(|| corrupt(14, rusqlite::types::Type::Text)))
            .transpose()?,
        approved_by: r.get(15)?,
        approved_at_ms: r.get(16)?,
        last_event_id: r.get(17)?,
        created_at_ms: r.get(18)?,
        updated_at_ms: r.get(19)?,
    })
}

const ATTEMPT_COLUMNS: &str = "id, action_id, attempt_number, lease_owner, status, started_at_ms, \
    finished_at_ms, error, error_class";

fn row_to_attempt(r: &Row<'_>) -> rusqlite::Result<Attempt> {
    let class: Option<String> = r.get(8)?;
    Ok(Attempt {
        id: r.get(0)?,
        action_id: r.get(1)?,
        attempt_number: r.get(2)?,
        lease_owner: r.get(3)?,
        status: r.get(4)?,
        started_at_ms: r.get(5)?,
        finished_at_ms: r.get(6)?,
        error: r.get(7)?,
        error_class: class
            .map(|c| ErrorClass::parse(&c).ok_or_else(|| corrupt(8, rusqlite::types::Type::Text)))
            .transpose()?,
    })
}

fn load(conn: &Connection, id: &str) -> Result<Action, ActionError> {
    conn.query_row(
        &format!("SELECT {ACTION_COLUMNS} FROM actions WHERE id = ?1"),
        [id],
        row_to_action,
    )
    .optional()?
    .ok_or_else(|| ActionError::NotFound(id.to_string()))
}

fn load_attempt(conn: &Connection, id: &str) -> Result<Attempt, ActionError> {
    conn.query_row(
        &format!("SELECT {ATTEMPT_COLUMNS} FROM action_attempts WHERE id = ?1"),
        [id],
        row_to_attempt,
    )
    .optional()?
    .ok_or_else(|| ActionError::NotFound(id.to_string()))
}

fn check_name(what: &str, value: &str) -> Result<(), ActionError> {
    if value.is_empty()
        || value.chars().count() > MAX_NAME_CHARS
        || value.chars().any(char::is_control)
    {
        return Err(ActionError::Invalid(format!(
            "{what} must be 1 to {MAX_NAME_CHARS} printable characters"
        )));
    }
    Ok(())
}

/// Apply `trigger` to action `id`: check the table, let `mutate` set the new
/// field values (it may refuse), append the transition event, write the row.
/// Called inside the caller's transaction.
fn transition(
    tx: &Connection,
    id: &str,
    trigger: Trigger,
    now: i64,
    extra: Value,
    mutate: impl FnOnce(&mut Action) -> Result<(), ActionError>,
) -> Result<Action, ActionError> {
    let mut a = load(tx, id)?;
    let from = a.status;
    let to = next(from, trigger).map_err(|source| ActionError::Illegal {
        id: id.to_string(),
        source,
    })?;
    mutate(&mut a)?;
    a.status = to;
    a.updated_at_ms = now;
    record_event(tx, &mut a, Some(from), trigger.as_str(), extra, now)?;
    persist(tx, &a, from)?;
    Ok(a)
}

fn record_event(
    tx: &Connection,
    a: &mut Action,
    from: Option<Status>,
    trigger: &str,
    extra: Value,
    now: i64,
) -> Result<(), ActionError> {
    // Ids, states and classes only: never arguments or error text.
    let mut data = json!({
        "from": from.map(Status::as_str),
        "to": a.status.as_str(),
        "trigger": trigger,
        "attemptCount": a.attempt_count,
        "errorClass": a.error_class.map(ErrorClass::as_str),
    });
    if let (Some(map), Value::Object(more)) = (data.as_object_mut(), extra) {
        map.extend(more);
    }
    let event = NewEvent::new(EVENT_TYPE, EVENT_SOURCE)
        .subject(Party::new("action", a.id.clone()))
        .correlation(a.correlation_id.clone())
        .causation(a.last_event_id.clone())
        .data(data);
    a.last_event_id = Some(events::append(tx, &event, now)?.id);
    Ok(())
}

fn persist(tx: &Connection, a: &Action, expected: Status) -> Result<(), ActionError> {
    let changed = tx.execute(
        "UPDATE actions SET status = ?1, attempt_count = ?2, next_attempt_at_ms = ?3,
           lease_owner = ?4, lease_expires_at_ms = ?5, last_error = ?6, error_class = ?7,
           approved_by = ?8, approved_at_ms = ?9, last_event_id = ?10, updated_at_ms = ?11
         WHERE id = ?12 AND status = ?13",
        params![
            a.status.as_str(),
            a.attempt_count,
            a.next_attempt_at_ms,
            a.lease_owner,
            a.lease_expires_at_ms,
            a.last_error,
            a.error_class.map(ErrorClass::as_str),
            a.approved_by,
            a.approved_at_ms,
            a.last_event_id,
            a.updated_at_ms,
            a.id,
            expected.as_str(),
        ],
    )?;
    if changed != 1 {
        return Err(ActionError::Invalid(format!(
            "action {} changed concurrently",
            a.id
        )));
    }
    Ok(())
}

fn clear_lease(a: &mut Action) {
    a.lease_owner = None;
    a.lease_expires_at_ms = None;
}

fn require_owner(a: &Action, owner: &str) -> Result<(), ActionError> {
    if a.lease_owner.as_deref() != Some(owner) {
        return Err(ActionError::LeaseNotHeld(a.id.clone()));
    }
    Ok(())
}

#[derive(Clone)]
pub struct ActionStore {
    store: Arc<Store>,
}

impl ActionStore {
    pub fn new(store: Arc<Store>) -> Self {
        ActionStore { store }
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    fn write<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        self.store.with_conn(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })
    }

    /// Persist an action exactly once. The same idempotency key (or action id)
    /// returns the existing action untouched, whatever state it is in.
    pub fn submit(&self, new: &NewAction, now: i64) -> Result<Submission, ActionError> {
        check_name("tool", &new.tool)?;
        let arguments = serde_json::to_string(&new.arguments)
            .map_err(|e| ActionError::Invalid(format!("arguments are not serializable: {e}")))?;
        if arguments.len() > MAX_ARGUMENT_BYTES {
            return Err(ActionError::Invalid(format!(
                "arguments are {} bytes, over the {MAX_ARGUMENT_BYTES}-byte limit",
                arguments.len()
            )));
        }
        if let Some(id) = &new.action_id {
            check_name("action id", id)?;
        }
        let key = match (&new.idempotency_key, &new.action_id) {
            (Some(k), _) => {
                check_name("idempotency key", k)?;
                k.clone()
            }
            (None, Some(id)) => idempotency_key(&new.tool, new.correlation_id.as_deref(), id)?,
            (None, None) => {
                return Err(ActionError::Invalid(
                    "an idempotency key or an action id is required".into(),
                ))
            }
        };
        let actor = new
            .actor
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| ActionError::Invalid(e.to_string()))?;
        self.write(|tx| {
            let existing: Option<Action> = tx
                .query_row(
                    &format!(
                        "SELECT {ACTION_COLUMNS} FROM actions WHERE idempotency_key = ?1 OR id = ?2"
                    ),
                    params![key, new.action_id.as_deref().unwrap_or("")],
                    row_to_action,
                )
                .optional()?;
            if let Some(action) = existing {
                return Ok(Submission {
                    action,
                    created: false,
                });
            }
            let id = match &new.action_id {
                Some(id) => id.clone(),
                None => new_id("act")?,
            };
            let status = if new.consequential {
                Status::AwaitingApproval
            } else {
                Status::Queued
            };
            tx.execute(
                "INSERT INTO actions (id, idempotency_key, tool, arguments, arguments_sha256,
                   consequential, correlation_id, actor, status, attempt_count,
                   next_attempt_at_ms, created_at_ms, updated_at_ms)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10,?10,?10)",
                params![
                    id,
                    key,
                    new.tool,
                    arguments,
                    arguments_sha256(&new.arguments),
                    i64::from(new.consequential),
                    new.correlation_id,
                    actor,
                    status.as_str(),
                    now,
                ],
            )?;
            let mut action = load(tx, &id)?;
            let extra = json!({"tool": action.tool, "consequential": action.consequential});
            record_event(tx, &mut action, None, "submit", extra, now)?;
            persist(tx, &action, status)?;
            Ok(Submission {
                action,
                created: true,
            })
        })
    }

    pub fn approve(&self, id: &str, by: &str, now: i64) -> Result<Action, ActionError> {
        check_name("approver", by)?;
        self.write(|tx| {
            transition(tx, id, Trigger::Approve, now, json!({"by": by}), |a| {
                a.approved_by = Some(by.to_string());
                a.approved_at_ms = Some(now);
                a.next_attempt_at_ms = now;
                Ok(())
            })
        })
    }

    pub fn reject(&self, id: &str, by: &str, now: i64) -> Result<Action, ActionError> {
        check_name("rejecter", by)?;
        self.write(|tx| {
            transition(tx, id, Trigger::Reject, now, json!({"by": by}), |a| {
                a.last_error = Some("Rejected by owner".into());
                a.error_class = Some(ErrorClass::OwnerAttentionRequired);
                Ok(())
            })
        })
    }

    /// Cancel an action that has not started (queued, retry_wait or awaiting
    /// approval). A leased or executing action cannot be cancelled here.
    pub fn cancel(&self, id: &str, now: i64) -> Result<Action, ActionError> {
        self.write(|tx| {
            transition(tx, id, Trigger::Cancel, now, json!({}), |a| {
                a.last_error = Some("Cancelled before attempt".into());
                a.error_class = Some(ErrorClass::NonRetryable);
                Ok(())
            })
        })
    }

    /// Handle every expired lease. A lease that never reached execution goes
    /// back to the queue; an executing one becomes `outcome_uncertain` and its
    /// attempt is closed as `uncertain`. Idempotent; safe at every start.
    pub fn recover(&self, now: i64) -> Result<RecoveryReport, ActionError> {
        self.write(|tx| {
            let ids: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT id FROM actions WHERE status IN ('leased','executing')
                       AND lease_expires_at_ms <= ?1 ORDER BY created_at_ms, id",
                )?;
                let rows = stmt.query_map([now], |r| r.get(0))?;
                rows.collect::<Result<_, _>>()?
            };
            let mut report = RecoveryReport::default();
            for id in ids {
                let was_executing = transition(
                    tx,
                    &id,
                    Trigger::ExpireLease,
                    now,
                    json!({}),
                    |a| {
                        let executing = a.status == Status::Executing;
                        clear_lease(a);
                        if executing {
                            a.last_error = Some(
                                "lease expired during execution; the outcome is unknown".into(),
                            );
                            a.error_class = Some(ErrorClass::OutcomeUncertain);
                        } else {
                            a.next_attempt_at_ms = now;
                        }
                        Ok(())
                    },
                )?
                .status
                    == Status::OutcomeUncertain;
                if was_executing {
                    tx.execute(
                        "UPDATE action_attempts SET status = 'uncertain', finished_at_ms = ?1,
                           error = 'lease expired during execution', error_class = 'outcome_uncertain'
                         WHERE action_id = ?2 AND status = 'executing'",
                        params![now, id],
                    )?;
                    report.uncertain.push(id);
                } else {
                    report.requeued.push(id);
                }
            }
            Ok(report)
        })
    }

    /// Lease the next due action. Consequential actions are only eligible once
    /// approved. Expired leases are recovered first, so an action that was
    /// executing when its owner died is never handed out again.
    pub fn lease_next(
        &self,
        owner: &str,
        lease_ms: i64,
        now: i64,
    ) -> Result<Option<Action>, ActionError> {
        self.lease(None, owner, lease_ms, now)
    }

    pub fn lease_action(
        &self,
        id: &str,
        owner: &str,
        lease_ms: i64,
        now: i64,
    ) -> Result<Option<Action>, ActionError> {
        self.lease(Some(id), owner, lease_ms, now)
    }

    fn lease(
        &self,
        id: Option<&str>,
        owner: &str,
        lease_ms: i64,
        now: i64,
    ) -> Result<Option<Action>, ActionError> {
        check_name("lease owner", owner)?;
        if lease_ms <= 0 {
            return Err(ActionError::Invalid("lease_ms must be positive".into()));
        }
        self.recover(now)?;
        self.write(|tx| {
            let candidate: Option<String> = tx
                .query_row(
                    "SELECT id FROM actions
                     WHERE status IN ('queued','retry_wait') AND next_attempt_at_ms <= ?1
                       AND (consequential = 0 OR approved_at_ms IS NOT NULL)
                       AND (?2 IS NULL OR id = ?2)
                     ORDER BY next_attempt_at_ms, created_at_ms, id LIMIT 1",
                    params![now, id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(candidate) = candidate else {
                return Ok(None);
            };
            transition(
                tx,
                &candidate,
                Trigger::Lease,
                now,
                json!({"leaseOwner": owner}),
                |a| {
                    a.lease_owner = Some(owner.to_string());
                    a.lease_expires_at_ms = Some(now.saturating_add(lease_ms));
                    Ok(())
                },
            )
            .map(Some)
        })
    }

    /// Extend a live lease. Not a state change, so no event.
    pub fn renew_lease(
        &self,
        id: &str,
        owner: &str,
        lease_ms: i64,
        now: i64,
    ) -> Result<bool, ActionError> {
        if lease_ms <= 0 {
            return Err(ActionError::Invalid("lease_ms must be positive".into()));
        }
        self.write(|tx| {
            let n = tx.execute(
                "UPDATE actions SET lease_expires_at_ms = ?1, updated_at_ms = ?2
                 WHERE id = ?3 AND status IN ('leased','executing') AND lease_owner = ?4
                   AND lease_expires_at_ms > ?2",
                params![now.saturating_add(lease_ms), now, id, owner],
            )?;
            Ok(n == 1)
        })
    }

    /// Record that an attempt is starting. After this commits the action is
    /// `executing`: from here on a crash means `outcome_uncertain`.
    pub fn begin_attempt(&self, id: &str, owner: &str, now: i64) -> Result<Attempt, ActionError> {
        self.write(|tx| {
            let action = transition(
                tx,
                id,
                Trigger::BeginAttempt,
                now,
                json!({}),
                |a| {
                    require_owner(a, owner)?;
                    if a.lease_expires_at_ms.is_none_or(|e| e <= now) {
                        return Err(ActionError::LeaseNotHeld(a.id.clone()));
                    }
                    a.attempt_count += 1;
                    Ok(())
                },
            )?;
            let attempt_id = new_id("att")?;
            tx.execute(
                "INSERT INTO action_attempts (id, action_id, attempt_number, lease_owner, status, started_at_ms)
                 VALUES (?1, ?2, ?3, ?4, 'executing', ?5)",
                params![attempt_id, id, action.attempt_count, owner, now],
            )?;
            load_attempt(tx, &attempt_id)
        })
    }

    fn settle(
        &self,
        attempt_id: &str,
        owner: &str,
        now: i64,
        choose: impl FnOnce(&Attempt) -> (Trigger, &'static str, Option<(String, ErrorClass)>, i64),
    ) -> Result<Action, ActionError> {
        self.write(|tx| {
            let attempt = load_attempt(tx, attempt_id)?;
            if attempt.status != "executing" || attempt.lease_owner != owner {
                return Err(ActionError::AttemptNotExecuting(attempt_id.to_string()));
            }
            let (trigger, attempt_status, failure, next_attempt) = choose(&attempt);
            let class = failure.as_ref().map(|(_, c)| *c);
            let message = failure.as_ref().map(|(m, _)| bounded_error(m));
            let action = transition(tx, &attempt.action_id, trigger, now, json!({}), |a| {
                require_owner(a, owner)?;
                clear_lease(a);
                a.last_error = message.clone();
                a.error_class = class;
                if next_attempt > 0 {
                    a.next_attempt_at_ms = next_attempt;
                }
                Ok(())
            })?;
            tx.execute(
                "UPDATE action_attempts SET status = ?1, finished_at_ms = ?2, error = ?3, error_class = ?4
                 WHERE id = ?5 AND status = 'executing'",
                params![attempt_status, now, message, class.map(ErrorClass::as_str), attempt_id],
            )?;
            Ok(action)
        })
    }

    pub fn complete_attempt(
        &self,
        attempt_id: &str,
        owner: &str,
        now: i64,
    ) -> Result<Action, ActionError> {
        self.settle(attempt_id, owner, now, |_| {
            (Trigger::Complete, "completed", None, 0)
        })
    }

    /// Settle a failed attempt the way Node's `failActionAttempt` does:
    /// retryable errors back off exponentially until `max_attempts`, then
    /// become `dead_letter`; other classes are terminal `failed`. Rust only: an
    /// `outcome_uncertain` class becomes the `outcome_uncertain` status.
    pub fn fail_attempt(
        &self,
        attempt_id: &str,
        owner: &str,
        error: &str,
        class: ErrorClass,
        policy: RetryPolicy,
        now: i64,
    ) -> Result<Action, ActionError> {
        if policy.max_attempts < 1 {
            return Err(ActionError::Invalid(
                "max_attempts must be at least 1".into(),
            ));
        }
        if retry_delay_ms(1, policy.base_delay_ms, policy.max_delay_ms).is_none() {
            return Err(ActionError::Invalid("retry delays must be positive".into()));
        }
        self.settle(attempt_id, owner, now, |attempt| {
            let outcome = failure_outcome(class, attempt.attempt_number, policy.max_attempts);
            let message = Some((error.to_string(), class));
            match outcome {
                FailureOutcome::Retry => {
                    let delay = retry_delay_ms(
                        attempt.attempt_number,
                        policy.base_delay_ms,
                        policy.max_delay_ms,
                    )
                    .unwrap_or(policy.max_delay_ms);
                    (
                        Trigger::FailRetry,
                        "failed",
                        message,
                        now.saturating_add(delay),
                    )
                }
                FailureOutcome::DeadLetter => (Trigger::FailDeadLetter, "failed", message, now),
                FailureOutcome::Terminal => (Trigger::FailTerminal, "failed", message, now),
                FailureOutcome::Uncertain => (Trigger::MarkUncertain, "uncertain", message, now),
            }
        })
    }

    /// End a leased action without attempting it (denied, stale, tampered...).
    pub fn stop_leased(
        &self,
        id: &str,
        owner: &str,
        status: StopStatus,
        error: &str,
        class: ErrorClass,
        now: i64,
    ) -> Result<Action, ActionError> {
        let trigger = match status {
            StopStatus::Failed => Trigger::StopFailed,
            StopStatus::Cancelled => Trigger::StopCancelled,
            StopStatus::DeadLetter => Trigger::StopDeadLetter,
        };
        self.write(|tx| {
            transition(tx, id, trigger, now, json!({}), |a| {
                require_owner(a, owner)?;
                clear_lease(a);
                a.last_error = Some(bounded_error(error));
                a.error_class = Some(class);
                Ok(())
            })
        })
    }

    /// Owner command: put a failed or cancelled action back in the queue.
    /// Refused for `recovery_review_required` / `outcome_uncertain` classes
    /// (as in Node) and for a consequential action that was never approved.
    pub fn requeue(&self, id: &str, now: i64) -> Result<Action, ActionError> {
        self.write(|tx| {
            let current = load(tx, id)?;
            match current.error_class {
                Some(ErrorClass::RecoveryReviewRequired) => {
                    return Err(ActionError::ReviewRequired(
                        id.to_string(),
                        "restored action requires a fresh proposal",
                    ))
                }
                Some(ErrorClass::OutcomeUncertain) => {
                    return Err(ActionError::ReviewRequired(
                        id.to_string(),
                        "delivery outcome is uncertain; resolve it instead",
                    ))
                }
                _ => {}
            }
            transition(tx, id, Trigger::Requeue, now, json!({}), |a| {
                if a.consequential && a.approved_at_ms.is_none() {
                    return Err(ActionError::ApprovalRequired(a.id.clone()));
                }
                a.next_attempt_at_ms = now;
                clear_lease(a);
                a.last_error = None;
                a.error_class = None;
                Ok(())
            })
        })
    }

    /// The only way out of `outcome_uncertain`: the owner says what happened.
    pub fn resolve_uncertain(
        &self,
        id: &str,
        resolution: Resolution,
        by: &str,
        now: i64,
    ) -> Result<Action, ActionError> {
        check_name("resolver", by)?;
        let (trigger, label) = match resolution {
            Resolution::ConfirmedDone => (Trigger::ResolveDone, "confirmed_done"),
            Resolution::ConfirmedNotDone => (Trigger::ResolveNotDone, "confirmed_not_done"),
        };
        self.write(|tx| {
            transition(
                tx,
                id,
                trigger,
                now,
                json!({"resolution": label, "by": by}),
                |a| {
                    a.last_error = None;
                    a.error_class = None;
                    if resolution == Resolution::ConfirmedNotDone {
                        a.next_attempt_at_ms = now;
                    }
                    Ok(())
                },
            )
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Action>, ActionError> {
        self.store.with_conn(|c| {
            c.query_row(
                &format!("SELECT {ACTION_COLUMNS} FROM actions WHERE id = ?1"),
                [id],
                row_to_action,
            )
            .optional()
            .map_err(ActionError::from)
        })
    }

    pub fn get_by_key(&self, key: &str) -> Result<Option<Action>, ActionError> {
        self.store.with_conn(|c| {
            c.query_row(
                &format!("SELECT {ACTION_COLUMNS} FROM actions WHERE idempotency_key = ?1"),
                [key],
                row_to_action,
            )
            .optional()
            .map_err(ActionError::from)
        })
    }

    /// Oldest first, optionally one status.
    pub fn list(&self, status: Option<Status>, limit: usize) -> Result<Vec<Action>, ActionError> {
        list_actions(self.store.as_ref(), status, limit)
    }

    pub fn attempts(&self, id: &str) -> Result<Vec<Attempt>, ActionError> {
        list_attempts(self.store.as_ref(), id)
    }
}

/// Read helpers usable on a read-only store too (CLI and API).
pub fn list_actions(
    store: &Store,
    status: Option<Status>,
    limit: usize,
) -> Result<Vec<Action>, ActionError> {
    let limit = i64::try_from(limit.clamp(1, 500)).unwrap_or(500);
    store.with_conn(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {ACTION_COLUMNS} FROM actions WHERE (?1 IS NULL OR status = ?1)
             ORDER BY created_at_ms, id LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![status.map(Status::as_str), limit], row_to_action)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

pub fn get_action(store: &Store, id: &str) -> Result<Option<Action>, ActionError> {
    store.with_conn(|c| {
        c.query_row(
            &format!("SELECT {ACTION_COLUMNS} FROM actions WHERE id = ?1"),
            [id],
            row_to_action,
        )
        .optional()
        .map_err(ActionError::from)
    })
}

pub fn list_attempts(store: &Store, id: &str) -> Result<Vec<Attempt>, ActionError> {
    store.with_conn(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM action_attempts WHERE action_id = ?1 ORDER BY attempt_number"
        ))?;
        let rows = stmt.query_map([id], row_to_attempt)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}
