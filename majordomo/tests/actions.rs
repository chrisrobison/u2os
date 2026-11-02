//! Behaviour of the durable action state machine, events and crash recovery.
//! All capabilities are mocks; every test uses its own temporary home.

use majordomo::actions::classify::{ErrorClass, RetryPolicy};
use majordomo::actions::mock::{
    CountingCapability, EffectLog, FailingCapability, HangingCapability, MockAuthorizer,
    PanicCapability,
};
use majordomo::actions::{
    ActionError, ActionStore, Capability, CapabilityError, CapabilityRegistry, NewAction,
    Resolution, Runtime, Status, Trigger,
};
use majordomo::clock::ManualClock;
use majordomo::events::{read_after, Cursor, EventBus};
use majordomo::store::{store_path, Store};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;

struct Env {
    dir: TempDir,
    store: Arc<Store>,
    actions: ActionStore,
    bus: Arc<EventBus>,
    clock: Arc<ManualClock>,
}

fn data_dir(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join("majordomo")
}

fn open(dir: TempDir, start: i64) -> Env {
    let store = Arc::new(Store::open(&store_path(&data_dir(&dir))).unwrap());
    let clock = Arc::new(ManualClock::new(start));
    let bus = Arc::new(EventBus::new(store.clone(), clock.clone()).unwrap());
    Env {
        actions: ActionStore::new(store.clone()),
        store,
        bus,
        clock,
        dir,
    }
}

fn env() -> Env {
    open(
        tempfile::Builder::new().prefix("mja").tempdir().unwrap(),
        1_000_000,
    )
}

fn runtime(e: &Env, tool: &str, cap: Arc<dyn Capability>, worker: &str) -> Runtime {
    let mut reg = CapabilityRegistry::new();
    reg.register(tool, cap);
    Runtime::new(
        e.actions.clone(),
        e.bus.clone(),
        reg,
        MockAuthorizer::allow_all(),
        e.clock.clone(),
        worker,
    )
}

fn event_count(e: &Env) -> usize {
    e.store.with_conn(|c| read_after(c, 0, 2000)).unwrap().len()
}

fn retryable() -> CapabilityError {
    CapabilityError::new("timeout")
        .with_code("ETIMEDOUT")
        .safe_to_retry()
}

#[test]
fn happy_path_runs_once_and_records_every_transition() {
    let e = env();
    let log = EffectLog::new();
    let rt = runtime(
        &e,
        "mock.do",
        Arc::new(CountingCapability::new(log.clone())),
        "w1",
    );
    let new = NewAction::new("mock.do", json!({"secret": "hunter2"}))
        .id("a1")
        .correlation("c1");
    let sub = e.actions.submit(&new, e.now()).unwrap();
    assert!(sub.created);
    let out = rt.process_next().unwrap().unwrap();
    assert_eq!(out.status, Status::Completed);
    assert_eq!(log.count(), 1);
    assert!(rt.process_next().unwrap().is_none());
    assert_eq!(log.count(), 1);

    let events = e.store.with_conn(|c| read_after(c, 0, 100)).unwrap();
    let tos: Vec<_> = events
        .iter()
        .map(|ev| ev.data["to"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(tos, ["queued", "leased", "executing", "completed"]);
    // Correlated, causally chained, and free of arguments.
    for (i, ev) in events.iter().enumerate() {
        assert_eq!(ev.correlation_id.as_deref(), Some("c1"));
        assert_eq!(ev.subject.as_ref().unwrap().id, "a1");
        assert_eq!(
            ev.causation_id.as_ref(),
            i.checked_sub(1).map(|p| &events[p].id)
        );
        assert!(!ev.data.to_string().contains("hunter2"));
    }
    assert_eq!(
        e.actions.get("a1").unwrap().unwrap().last_event_id.as_ref(),
        Some(&events[3].id)
    );
}

#[test]
fn idempotent_submit_returns_the_same_action_and_never_resets_it() {
    let e = env();
    let a = e
        .actions
        .submit(&NewAction::new("t", json!({})).key("k1"), 10)
        .unwrap();
    let rt = runtime(
        &e,
        "t",
        Arc::new(CountingCapability::new(EffectLog::new())),
        "w",
    );
    e.clock.set(20);
    rt.process_next().unwrap();
    let b = e
        .actions
        .submit(&NewAction::new("t", json!({"changed": 1})).key("k1"), 30)
        .unwrap();
    assert!(!b.created);
    assert_eq!(b.action.id, a.action.id);
    assert_eq!(b.action.status, Status::Completed);
    assert_eq!(b.action.arguments, json!({}));
    assert_eq!(e.actions.list(None, 100).unwrap().len(), 1);
    // The same caller-supplied id with another key is also the same action.
    let c = e
        .actions
        .submit(
            &NewAction::new("t", json!({})).id(&a.action.id).key("other"),
            40,
        )
        .unwrap();
    assert!(!c.created);
    assert_eq!(e.actions.list(None, 100).unwrap().len(), 1);
    // Unique at the database too.
    let dup = e.store.with_conn(|c| -> Result<_, majordomo::store::StoreError> {
        Ok(c.execute(
            "INSERT INTO actions (id, idempotency_key, tool, arguments, arguments_sha256, consequential, status, next_attempt_at_ms, created_at_ms, updated_at_ms) VALUES ('x','k1','t','{}','',0,'queued',0,0,0)",
            [],
        ))
    });
    assert!(dup.unwrap().is_err());
}

#[test]
fn illegal_transitions_are_typed_errors_and_change_nothing() {
    let e = env();
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("a"), 1)
        .unwrap()
        .action
        .id;
    let before = e.actions.get(&id).unwrap().unwrap();
    let events = event_count(&e);
    let illegal = |r: Result<_, ActionError>, trigger: Trigger| match r {
        Err(ActionError::Illegal { source, .. }) => assert_eq!(source.trigger, trigger),
        other => panic!("expected an illegal transition, got {other:?}"),
    };
    illegal(
        e.actions.approve(&id, "owner", 2).map(|_| ()),
        Trigger::Approve,
    );
    illegal(e.actions.requeue(&id, 2).map(|_| ()), Trigger::Requeue);
    illegal(
        e.actions.begin_attempt(&id, "w", 2).map(|_| ()),
        Trigger::BeginAttempt,
    );
    illegal(
        e.actions
            .resolve_uncertain(&id, Resolution::ConfirmedDone, "owner", 2)
            .map(|_| ()),
        Trigger::ResolveDone,
    );
    illegal(
        e.actions
            .stop_leased(
                &id,
                "w",
                majordomo::actions::StopStatus::Failed,
                "x",
                ErrorClass::NonRetryable,
                2,
            )
            .map(|_| ()),
        Trigger::StopFailed,
    );
    assert!(matches!(
        e.actions.complete_attempt("att_none", "w", 2),
        Err(ActionError::NotFound(_))
    ));
    assert!(matches!(
        e.actions.cancel("missing", 2),
        Err(ActionError::NotFound(_))
    ));
    assert_eq!(e.actions.get(&id).unwrap().unwrap(), before);
    assert_eq!(event_count(&e), events);
}

#[test]
fn consequential_actions_need_approval_before_they_can_lease() {
    let e = env();
    let log = EffectLog::new();
    let rt = runtime(&e, "t", Arc::new(CountingCapability::new(log.clone())), "w");
    let id = e
        .actions
        .submit(
            &NewAction::new("t", json!({"to": "x"}))
                .id("c1")
                .consequential(),
            1,
        )
        .unwrap()
        .action
        .id;
    assert_eq!(
        e.actions.get(&id).unwrap().unwrap().status,
        Status::AwaitingApproval
    );
    e.clock.set(100);
    assert!(rt.process_next().unwrap().is_none());
    assert_eq!(log.count(), 0);
    // Defense in depth: even a queued row without an approval stamp is not leased.
    e.store
        .with_conn(|c| -> Result<_, majordomo::store::StoreError> {
            Ok(c.execute("UPDATE actions SET status='queued' WHERE id='c1'", [])?)
        })
        .unwrap();
    assert!(rt.process_next().unwrap().is_none());
    e.store
        .with_conn(|c| -> Result<_, majordomo::store::StoreError> {
            Ok(c.execute(
                "UPDATE actions SET status='awaiting_approval' WHERE id='c1'",
                [],
            )?)
        })
        .unwrap();
    e.actions.approve(&id, "owner", 200).unwrap();
    e.clock.set(300);
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::Completed
    );
    assert_eq!(log.count(), 1);
}

#[test]
fn rejected_consequential_action_cannot_be_requeued_without_approval() {
    let e = env();
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("c").consequential(), 1)
        .unwrap()
        .action
        .id;
    assert_eq!(
        e.actions.reject(&id, "owner", 2).unwrap().status,
        Status::Cancelled
    );
    assert!(matches!(
        e.actions.requeue(&id, 3),
        Err(ActionError::ApprovalRequired(_))
    ));
    assert_eq!(
        e.actions.get(&id).unwrap().unwrap().status,
        Status::Cancelled
    );
}

#[test]
fn authorizer_denial_and_tampered_arguments_stop_before_any_effect() {
    let e = env();
    let log = EffectLog::new();
    let mut reg = CapabilityRegistry::new();
    reg.register("t", Arc::new(CountingCapability::new(log.clone())));
    let auth = MockAuthorizer::deny_all("blocked by policy", ErrorClass::NonRetryable);
    let rt = Runtime::new(
        e.actions.clone(),
        e.bus.clone(),
        reg,
        auth.clone(),
        e.clock.clone(),
        "w",
    );
    e.actions
        .submit(&NewAction::new("t", json!({})).id("a"), 1)
        .unwrap();
    e.clock.set(10);
    let out = rt.process_next().unwrap().unwrap();
    assert_eq!(
        (out.status, out.error_class),
        (Status::Cancelled, Some(ErrorClass::NonRetryable))
    );
    assert_eq!(log.count(), 0);

    auth.set_deny(None);
    e.actions
        .submit(&NewAction::new("t", json!({"a": 1})).id("b"), 20)
        .unwrap();
    e.store
        .with_conn(|c| -> Result<_, majordomo::store::StoreError> {
            Ok(c.execute("UPDATE actions SET arguments='{\"a\":2}' WHERE id='b'", [])?)
        })
        .unwrap();
    e.clock.set(30);
    let out = rt.process_next().unwrap().unwrap();
    assert_eq!(
        (out.status, out.error_class),
        (Status::Failed, Some(ErrorClass::OwnerAttentionRequired))
    );
    assert_eq!(log.count(), 0);

    e.actions
        .submit(&NewAction::new("unknown.tool", json!({})).id("c"), 40)
        .unwrap();
    e.clock.set(50);
    assert_eq!(rt.process_next().unwrap().unwrap().status, Status::Failed);
}

#[test]
fn expired_lease_is_recovered_to_the_queue_and_leased_by_someone_else() {
    let e = env();
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap()
        .action
        .id;
    e.actions.lease_next("old", 1000, 10).unwrap().unwrap();
    assert!(e.actions.lease_next("new", 1000, 1009).unwrap().is_none());
    assert!(e.actions.renew_lease(&id, "old", 1000, 500).unwrap());
    assert!(!e.actions.renew_lease(&id, "intruder", 1000, 500).unwrap());
    assert!(e.actions.lease_next("new", 1000, 1499).unwrap().is_none());
    let report = e.actions.recover(1500).unwrap();
    assert_eq!(report.requeued, std::slice::from_ref(&id));
    assert!(report.uncertain.is_empty());
    assert_eq!(e.actions.recover(1500).unwrap(), Default::default());
    let a = e.actions.lease_next("new", 1000, 1500).unwrap().unwrap();
    assert_eq!(a.lease_owner.as_deref(), Some("new"));
    // The old owner can no longer begin an attempt.
    assert!(matches!(
        e.actions.begin_attempt(&id, "old", 1501),
        Err(ActionError::LeaseNotHeld(_))
    ));
    assert!(e.actions.begin_attempt(&id, "new", 1501).is_ok());
}

#[test]
fn retryable_failures_back_off_then_dead_letter() {
    let e = env();
    let log = EffectLog::new();
    let cap = FailingCapability::new(log.clone(), vec![retryable(), retryable(), retryable()]);
    let rt = runtime(&e, "t", Arc::new(cap), "w").with_retry(RetryPolicy {
        max_attempts: 3,
        base_delay_ms: 1000,
        max_delay_ms: 60_000,
    });
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap()
        .action
        .id;
    e.clock.set(0);
    let o = rt.process_next().unwrap().unwrap();
    assert_eq!(o.status, Status::RetryWait);
    assert_eq!(
        e.actions.get(&id).unwrap().unwrap().next_attempt_at_ms,
        1000
    );
    e.clock.set(999);
    assert!(rt.process_next().unwrap().is_none());
    e.clock.set(1000);
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::RetryWait
    );
    assert_eq!(
        e.actions.get(&id).unwrap().unwrap().next_attempt_at_ms,
        3000
    );
    e.clock.set(3000);
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::DeadLetter
    );
    e.clock.set(10_000_000);
    assert!(rt.process_next().unwrap().is_none());
    assert_eq!(log.count(), 0);
    let attempts = e.actions.attempts(&id).unwrap();
    assert_eq!(attempts.len(), 3);
    assert!(attempts.iter().all(|a| a.status == "failed"));
    assert!(matches!(
        e.actions.requeue(&id, 1),
        Err(ActionError::Illegal { .. })
    ));
}

#[test]
fn retry_then_success_records_a_single_effect() {
    let e = env();
    let log = EffectLog::new();
    let cap = FailingCapability::new(log.clone(), vec![retryable()]);
    let rt = runtime(&e, "t", Arc::new(cap), "w");
    e.actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap();
    e.clock.set(0);
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::RetryWait
    );
    e.clock.set(5000);
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::Completed
    );
    assert_eq!(log.count(), 1);
}

#[test]
fn unsafe_retryable_error_on_a_non_idempotent_tool_needs_owner_attention() {
    let e = env();
    // Retryable by code, but not known to be pre-handoff and no idempotency support.
    let cap = FailingCapability::new(
        EffectLog::new(),
        vec![CapabilityError::new("reset").with_code("ECONNRESET")],
    );
    let rt = runtime(&e, "t", Arc::new(cap), "w");
    e.actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap();
    e.clock.set(0);
    let o = rt.process_next().unwrap().unwrap();
    assert_eq!(
        (o.status, o.error_class),
        (Status::Failed, Some(ErrorClass::OwnerAttentionRequired))
    );

    // The same error on an idempotent tool is retried.
    let cap = FailingCapability::new(
        EffectLog::new(),
        vec![CapabilityError::new("reset").with_code("ECONNRESET")],
    )
    .idempotent();
    let rt = runtime(&e, "i", Arc::new(cap), "w");
    e.actions
        .submit(&NewAction::new("i", json!({})).id("b"), 0)
        .unwrap();
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::RetryWait
    );
}

#[test]
fn reported_uncertain_outcome_and_panics_wait_for_the_owner() {
    let e = env();
    let log = EffectLog::new();
    let cap = FailingCapability::new(
        log.clone(),
        vec![CapabilityError::new("timed out after send").with_class(ErrorClass::OutcomeUncertain)],
    );
    let rt = runtime(&e, "t", Arc::new(cap), "w");
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap()
        .action
        .id;
    e.clock.set(0);
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::OutcomeUncertain
    );
    assert_eq!(e.actions.attempts(&id).unwrap()[0].status, "uncertain");

    let plog = EffectLog::new();
    let rt = runtime(
        &e,
        "p",
        Arc::new(PanicCapability { log: plog.clone() }),
        "w",
    );
    let pid = e
        .actions
        .submit(&NewAction::new("p", json!({})).id("b"), 0)
        .unwrap()
        .action
        .id;
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::OutcomeUncertain
    );
    assert_eq!(plog.count(), 1);
    e.clock.set(10_000_000);
    assert!(rt.process_next().unwrap().is_none());
    assert_eq!(plog.count(), 1);
    assert!(e.actions.requeue(&pid, 1).is_err());
}

#[test]
fn owner_resolution_is_the_only_way_out_of_uncertain() {
    let e = env();
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap()
        .action
        .id;
    e.actions.lease_next("w", 1000, 0).unwrap();
    e.actions.begin_attempt(&id, "w", 1).unwrap();
    let report = e.actions.recover(5000).unwrap();
    assert_eq!(report.uncertain, std::slice::from_ref(&id));
    let a = e.actions.get(&id).unwrap().unwrap();
    assert_eq!(
        (a.status, a.error_class, a.lease_owner),
        (
            Status::OutcomeUncertain,
            Some(ErrorClass::OutcomeUncertain),
            None
        )
    );
    assert_eq!(e.actions.attempts(&id).unwrap()[0].status, "uncertain");
    // Never leased, requeued, cancelled or approved by anything automatic.
    assert!(e
        .actions
        .lease_next("w2", 1000, 10_000_000)
        .unwrap()
        .is_none());
    assert!(matches!(
        e.actions.requeue(&id, 6000),
        Err(ActionError::ReviewRequired(..))
    ));
    assert!(matches!(
        e.actions.cancel(&id, 6000),
        Err(ActionError::Illegal { .. })
    ));
    assert_eq!(e.actions.recover(10_000_000).unwrap(), Default::default());
    assert_eq!(
        e.actions.get(&id).unwrap().unwrap().status,
        Status::OutcomeUncertain
    );

    let done = e
        .actions
        .resolve_uncertain(&id, Resolution::ConfirmedDone, "owner", 7000)
        .unwrap();
    assert_eq!(done.status, Status::Completed);

    let id2 = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("b"), 0)
        .unwrap()
        .action
        .id;
    e.actions.lease_next("w", 1000, 20_000).unwrap();
    e.actions.begin_attempt(&id2, "w", 20_001).unwrap();
    e.actions.recover(30_000).unwrap();
    let back = e
        .actions
        .resolve_uncertain(&id2, Resolution::ConfirmedNotDone, "owner", 31_000)
        .unwrap();
    assert_eq!(back.status, Status::Queued);
    assert_eq!(back.attempt_count, 1);
    let resolve_event = e
        .store
        .with_conn(|c| read_after(c, 0, 2000))
        .unwrap()
        .into_iter()
        .rev()
        .find(|ev| ev.data["trigger"] == "resolve_not_done")
        .unwrap();
    assert_eq!(resolve_event.data["by"], "owner");
}

#[test]
fn executing_when_the_process_dies_is_uncertain_and_the_zombie_cannot_settle() {
    let e = env();
    let log = EffectLog::new();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let hang = HangingCapability::new(log.clone(), Some(started_tx), Some(release_rx));
    let old = runtime(&e, "t", Arc::new(hang), "old-process");
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).key("job-1"), 1_000_000)
        .unwrap()
        .action
        .id;
    let zombie = std::thread::spawn(move || old.process_next());
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        e.actions.get(&id).unwrap().unwrap().status,
        Status::Executing
    );

    // "Restart": a fresh store handle on the same file, after the lease expired.
    let reopened = open_same(&e, 1_000_000 + 600_000);
    let new_log = EffectLog::new();
    let rt = runtime(
        &reopened,
        "t",
        Arc::new(CountingCapability::new(new_log.clone())),
        "new-process",
    );
    let report = rt.recover().unwrap();
    assert_eq!(report.uncertain, std::slice::from_ref(&id));
    assert!(rt.process_next().unwrap().is_none());
    let resubmit = reopened
        .actions
        .submit(&NewAction::new("t", json!({})).key("job-1"), 1_700_000)
        .unwrap();
    assert!(!resubmit.created);
    assert_eq!(resubmit.action.id, id);
    assert!(reopened.actions.requeue(&id, 1_700_001).is_err());

    // The old process finally finishes: it cannot rewrite the outcome.
    release_tx.send(()).unwrap();
    let late = zombie.join().unwrap();
    assert!(
        matches!(late, Err(ActionError::AttemptNotExecuting(_))),
        "{late:?}"
    );
    assert_eq!(
        reopened.actions.get(&id).unwrap().unwrap().status,
        Status::OutcomeUncertain
    );
    assert_eq!(log.count(), 1);
    assert_eq!(new_log.count(), 0);
}

fn open_same(e: &Env, start: i64) -> Env {
    let store = Arc::new(Store::open(&store_path(&data_dir(&e.dir))).unwrap());
    let clock = Arc::new(ManualClock::new(start));
    let bus = Arc::new(EventBus::new(store.clone(), clock.clone()).unwrap());
    Env {
        actions: ActionStore::new(store.clone()),
        store,
        bus,
        clock,
        dir: tempfile::Builder::new().prefix("unused").tempdir().unwrap(),
    }
}

#[test]
fn crash_right_after_marking_executing_is_uncertain_even_if_no_effect_ran() {
    let e = env();
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap()
        .action
        .id;
    e.actions.lease_next("w", 1000, 0).unwrap();
    e.actions.begin_attempt(&id, "w", 1).unwrap();
    let dir = e.dir;
    drop((e.actions, e.bus, e.store));
    let e2 = open(dir, 100_000);
    assert_eq!(
        e2.actions.get(&id).unwrap().unwrap().status,
        Status::Executing
    );
    assert_eq!(
        e2.actions.recover(100_000).unwrap().uncertain,
        std::slice::from_ref(&id)
    );
}

#[test]
fn leased_but_not_executing_at_restart_is_safely_requeued() {
    let e = env();
    let id = e
        .actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap()
        .action
        .id;
    e.actions.lease_next("w", 1000, 0).unwrap();
    let dir = e.dir;
    drop((e.actions, e.bus, e.store));
    let e2 = open(dir, 5000);
    assert_eq!(
        e2.actions.recover(5000).unwrap().requeued,
        std::slice::from_ref(&id)
    );
    let log = EffectLog::new();
    let rt = runtime(
        &e2,
        "t",
        Arc::new(CountingCapability::new(log.clone())),
        "w2",
    );
    assert_eq!(
        rt.process_next().unwrap().unwrap().status,
        Status::Completed
    );
    assert_eq!(log.count(), 1);
}

#[test]
fn events_survive_restart_and_replay_from_a_cursor() {
    let e = env();
    let rt = runtime(
        &e,
        "t",
        Arc::new(CountingCapability::new(EffectLog::new())),
        "w",
    );
    e.actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap();
    e.clock.set(0);
    rt.process_next().unwrap();
    let dir = e.dir;
    drop((rt, e.actions, e.bus, e.store));
    let e2 = open(dir, 10);
    let mut sub = e2.bus.subscribe("action.*", Cursor::After(1)).unwrap();
    let mut tos = Vec::new();
    while let Some(ev) = sub.recv_timeout(Duration::from_millis(20)).unwrap() {
        tos.push(ev.data["to"].as_str().unwrap().to_string());
    }
    assert_eq!(tos, ["leased", "executing", "completed"]);
    // A live transition after restart is delivered to a Now subscriber.
    let mut live = e2.bus.subscribe("action.*", Cursor::Now).unwrap();
    e2.actions
        .submit(&NewAction::new("t", json!({})).id("b"), 20)
        .unwrap();
    e2.bus.deliver_pending().unwrap();
    assert_eq!(
        live.recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap()
            .data["trigger"],
        "submit"
    );
}

#[test]
fn node_database_files_are_never_touched() {
    let dir = tempfile::Builder::new().prefix("mjn").tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("db")).unwrap();
    let node_db = dir.path().join("db/u2os.sqlite");
    let node_lock = dir.path().join(".runtime-lock.sqlite");
    std::fs::write(&node_db, b"node database bytes").unwrap();
    std::fs::write(&node_lock, b"node lock bytes").unwrap();
    let before = (
        std::fs::metadata(&node_db).unwrap().modified().unwrap(),
        std::fs::metadata(&node_lock).unwrap().modified().unwrap(),
    );
    assert!(Store::open(&node_db).is_err());
    assert!(Store::open(&node_lock).is_err());
    assert!(Store::open(&dir.path().join("db/majordomo.sqlite")).is_err());
    let e = open(dir, 0);
    e.actions
        .submit(&NewAction::new("t", json!({})).id("a"), 0)
        .unwrap();
    assert_eq!(
        std::fs::read(e.dir.path().join("db/u2os.sqlite")).unwrap(),
        b"node database bytes"
    );
    assert_eq!(
        std::fs::read(e.dir.path().join(".runtime-lock.sqlite")).unwrap(),
        b"node lock bytes"
    );
    let after = (
        std::fs::metadata(e.dir.path().join("db/u2os.sqlite"))
            .unwrap()
            .modified()
            .unwrap(),
        std::fs::metadata(e.dir.path().join(".runtime-lock.sqlite"))
            .unwrap()
            .modified()
            .unwrap(),
    );
    assert_eq!(before, after);
    assert!(e.dir.path().join("majordomo/majordomo.sqlite").exists());
}

impl Env {
    fn now(&self) -> i64 {
        use majordomo::clock::Clock;
        self.clock.now_ms()
    }
}
