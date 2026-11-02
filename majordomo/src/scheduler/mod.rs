//! Leased scheduler with durable slot claims (Phase 4b of the Rust Majordomo
//! migration).
//!
//! **Node remains authoritative.** This module is isolated: routine
//! definitions are supplied programmatically (loading them from the vault is
//! Phase 7), nothing is wired to Node's `routine_runs`, the daemon does not
//! run a ticker, and a "run" only enqueues a mock `routine.run` action through
//! the Phase 4a actions API.
//!
//! Semantics mirror `server/routines/routine-runner.js`:
//! * a `(routine, slot)` pair is claimed with `INSERT OR IGNORE` before any
//!   work, so a slot never runs twice, across restarts, threads or processes;
//! * at most [`MAX_RUNS_PER_HOUR`] non-throttled runs per rolling hour, except
//!   manual runs, which are never throttled but do count;
//! * missed slots are never caught up: a tick claims only the slot that is due
//!   now (`daily` within a grace window, `every` the current window).
//!
//! Additions over Node: a lease row so only one ticker fires at a time, and an
//! idempotency key derived from `(routine, slot)` so a crash between claim and
//! enqueue is repaired by [`Scheduler::recover`] without a duplicate action.

pub mod trigger;
pub mod zone;

use crate::actions::{ActionError, ActionStore, NewAction};
use crate::clock::Clock;
use crate::events::{append, Event, EventBus, EventError, NewEvent, Party};
use crate::store::{new_id, Store, StoreError};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub use trigger::{due_slot, event_matches, Condition, Routine, Trigger};
pub use zone::Zone;

/// Runaway guard, as Node's `MAX_RUNS_PER_HOUR`.
pub const MAX_RUNS_PER_HOUR: i64 = 30;
pub const HOUR_MS: i64 = 3_600_000;
pub const THROTTLE_REASON: &str = "hourly_routine_limit";
/// Node: `DEFAULT_LEASE_MS` of the trigger engine.
pub const DEFAULT_LEASE_MS: i64 = 5 * 60 * 1000;
/// The tool of the mock action a fire creates.
pub const ROUTINE_TOOL: &str = "routine.run";
const MAX_FIELD: usize = 120;

#[derive(Debug, thiserror::Error)]
pub enum SchedulerError {
    #[error("invalid trigger: {0}")]
    InvalidTrigger(String),
    #[error("invalid scheduler input: {0}")]
    Invalid(String),
    #[error("unknown routine: {0}")]
    UnknownRoutine(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Event(#[from] EventError),
    #[error(transparent)]
    Action(#[from] ActionError),
}

/// A claimed slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub run_id: String,
    pub routine: String,
    pub slot: String,
    pub trigger_kind: String,
    pub event_id: Option<String>,
    pub throttled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Enqueued,
    Throttled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FireOutcome {
    pub run_id: String,
    pub routine: String,
    pub slot: String,
    pub status: RunStatus,
    pub action_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickReport {
    /// This scheduler held the lease for the tick.
    pub leader: bool,
    pub fired: Vec<FireOutcome>,
    /// Claims whose enqueue was repaired (run ids).
    pub recovered: Vec<String>,
}

/// One row of `scheduler_runs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Run {
    pub id: String,
    pub routine: String,
    pub slot: String,
    pub trigger_kind: String,
    pub event_id: Option<String>,
    pub status: String,
    pub action_id: Option<String>,
    pub reason: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

const RUN_COLUMNS: &str = "id, routine, slot, trigger_kind, event_id, status, action_id, reason, created_at_ms, updated_at_ms";

fn row_to_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: r.get(0)?,
        routine: r.get(1)?,
        slot: r.get(2)?,
        trigger_kind: r.get(3)?,
        event_id: r.get(4)?,
        status: r.get(5)?,
        action_id: r.get(6)?,
        reason: r.get(7)?,
        created_at_ms: r.get(8)?,
        updated_at_ms: r.get(9)?,
    })
}

/// Newest claims first. Works on a read-only store.
pub fn list_runs(store: &Store, limit: usize) -> Result<Vec<Run>, SchedulerError> {
    let limit = i64::try_from(limit.clamp(1, 500)).unwrap_or(500);
    store.with_conn(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM scheduler_runs ORDER BY created_at_ms DESC, rowid DESC LIMIT ?1"
        ))?;
        let rows = stmt.query_map(params![limit], row_to_run)?;
        Ok::<_, SchedulerError>(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

fn check_field(what: &str, v: &str) -> Result<(), SchedulerError> {
    if v.is_empty() || v.chars().count() > MAX_FIELD || v.chars().any(char::is_control) {
        return Err(SchedulerError::Invalid(format!(
            "{what} must be 1 to {MAX_FIELD} printable characters"
        )));
    }
    Ok(())
}

/// The idempotency key of the action a `(routine, slot)` produces.
pub fn action_key(routine: &str, slot: &str) -> String {
    format!("routine:{routine}:{slot}")
}

pub struct Scheduler {
    store: Arc<Store>,
    actions: ActionStore,
    bus: Arc<EventBus>,
    clock: Arc<dyn Clock>,
    zone: Zone,
    owner: String,
    lease_ms: i64,
    grace_minutes: i64,
    routines: Vec<Routine>,
}

impl Scheduler {
    pub fn new(
        store: Arc<Store>,
        bus: Arc<EventBus>,
        clock: Arc<dyn Clock>,
        zone: Zone,
        owner: impl Into<String>,
    ) -> Scheduler {
        Scheduler {
            actions: ActionStore::new(store.clone()),
            store,
            bus,
            clock,
            zone,
            owner: owner.into(),
            lease_ms: DEFAULT_LEASE_MS,
            grace_minutes: trigger::DEFAULT_GRACE_MINUTES,
            routines: Vec::new(),
        }
    }

    pub fn with_lease_ms(mut self, ms: i64) -> Self {
        self.lease_ms = ms;
        self
    }

    pub fn with_grace_minutes(mut self, m: i64) -> Self {
        self.grace_minutes = m;
        self
    }

    pub fn with_routines(mut self, routines: Vec<Routine>) -> Result<Self, SchedulerError> {
        for (i, r) in routines.iter().enumerate() {
            check_field("routine", &r.path)?;
            if routines[..i].iter().any(|o| o.path == r.path) {
                return Err(SchedulerError::Invalid(format!(
                    "duplicate routine {}",
                    r.path
                )));
            }
        }
        self.routines = routines;
        Ok(self)
    }

    pub fn actions(&self) -> &ActionStore {
        &self.actions
    }

    // ---- lease -------------------------------------------------------

    /// Take or renew the single ticker lease. An unexpired lease held by
    /// another owner is respected; `expires_at <= now` is takeable (Node).
    pub fn acquire_lease(&self) -> Result<bool, SchedulerError> {
        let now = self.clock.now_ms();
        let expires = now + self.lease_ms;
        self.store.with_conn(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let held: Option<(String, i64)> = tx
                .query_row(
                    "SELECT owner, expires_at_ms FROM scheduler_lease WHERE name = 'tick'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let ok = match held {
                Some((owner, until)) if owner != self.owner && until > now => false,
                _ => {
                    tx.execute(
                        "INSERT INTO scheduler_lease (name, owner, expires_at_ms) VALUES ('tick', ?1, ?2)
                         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner,
                           expires_at_ms = excluded.expires_at_ms",
                        params![self.owner, expires],
                    )?;
                    true
                }
            };
            tx.commit()?;
            Ok::<_, SchedulerError>(ok)
        })
    }

    pub fn release_lease(&self) -> Result<(), SchedulerError> {
        self.store.with_conn(|conn| {
            conn.execute(
                "DELETE FROM scheduler_lease WHERE name = 'tick' AND owner = ?1",
                params![self.owner],
            )?;
            Ok::<_, SchedulerError>(())
        })
    }

    // ---- claim and enqueue --------------------------------------------

    /// Step one of a fire: atomically claim `(routine, slot)`. `Ok(None)` when
    /// the slot was already claimed (by anyone, ever). Applies the hourly cap
    /// and records the `routine.fired` / `routine.failed` event in the same
    /// transaction. Does not create the action: see [`Scheduler::enqueue`].
    pub fn claim(
        &self,
        routine: &str,
        slot: &str,
        trigger_kind: &str,
        event_id: Option<&str>,
    ) -> Result<Option<Claim>, SchedulerError> {
        check_field("routine", routine)?;
        check_field("slot", slot)?;
        let now = self.clock.now_ms();
        let run_id = new_id("srun")?;
        let claim = self.store.with_conn(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO scheduler_runs
                   (id, routine, slot, trigger_kind, event_id, status, created_at_ms, updated_at_ms)
                 VALUES (?1,?2,?3,?4,?5,'started',?6,?6)",
                params![run_id, routine, slot, trigger_kind, event_id, now],
            )?;
            if inserted == 0 {
                return Ok::<_, SchedulerError>(None);
            }
            let recent: i64 = tx.query_row(
                "SELECT COUNT(*) FROM scheduler_runs
                 WHERE created_at_ms > ?1 AND status != 'throttled' AND id != ?2",
                params![now - HOUR_MS, run_id],
                |r| r.get(0),
            )?;
            let throttled = trigger_kind != "manual" && recent >= MAX_RUNS_PER_HOUR;
            let actor = Party::new("routine", routine);
            if throttled {
                tx.execute(
                    "UPDATE scheduler_runs SET status = 'throttled', reason = ?2, updated_at_ms = ?3 WHERE id = ?1",
                    params![run_id, THROTTLE_REASON, now],
                )?;
                // Node reports a throttled run as `routine.failed`.
                let ev = NewEvent::new("routine.failed", "routine")
                    .actor(actor)
                    .correlation(Some(run_id.clone()))
                    .data(json!({"routine": routine, "routineRunId": run_id, "reason": THROTTLE_REASON}));
                append(&tx, &ev, now)?;
            } else {
                let ev = NewEvent::new("routine.fired", "routine")
                    .actor(actor)
                    .correlation(Some(run_id.clone()))
                    .data(json!({
                        "routine": routine, "routineRunId": run_id,
                        "trigger": trigger_kind, "slot": slot, "eventId": event_id
                    }));
                append(&tx, &ev, now)?;
            }
            tx.commit()?;
            Ok(Some(Claim {
                run_id: run_id.clone(),
                routine: routine.to_string(),
                slot: slot.to_string(),
                trigger_kind: trigger_kind.to_string(),
                event_id: event_id.map(str::to_string),
                throttled,
            }))
        })?;
        if claim.is_some() {
            if let Err(e) = self.bus.deliver_pending() {
                tracing::warn!(error = %e, "scheduler event delivery failed after persist");
            }
        }
        Ok(claim)
    }

    /// Step two: create the action with the `(routine, slot)` key and mark the
    /// claim `enqueued`. Idempotent: running it again returns the same action.
    pub fn enqueue(&self, claim: &Claim) -> Result<FireOutcome, SchedulerError> {
        if claim.throttled {
            return Ok(FireOutcome {
                run_id: claim.run_id.clone(),
                routine: claim.routine.clone(),
                slot: claim.slot.clone(),
                status: RunStatus::Throttled,
                action_id: None,
            });
        }
        let now = self.clock.now_ms();
        // Only identifiers: triggering event content is never copied (Node).
        let new = NewAction::new(
            ROUTINE_TOOL,
            json!({
                "routine": claim.routine, "slot": claim.slot,
                "trigger": claim.trigger_kind, "eventId": claim.event_id
            }),
        )
        .key(action_key(&claim.routine, &claim.slot))
        .correlation(claim.run_id.clone());
        let sub = self.actions.submit(&new, now)?;
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE scheduler_runs SET status = 'enqueued', action_id = ?2, updated_at_ms = ?3
                 WHERE id = ?1 AND status = 'started'",
                params![claim.run_id, sub.action.id, now],
            )?;
            Ok::<_, SchedulerError>(())
        })?;
        Ok(FireOutcome {
            run_id: claim.run_id.clone(),
            routine: claim.routine.clone(),
            slot: claim.slot.clone(),
            status: RunStatus::Enqueued,
            action_id: Some(sub.action.id),
        })
    }

    /// Claim then enqueue. `Ok(None)` when the slot was already claimed.
    pub fn fire(
        &self,
        routine: &str,
        slot: &str,
        trigger_kind: &str,
        event_id: Option<&str>,
    ) -> Result<Option<FireOutcome>, SchedulerError> {
        match self.claim(routine, slot, trigger_kind, event_id)? {
            None => Ok(None),
            Some(c) => self.enqueue(&c).map(Some),
        }
    }

    /// Repair claims left `started` by a crash between claim and enqueue.
    /// Re-enqueues with the same key, so the action is the same one.
    pub fn recover(&self) -> Result<Vec<String>, SchedulerError> {
        let pending: Vec<Claim> = self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, routine, slot, trigger_kind, event_id FROM scheduler_runs
                 WHERE status = 'started' ORDER BY created_at_ms, rowid",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(Claim {
                    run_id: r.get(0)?,
                    routine: r.get(1)?,
                    slot: r.get(2)?,
                    trigger_kind: r.get(3)?,
                    event_id: r.get(4)?,
                    throttled: false,
                })
            })?;
            Ok::<_, SchedulerError>(rows.collect::<Result<Vec<_>, _>>()?)
        })?;
        let mut done = Vec::new();
        for c in pending {
            self.enqueue(&c)?;
            done.push(c.run_id);
        }
        Ok(done)
    }

    // ---- entry points -------------------------------------------------

    /// One scheduler tick: take the lease (or do nothing), repair interrupted
    /// claims, then claim the slot that is due now for each enabled time-based
    /// routine. Missed slots are not caught up.
    pub fn tick(&self) -> Result<TickReport, SchedulerError> {
        if !self.acquire_lease()? {
            return Ok(TickReport::default());
        }
        let now = self.clock.now_ms();
        let recovered = self.recover()?;
        let mut fired = Vec::new();
        for r in self.routines.iter().filter(|r| r.enabled) {
            let Some(slot) = due_slot(&r.trigger, now, &self.zone, self.grace_minutes) else {
                continue;
            };
            if let Some(out) = self.fire(&r.path, &slot, r.trigger.kind(), None)? {
                fired.push(out);
            }
        }
        Ok(TickReport {
            leader: true,
            fired,
            recovered,
        })
    }

    /// Dispatch one event to matching enabled event routines (slot
    /// `event:<id>`). Needs no lease: the claim is the dedupe. `routine.*`
    /// events are ignored, which bans recursion.
    pub fn on_event(&self, event: &Event) -> Result<Vec<FireOutcome>, SchedulerError> {
        if event.event_type.starts_with("routine.") {
            return Ok(Vec::new());
        }
        let shaped = json!({
            "id": event.id, "type": event.event_type, "source": event.source,
            "data": event.data,
            "actor": event.actor.as_ref().map(|p| json!({"type": p.kind, "id": p.id})),
            "subject": event.subject.as_ref().map(|p| json!({"type": p.kind, "id": p.id})),
        });
        self.on_event_value(&event.id, &shaped)
    }

    /// Like [`Scheduler::on_event`] for a Node-shaped event value.
    pub fn on_event_value(
        &self,
        event_id: &str,
        event: &Value,
    ) -> Result<Vec<FireOutcome>, SchedulerError> {
        if event
            .get("type")
            .and_then(Value::as_str)
            .is_none_or(|t| t.starts_with("routine."))
        {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for r in self.routines.iter().filter(|r| r.enabled) {
            if !event_matches(&r.trigger, event) {
                continue;
            }
            let slot = format!("event:{event_id}");
            if let Some(o) = self.fire(&r.path, &slot, "event", Some(event_id))? {
                out.push(o);
            }
        }
        Ok(out)
    }

    /// Run one routine now on the owner's request, regardless of its trigger
    /// or `enabled`. Never throttled (but counted).
    pub fn run_now(&self, routine: &str) -> Result<FireOutcome, SchedulerError> {
        if !self.routines.iter().any(|r| r.path == routine) {
            return Err(SchedulerError::UnknownRoutine(routine.to_string()));
        }
        let slot = format!("manual:{}", new_id("slot")?);
        Ok(self
            .fire(routine, &slot, "manual", None)?
            .expect("a fresh random slot cannot already be claimed"))
    }
}
