//! Scheduler semantics: slot claims, leases, recovery, no catch-up, the cap.

use majordomo::clock::{Clock, ManualClock};
use majordomo::events::{read_after, EventBus};
use majordomo::scheduler::zone::days_from_civil;
use majordomo::scheduler::{
    action_key, list_runs, Routine, RunStatus, Scheduler, Trigger, Zone, MAX_RUNS_PER_HOUR,
};
use majordomo::store::{store_path, Store};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Barrier};

fn utc(y: i64, m: i64, d: i64, h: i64, mi: i64) -> i64 {
    days_from_civil(y, m, d) * 86_400_000 + (h * 60 + mi) * 60_000
}

fn open(home: &Path) -> Arc<Store> {
    Arc::new(Store::open(&store_path(&home.join("majordomo"))).unwrap())
}

fn routines() -> Vec<Routine> {
    vec![
        Routine::new("brief.md", Trigger::daily(7, 0, None).unwrap()),
        Routine::new("poll.md", Trigger::every(15).unwrap()),
        Routine::new("mail.md", Trigger::event("email.received", None).unwrap()),
    ]
}

fn sched(home: &Path, clock: &Arc<ManualClock>, owner: &str) -> Scheduler {
    let store = open(home);
    let bus = Arc::new(EventBus::new(store.clone(), clock.clone()).unwrap());
    Scheduler::new(store, bus, clock.clone(), Zone::UTC, owner)
        .with_routines(routines())
        .unwrap()
}

fn home() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("mjs").tempdir().unwrap()
}

fn count(s: &Scheduler, table: &str) -> i64 {
    s.actions()
        .store()
        .with_conn(|c| {
            Ok::<_, majordomo::store::StoreError>(
                c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                    .unwrap(),
            )
        })
        .unwrap()
}

#[test]
fn same_slot_fires_once_even_when_repeated() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    let s = sched(h.path(), &clock, "a");
    let first = s.tick().unwrap();
    assert_eq!(first.fired.len(), 2, "daily and every");
    for _ in 0..3 {
        assert!(s.tick().unwrap().fired.is_empty());
    }
    assert_eq!(count(&s, "actions"), 2);
    assert_eq!(count(&s, "scheduler_runs"), 2);
    let a = first
        .fired
        .iter()
        .find(|o| o.routine == "brief.md")
        .unwrap();
    let action = s
        .actions()
        .get_by_key(&action_key("brief.md", "daily:2026-09-28"))
        .unwrap()
        .unwrap();
    assert_eq!(a.action_id.as_deref(), Some(action.id.as_str()));
    assert_eq!(action.tool, "routine.run");
}

#[test]
fn restart_does_not_refire_a_claimed_slot() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    {
        let s = sched(h.path(), &clock, "a");
        assert_eq!(s.tick().unwrap().fired.len(), 2);
    }
    clock.advance(60_000);
    let s = sched(h.path(), &clock, "restarted");
    // The first process's lease is still live: the restarted one waits, then takes over.
    assert!(!s.tick().unwrap().leader);
    clock.advance(6 * 60_000);
    let r = s.tick().unwrap();
    assert!(r.leader);
    assert!(
        r.fired.is_empty(),
        "daily slot is claimed; the 15-minute window is the same"
    );
    assert_eq!(count(&s, "actions"), 2);
}

#[test]
fn crash_between_claim_and_enqueue_yields_exactly_one_action() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    {
        let s = sched(h.path(), &clock, "a");
        let claim = s
            .claim("brief.md", "daily:2026-09-28", "daily", None)
            .unwrap()
            .unwrap();
        assert!(!claim.throttled);
        // "Crash": nothing enqueued, scheduler dropped.
        assert_eq!(count(&s, "actions"), 0);
    }
    let s = sched(h.path(), &clock, "b");
    assert!(s
        .claim("brief.md", "daily:2026-09-28", "daily", None)
        .unwrap()
        .is_none());
    let recovered = s.recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert!(s.recover().unwrap().is_empty());
    assert_eq!(count(&s, "actions"), 1);
    let runs = list_runs(s.actions().store(), 10).unwrap();
    assert_eq!(runs[0].status, "enqueued");
    assert!(runs[0].action_id.is_some());
    // Only one routine.fired for the slot, not one per recovery.
    let fired = fired_count(&s);
    assert_eq!(fired, 1);
}

fn fired_count(s: &Scheduler) -> usize {
    s.actions()
        .store()
        .with_conn(|c| read_after(c, 0, 2000))
        .unwrap()
        .iter()
        .filter(|e| e.event_type == "routine.fired")
        .count()
}

#[test]
fn crash_after_enqueue_before_marking_reuses_the_same_action() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    let s = sched(h.path(), &clock, "a");
    let claim = s
        .claim("poll.md", "every:15:1", "every", None)
        .unwrap()
        .unwrap();
    // The action is created, then the process dies before the claim is updated.
    let direct = s
        .actions()
        .submit(
            &majordomo::actions::NewAction::new("routine.run", json!({"routine": "poll.md"}))
                .key(action_key("poll.md", "every:15:1")),
            clock.now_ms(),
        )
        .unwrap();
    assert!(direct.created);
    let s2 = sched(h.path(), &clock, "b");
    s2.recover().unwrap();
    assert_eq!(count(&s2, "actions"), 1);
    let runs = list_runs(s2.actions().store(), 10).unwrap();
    assert_eq!(runs[0].id, claim.run_id);
    assert_eq!(
        runs[0].action_id.as_deref(),
        Some(direct.action.id.as_str())
    );
}

#[test]
fn racing_event_deliveries_claim_once() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    drop(sched(h.path(), &clock, "init"));
    let barrier = Arc::new(Barrier::new(8));
    let path = h.path().to_path_buf();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let (barrier, clock, path) = (barrier.clone(), clock.clone(), path.clone());
            std::thread::spawn(move || {
                let s = sched(&path, &clock, &format!("t{i}"));
                barrier.wait();
                let ev = json!({"id": "evt_race", "type": "email.received", "data": {}});
                s.on_event_value("evt_race", &ev).unwrap().len()
            })
        })
        .collect();
    let total: usize = handles.into_iter().map(|t| t.join().unwrap()).sum();
    assert_eq!(total, 1, "exactly one delivery wins the claim");
    let s = sched(h.path(), &clock, "check");
    assert_eq!(count(&s, "scheduler_runs"), 1);
    assert_eq!(count(&s, "actions"), 1);
}

#[test]
fn racing_tickers_only_one_leads_and_fires() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    drop(sched(h.path(), &clock, "init"));
    let barrier = Arc::new(Barrier::new(6));
    let handles: Vec<_> = (0..6)
        .map(|i| {
            let (barrier, clock, path) = (barrier.clone(), clock.clone(), h.path().to_path_buf());
            std::thread::spawn(move || {
                let s = sched(&path, &clock, &format!("daemon{i}"));
                barrier.wait();
                s.tick().unwrap()
            })
        })
        .collect();
    let reports: Vec<_> = handles.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(reports.iter().filter(|r| r.leader).count(), 1);
    assert_eq!(reports.iter().map(|r| r.fired.len()).sum::<usize>(), 2);
    assert_eq!(count(&sched(h.path(), &clock, "c"), "actions"), 2);
}

#[test]
fn lease_is_renewed_expires_and_can_be_taken_over() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 12, 0)));
    let a = sched(h.path(), &clock, "a").with_lease_ms(120_000);
    let b = sched(h.path(), &clock, "b").with_lease_ms(120_000);
    assert!(a.tick().unwrap().leader);
    clock.advance(60_000);
    assert!(!b.tick().unwrap().leader, "a's lease is live");
    assert!(a.tick().unwrap().leader, "a renews");
    clock.advance(119_999);
    assert!(!b.tick().unwrap().leader, "one millisecond left");
    clock.advance(1);
    assert!(b.tick().unwrap().leader, "expires_at <= now is takeable");
    assert!(!a.tick().unwrap().leader, "a lost it");
    b.release_lease().unwrap();
    assert!(a.tick().unwrap().leader, "released lease is free");
}

#[test]
fn missed_runs_are_not_caught_up() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 6, 0)));
    let s = sched(h.path(), &clock, "a");
    assert!(s
        .tick()
        .unwrap()
        .fired
        .iter()
        .all(|o| o.routine == "poll.md"));
    // Down until 18:00: the 07:00 brief is gone and 47 poll windows are skipped.
    clock.set(utc(2026, 9, 28, 18, 0));
    let r = s.tick().unwrap();
    assert_eq!(r.fired.len(), 1);
    assert_eq!(r.fired[0].routine, "poll.md");
    assert_eq!(count(&s, "scheduler_runs"), 2);
    // Down across a whole day: tomorrow's brief fires once, nothing for yesterday.
    clock.set(utc(2026, 9, 30, 7, 10));
    let r = s.tick().unwrap();
    let slots: Vec<_> = r.fired.iter().map(|o| o.slot.clone()).collect();
    assert!(slots.contains(&"daily:2026-09-30".to_string()), "{slots:?}");
    assert!(!slots.iter().any(|s| s == "daily:2026-09-29"));
}

#[test]
fn hourly_cap_boundary_and_throttle_record() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 12, 0)));
    let s = sched(h.path(), &clock, "a");
    for i in 0..MAX_RUNS_PER_HOUR {
        let out = s
            .fire(
                "mail.md",
                &format!("event:e{i}"),
                "event",
                Some(&format!("e{i}")),
            )
            .unwrap()
            .unwrap();
        assert_eq!(out.status, RunStatus::Enqueued, "run {i}");
    }
    let over = s
        .fire("mail.md", "event:e30", "event", Some("e30"))
        .unwrap()
        .unwrap();
    assert_eq!(over.status, RunStatus::Throttled);
    assert!(over.action_id.is_none());
    assert_eq!(count(&s, "actions"), MAX_RUNS_PER_HOUR);
    // Throttled rows do not count toward the cap, and the slot stays claimed.
    assert!(s
        .fire("mail.md", "event:e30", "event", Some("e30"))
        .unwrap()
        .is_none());
    let again = s
        .fire("mail.md", "event:e31", "event", Some("e31"))
        .unwrap()
        .unwrap();
    assert_eq!(again.status, RunStatus::Throttled);
    // Manual runs are not throttled.
    assert_eq!(s.run_now("mail.md").unwrap().status, RunStatus::Enqueued);
    let runs = list_runs(s.actions().store(), 100).unwrap();
    let throttled: Vec<_> = runs.iter().filter(|r| r.status == "throttled").collect();
    assert_eq!(throttled.len(), 2);
    assert_eq!(throttled[0].reason.as_deref(), Some("hourly_routine_limit"));
    let events = s
        .actions()
        .store()
        .with_conn(|c| read_after(c, 0, 2000))
        .unwrap();
    let failed: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "routine.failed")
        .collect();
    assert_eq!(failed.len(), 2);
    assert_eq!(failed[0].data["reason"], "hourly_routine_limit");
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type == "routine.fired")
            .count(),
        31
    );
    // The window is rolling: an hour later the old runs have left it.
    clock.advance(3_600_000);
    assert_eq!(
        s.fire("mail.md", "event:e32", "event", Some("e32"))
            .unwrap()
            .unwrap()
            .status,
        RunStatus::Enqueued
    );
}

#[test]
fn events_carry_ids_only_and_routine_events_are_ignored() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 12, 0)));
    let s = sched(h.path(), &clock, "a");
    let ev = s
        .actions()
        .store()
        .with_conn(|c| {
            majordomo::events::append(
                c,
                &majordomo::events::NewEvent::new("email.received", "mail")
                    .data(json!({"body": "TOP SECRET CONTENT"})),
                1,
            )
        })
        .unwrap();
    let out = s.on_event(&ev).unwrap();
    assert_eq!(out.len(), 1);
    let action = s
        .actions()
        .get(out[0].action_id.as_ref().unwrap())
        .unwrap()
        .unwrap();
    assert!(!action.arguments.to_string().contains("SECRET"));
    assert_eq!(action.arguments["eventId"], json!(ev.id));
    let fired = s
        .actions()
        .store()
        .with_conn(|c| read_after(c, 0, 100))
        .unwrap();
    let routine_event = fired
        .iter()
        .find(|e| e.event_type == "routine.fired")
        .unwrap();
    assert!(!routine_event.data.to_string().contains("SECRET"));
    // Recursion ban: a routine.* event dispatches nothing.
    assert!(s.on_event(routine_event).unwrap().is_empty());
}

#[test]
fn disabled_unknown_and_invalid_inputs() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    let store = open(h.path());
    let bus = Arc::new(EventBus::new(store.clone(), clock.clone()).unwrap());
    let s = Scheduler::new(store.clone(), bus.clone(), clock.clone(), Zone::UTC, "a")
        .with_routines(vec![
            Routine::new("off.md", Trigger::every(15).unwrap()).disabled()
        ])
        .unwrap();
    assert!(s.tick().unwrap().fired.is_empty());
    assert_eq!(
        s.run_now("off.md").unwrap().status,
        RunStatus::Enqueued,
        "manual ignores enabled"
    );
    assert!(s.run_now("nope.md").is_err());
    assert!(s.claim("", "x", "event", None).is_err());
    assert!(Scheduler::new(store, bus, clock, Zone::UTC, "a")
        .with_routines(vec![
            Routine::new("d.md", Trigger::every(15).unwrap()),
            Routine::new("d.md", Trigger::every(15).unwrap()),
        ])
        .is_err());
}

#[test]
fn migration_is_additive_for_an_existing_store() {
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    {
        let s = sched(h.path(), &clock, "a");
        s.actions()
            .submit(
                &majordomo::actions::NewAction::new("mock.x", json!({})).id("act_old"),
                1,
            )
            .unwrap();
    }
    // Make it look like a Phase 4a store: no scheduler tables, version 1.
    let db = store_path(&h.path().join("majordomo"));
    {
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch(
            "DROP TABLE scheduler_runs; DROP TABLE scheduler_lease; DELETE FROM schema_version WHERE version = 2;",
        )
        .unwrap();
    }
    let s = sched(h.path(), &clock, "b");
    assert!(s.actions().get("act_old").unwrap().is_some());
    assert_eq!(count(&s, "scheduler_runs"), 0);
    assert_eq!(s.tick().unwrap().fired.len(), 2);
}

fn u2(home: &Path, args: &[&str]) -> (bool, Value) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_u2"))
        .args(args)
        .env("U2OS_HOME", home)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    (
        out.status.success(),
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
}

#[test]
fn cli_lists_runs_read_only_and_says_disabled() {
    let h = home();
    let (ok, out) = u2(h.path(), &["scheduler", "runs"]);
    assert!(ok);
    assert!(out.as_str().unwrap().contains("disabled"));
    assert!(
        !h.path().join("majordomo").exists(),
        "the CLI never creates the store"
    );
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    let s = sched(h.path(), &clock, "a");
    s.tick().unwrap();
    let (ok, out) = u2(h.path(), &["scheduler", "runs", "--json"]);
    assert!(ok);
    assert_eq!(out["enabled"], json!(false));
    assert_eq!(out["items"].as_array().unwrap().len(), 2);
    assert!(out["items"][0]["slot"].is_string());
    let (ok, out) = u2(h.path(), &["scheduler", "runs"]);
    assert!(ok && out.as_str().unwrap().contains("enqueued"));
}

#[tokio::test]
async fn daemon_api_lists_runs_and_still_reports_the_scheduler_disabled() {
    use majordomo::{client, Config, Daemon};
    let h = home();
    let clock = Arc::new(ManualClock::new(utc(2026, 9, 28, 7, 5)));
    sched(h.path(), &clock, "a").tick().unwrap();
    let cfg = Config::for_home(h.path()).unwrap();
    let daemon = Daemon::start(cfg.clone()).await.unwrap();
    let r = client::get(&cfg.socket_path, "/api/v1/scheduler/runs?limit=5")
        .await
        .unwrap();
    assert_eq!(r.status, 200);
    let v: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(v["enabled"], json!(false));
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        client::get(&cfg.socket_path, "/api/v1/scheduler/runs?x=1")
            .await
            .unwrap()
            .status,
        400
    );
    let status = client::get(&cfg.socket_path, "/api/v1/status")
        .await
        .unwrap();
    assert!(status.body.contains("scheduler"));
    assert!(!status
        .body
        .contains("\"scheduler\":{\"owner\":\"majordomo\""));
    daemon.shutdown().await.unwrap();
}
