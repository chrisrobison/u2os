//! Kills a real child process with SIGKILL while a mock capability is
//! executing, then restarts against the same SQLite file. The mock's effect
//! ledger is a file, so it survives the kill.

use majordomo::actions::mock::{
    count_ledger, CountingCapability, EffectLog, HangingCapability, MockAuthorizer,
};
use majordomo::actions::{ActionStore, CapabilityRegistry, NewAction, Resolution, Runtime, Status};
use majordomo::clock::{Clock, ManualClock, SystemClock};
use majordomo::events::EventBus;
use majordomo::store::{store_path, Store};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const CHILD_ENV: &str = "MAJORDOMO_TEST_CHILD_HOME";

fn stack(
    home: &std::path::Path,
    clock: Arc<dyn Clock>,
) -> (Arc<Store>, ActionStore, Arc<EventBus>) {
    let store = Arc::new(Store::open(&store_path(&home.join("majordomo"))).unwrap());
    let bus = Arc::new(EventBus::new(store.clone(), clock).unwrap());
    (store.clone(), ActionStore::new(store), bus)
}

/// Runs only when re-executed by `sigkill_during_execution...`; a no-op otherwise.
#[test]
fn child_entry() {
    let Some(home) = std::env::var_os(CHILD_ENV) else {
        return;
    };
    let home = PathBuf::from(home);
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let (_store, actions, bus) = stack(&home, clock.clone());
    actions
        .submit(
            &NewAction::new("mock.send", json!({"to": "x"}))
                .key("send-1")
                .consequential(),
            clock.now_ms(),
        )
        .unwrap();
    let id = actions.get_by_key("send-1").unwrap().unwrap().id;
    if actions.get(&id).unwrap().unwrap().status == Status::AwaitingApproval {
        actions.approve(&id, "owner", clock.now_ms()).unwrap();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let log = EffectLog::with_file(home.join("effects.log"));
    let mut reg = CapabilityRegistry::new();
    reg.register(
        "mock.send",
        Arc::new(HangingCapability::new(log, Some(tx), None)),
    );
    let rt = Runtime::new(
        actions,
        bus,
        reg,
        MockAuthorizer::allow_all(),
        clock,
        "child",
    )
    .with_lease_ms(500);
    std::thread::spawn(move || {
        if rx.recv().is_ok() {
            println!("CHILD-READY");
        }
    });
    let _ = rt.process_next();
}

#[test]
fn sigkill_during_execution_yields_one_effect_and_an_uncertain_action() {
    let home = tempfile::Builder::new().prefix("mjk").tempdir().unwrap();
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
        .expect("child reached the hanging capability");
    child.kill().unwrap(); // SIGKILL
    child.wait().unwrap();

    let ledger = home.path().join("effects.log");
    assert_eq!(
        count_ledger(&ledger),
        1,
        "exactly one effect before the kill"
    );

    // Restart: same file, a clock well past the child's lease.
    let clock = Arc::new(ManualClock::new(SystemClock.now_ms() + 3_600_000));
    let (_store, actions, bus) = stack(home.path(), clock.clone());
    let id = actions.get_by_key("send-1").unwrap().unwrap().id;
    assert_eq!(actions.get(&id).unwrap().unwrap().status, Status::Executing);
    let log = EffectLog::with_file(ledger.clone());
    let mut reg = CapabilityRegistry::new();
    reg.register("mock.send", Arc::new(CountingCapability::new(log)));
    let rt = Runtime::new(
        actions.clone(),
        bus,
        reg,
        MockAuthorizer::allow_all(),
        clock.clone(),
        "restarted",
    );
    let report = rt.recover().unwrap();
    assert_eq!(report.uncertain, std::slice::from_ref(&id));

    assert_eq!(
        actions.get(&id).unwrap().unwrap().status,
        Status::OutcomeUncertain
    );
    assert!(rt.process_next().unwrap().is_none(), "never auto-retried");
    assert!(
        actions.requeue(&id, clock.now_ms()).is_err(),
        "requeue without owner resolution is refused"
    );
    let again = actions
        .submit(
            &NewAction::new("mock.send", json!({"to": "x"})).key("send-1"),
            clock.now_ms(),
        )
        .unwrap();
    assert!(!again.created);
    assert_eq!(again.action.id, id);
    assert_eq!(
        count_ledger(&ledger),
        1,
        "still exactly one effect after restart"
    );

    actions
        .resolve_uncertain(&id, Resolution::ConfirmedDone, "owner", clock.now_ms())
        .unwrap();
    assert_eq!(actions.get(&id).unwrap().unwrap().status, Status::Completed);
    assert_eq!(count_ledger(&ledger), 1);
}
