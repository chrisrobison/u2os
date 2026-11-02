//! Kills a real child process with SIGKILL between the slot claim and the
//! enqueue, then restarts against the same SQLite file.

use majordomo::clock::{Clock, ManualClock, SystemClock};
use majordomo::events::EventBus;
use majordomo::scheduler::{action_key, list_runs, Routine, Scheduler, Trigger, Zone};
use majordomo::store::{store_path, Store};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const CHILD_ENV: &str = "MAJORDOMO_TEST_SCHED_CHILD_HOME";

fn scheduler(home: &std::path::Path, clock: Arc<dyn Clock>, owner: &str) -> Scheduler {
    let store = Arc::new(Store::open(&store_path(&home.join("majordomo"))).unwrap());
    let bus = Arc::new(EventBus::new(store.clone(), clock.clone()).unwrap());
    Scheduler::new(store, bus, clock, Zone::UTC, owner)
        .with_routines(vec![Routine::new(
            "mail.md",
            Trigger::event("email.received", None).unwrap(),
        )])
        .unwrap()
}

/// Runs only when re-executed by the test below; a no-op otherwise.
#[test]
fn child_entry() {
    let Some(home) = std::env::var_os(CHILD_ENV) else {
        return;
    };
    let s = scheduler(&PathBuf::from(home), Arc::new(SystemClock), "child");
    let claim = s
        .claim("mail.md", "event:evt_crash", "event", Some("evt_crash"))
        .unwrap()
        .expect("fresh slot");
    assert!(!claim.throttled);
    println!("CHILD-READY");
    // Never enqueues: wait to be killed.
    std::thread::sleep(Duration::from_secs(120));
}

#[test]
fn sigkill_between_claim_and_enqueue_recovers_to_exactly_one_action() {
    let home = tempfile::Builder::new().prefix("mjsk").tempdir().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_entry", "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, home.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("CHILD-READY") {
                let _ = tx.send(());
            }
        }
    });
    rx.recv_timeout(Duration::from_secs(60))
        .expect("child claimed the slot");
    child.kill().unwrap(); // SIGKILL
    child.wait().unwrap();

    let clock = Arc::new(ManualClock::new(SystemClock.now_ms() + 3_600_000));
    let s = scheduler(home.path(), clock.clone(), "restarted");
    let runs = list_runs(s.actions().store(), 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "started", "claimed, never enqueued");
    assert!(s
        .actions()
        .get_by_key(&action_key("mail.md", "event:evt_crash"))
        .unwrap()
        .is_none());

    // The restarted process cannot re-claim the slot...
    assert!(s
        .claim("mail.md", "event:evt_crash", "event", Some("evt_crash"))
        .unwrap()
        .is_none());
    // ...and a redelivery of the event does not fire it again...
    let ev = serde_json::json!({"id": "evt_crash", "type": "email.received", "data": {}});
    assert!(s.on_event_value("evt_crash", &ev).unwrap().is_empty());
    // ...but recovery (run by every tick) creates the one action.
    let report = s.tick().unwrap();
    assert!(report.leader);
    assert_eq!(report.recovered.len(), 1);
    let action = s
        .actions()
        .get_by_key(&action_key("mail.md", "event:evt_crash"))
        .unwrap()
        .expect("action created by recovery");
    assert!(s.recover().unwrap().is_empty());
    let runs = list_runs(s.actions().store(), 10).unwrap();
    assert_eq!(runs[0].status, "enqueued");
    assert_eq!(runs[0].action_id.as_deref(), Some(action.id.as_str()));
    assert_eq!(s.actions().list(None, 100).unwrap().len(), 1);
}
