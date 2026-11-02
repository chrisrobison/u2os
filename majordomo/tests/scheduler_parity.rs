//! Compares the Rust scheduler with `fixtures/scheduler-parity.json`, which
//! `tests/majordomo-parity-scheduler.test.js` drives through Node's real
//! `parseTrigger`, `dueSlot` and routine runner.

use majordomo::clock::ManualClock;
use majordomo::events::EventBus;
use majordomo::scheduler::zone::days_from_civil;
use majordomo::scheduler::{due_slot, Routine, RunStatus, Scheduler, Trigger, Zone};
use majordomo::store::{store_path, Store};
use serde_json::Value;
use std::sync::Arc;

fn fixture() -> Value {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/scheduler-parity.json"
    ))
    .expect("fixture");
    serde_json::from_str(&text).expect("fixture json")
}

/// `YYYY-MM-DDTHH:MM:SS[.mmm]Z` to epoch milliseconds.
fn ms(iso: &str) -> i64 {
    let (date, time) = iso.trim_end_matches('Z').split_once('T').unwrap();
    let d: Vec<i64> = date.split('-').map(|n| n.parse().unwrap()).collect();
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let t: Vec<i64> = hms.split(':').map(|n| n.parse().unwrap()).collect();
    let frac: i64 = format!("{frac:0<3}")[..3].parse().unwrap();
    days_from_civil(d[0], d[1], d[2]) * 86_400_000 + (t[0] * 3600 + t[1] * 60 + t[2]) * 1000 + frac
}

fn zone(spec: &Value) -> Zone {
    Zone::parse(spec.as_str().unwrap()).expect("zone")
}

#[test]
fn fixture_documents_its_differences() {
    let fx = fixture();
    let diffs = fx["differences"].as_array().unwrap();
    assert!(diffs.len() >= 4);
    for d in diffs {
        assert!(d["area"].is_string() && d["node"].is_string() && d["rust"].is_string());
    }
}

#[test]
fn due_slot_matches_the_fixture() {
    let fx = fixture();
    let cases = fx["due_slot"].as_array().unwrap();
    assert!(cases.len() > 20);
    for c in cases {
        let trigger = Trigger::from_when(&c["when"]).unwrap();
        let got = due_slot(
            &trigger,
            ms(c["now"].as_str().unwrap()),
            &zone(&c["zone"]),
            60,
        );
        assert_eq!(got.as_deref(), c["expected"].as_str(), "{}", c["name"]);
    }
}

#[test]
fn trigger_validation_matches_the_fixture() {
    let fx = fixture();
    for c in fx["valid_when"].as_array().unwrap() {
        assert!(Trigger::from_when(&c["when"]).is_ok(), "{}", c["name"]);
    }
    for c in fx["invalid_when"].as_array().unwrap() {
        assert!(Trigger::from_when(&c["when"]).is_err(), "{}", c["name"]);
    }
}

fn slot_matches(expected: &str, actual: &str) -> bool {
    match expected.strip_suffix('*') {
        Some(prefix) => actual.starts_with(prefix),
        None => expected == actual,
    }
}

fn assert_same(label: &str, actual: &[(String, String, &'static str)], expected: &Value) {
    let expected = expected.as_array().unwrap();
    assert_eq!(actual.len(), expected.len(), "{label}: {actual:?}");
    let mut remaining = actual.to_vec();
    for e in expected {
        let pos = remaining
            .iter()
            .position(|(r, s, st)| {
                r == e["routine"].as_str().unwrap()
                    && *st == e["status"].as_str().unwrap()
                    && slot_matches(e["slot"].as_str().unwrap(), s)
            })
            .unwrap_or_else(|| panic!("{label}: missing {e} in {actual:?}"));
        remaining.remove(pos);
    }
}

fn describe(outcomes: &[majordomo::scheduler::FireOutcome]) -> Vec<(String, String, &'static str)> {
    outcomes
        .iter()
        .map(|o| {
            (
                o.routine.clone(),
                o.slot.clone(),
                match o.status {
                    RunStatus::Enqueued => "ran",
                    RunStatus::Throttled => "throttled",
                },
            )
        })
        .collect()
}

#[test]
fn scenarios_match_the_fixture() {
    let fx = fixture();
    for sc in fx["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let home = tempfile::Builder::new().prefix("mjp").tempdir().unwrap();
        let store = Arc::new(Store::open(&store_path(&home.path().join("majordomo"))).unwrap());
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let bus = Arc::new(EventBus::new(store.clone(), clock.clone()).unwrap());
        let routines: Vec<Routine> = sc["routines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                Routine::new(
                    r["path"].as_str().unwrap(),
                    Trigger::from_when(&r["when"]).unwrap(),
                )
            })
            .collect();
        let s = Scheduler::new(store, bus, clock.clone(), zone(&sc["zone"]), "parity")
            .with_routines(routines)
            .unwrap();
        for (n, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {n}");
            match step["op"].as_str().unwrap() {
                "tick" => {
                    clock.set(ms(step["now"].as_str().unwrap()));
                    let report = s.tick().unwrap();
                    assert!(report.leader);
                    assert_same(&label, &describe(&report.fired), &step["expect"]);
                }
                "event" => {
                    let e = &step["event"];
                    let out = s.on_event_value(e["id"].as_str().unwrap(), e).unwrap();
                    assert_same(&label, &describe(&out), &step["expect"]);
                }
                "events" => {
                    let (mut ran, mut throttled) = (0, 0);
                    let from = step["from"].as_u64().unwrap();
                    for i in from..from + step["count"].as_u64().unwrap() {
                        let id = format!("{}{i}", step["prefix"].as_str().unwrap());
                        let ev = serde_json::json!({"id": id, "type": step["type"], "data": {}});
                        for (_, _, st) in describe(&s.on_event_value(&id, &ev).unwrap()) {
                            if st == "ran" {
                                ran += 1;
                            } else {
                                throttled += 1;
                            }
                        }
                    }
                    assert_eq!(ran, step["expect_ran"].as_u64().unwrap(), "{label}");
                    assert_eq!(
                        throttled,
                        step["expect_throttled"].as_u64().unwrap(),
                        "{label}"
                    );
                }
                "manual" => {
                    let out = s.run_now(step["routine"].as_str().unwrap()).unwrap();
                    assert_same(&label, &describe(&[out]), &step["expect"]);
                }
                "age_runs" => clock.advance(step["ms"].as_i64().unwrap()),
                other => panic!("unknown op {other}"),
            }
        }
    }
}
