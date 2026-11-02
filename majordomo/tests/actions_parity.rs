//! Compares the Rust state machine with the fixture shared with Node
//! (`fixtures/actions-parity.json`). The Node side is
//! `tests/majordomo-parity-actions.test.js`, which drives Node's real queue
//! store with the same file.

use majordomo::actions::classify::{
    classify, failure_outcome, retry_delay_ms, ErrorClass, ErrorInfo, FailureOutcome, RetryPolicy,
};
use majordomo::actions::state::{next, Status, Trigger, ALL_STATUSES, ALL_TRIGGERS, TRANSITIONS};
use majordomo::actions::store::idempotency_key;
use majordomo::actions::{ActionStore, NewAction};
use majordomo::store::{store_path, Store};
use serde_json::{json, Value};
use std::sync::Arc;

fn fixture() -> Value {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/actions-parity.json"
    ))
    .expect("fixture");
    serde_json::from_str(&text).expect("fixture json")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

#[test]
fn transition_table_equals_the_fixture_exactly() {
    let fx = fixture();
    let mut listed = Vec::new();
    for row in fx["transitions"].as_array().unwrap() {
        let from = Status::parse(s(&row["from"])).expect("from");
        let trigger = Trigger::parse(s(&row["trigger"])).expect("trigger");
        let to = Status::parse(s(&row["rust"])).expect("rust state");
        assert_eq!(next(from, trigger), Ok(to), "{row}");
        listed.push((from, trigger, to));
        let node = s(&row["node"]);
        if node != "n/a" && node != s(&row["rust"]) {
            assert!(
                row.get("note").is_some(),
                "difference without a note: {row}"
            );
        }
    }
    // Nothing legal in Rust is missing from the fixture, nothing extra is in it.
    assert_eq!(listed.len(), TRANSITIONS.len());
    for t in TRANSITIONS {
        assert!(listed.contains(t), "{t:?} is not in the fixture");
    }
    for row in fx["rejections"].as_array().unwrap() {
        let from = Status::parse(s(&row["from"])).expect("from");
        let trigger = Trigger::parse(s(&row["trigger"])).expect("trigger");
        assert!(next(from, trigger).is_err(), "{row}");
    }
    // Everything not listed is rejected.
    for from in ALL_STATUSES {
        for trigger in ALL_TRIGGERS {
            if !listed.iter().any(|(f, t, _)| *f == from && *t == trigger) {
                assert!(next(from, trigger).is_err());
            }
        }
    }
}

#[test]
fn classification_matches_fixture() {
    for row in fixture()["classification"].as_array().unwrap() {
        let e = &row["error"];
        let info = ErrorInfo {
            action_error_class: e["actionErrorClass"].as_str().map(str::to_string),
            owner_attention_required: e["ownerAttentionRequired"].as_bool().unwrap_or(false),
            code: e["code"].as_str().map(str::to_string),
            status: e["status"].as_i64(),
        };
        assert_eq!(classify(&info).as_str(), s(&row["class"]), "{row}");
    }
}

#[test]
fn retry_delays_match_fixture() {
    for c in fixture()["retry_delays"].as_array().unwrap() {
        let got = retry_delay_ms(
            c["attempt"].as_u64().unwrap() as u32,
            c["base"].as_i64().unwrap(),
            c["max"].as_i64().unwrap(),
        );
        assert_eq!(got, c["ms"].as_i64(), "{c}");
    }
}

#[test]
fn failure_outcomes_match_fixture() {
    for c in fixture()["failure_outcomes"].as_array().unwrap() {
        let class = ErrorClass::parse(s(&c["class"])).unwrap();
        let got = match failure_outcome(
            class,
            c["attempt"].as_u64().unwrap() as u32,
            c["max"].as_u64().unwrap() as u32,
        ) {
            FailureOutcome::Retry => "retry_wait",
            FailureOutcome::DeadLetter => "dead_letter",
            FailureOutcome::Terminal => "failed",
            FailureOutcome::Uncertain => "outcome_uncertain",
        };
        assert_eq!(got, s(&c["rust"]), "{c}");
        if s(&c["node"]) != got {
            assert!(c.get("note").is_some(), "difference without a note: {c}");
        }
    }
}

#[test]
fn idempotency_keys_match_fixture() {
    for k in fixture()["idempotency_keys"].as_array().unwrap() {
        let got = idempotency_key(
            s(&k["tool"]),
            k["correlationId"].as_str(),
            s(&k["actionId"]),
        );
        assert_eq!(got.unwrap(), s(&k["key"]));
    }
    assert!(idempotency_key("", None, "a").is_err());
    assert!(idempotency_key("t", None, "").is_err());
}

#[test]
fn scenarios_match_fixture() {
    for scenario in fixture()["scenarios"].as_array().unwrap() {
        let dir = tempfile::Builder::new().prefix("mjp").tempdir().unwrap();
        let store = Arc::new(Store::open(&store_path(&dir.path().join("majordomo"))).unwrap());
        let actions = ActionStore::new(store);
        let id = "act_parity";
        let name = s(&scenario["name"]);
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {i} ({})", s(&step["op"]));
            let at = step["at"].as_i64().unwrap();
            let owner = step["owner"].as_str().unwrap_or("");
            let latest = || {
                actions
                    .attempts(id)
                    .unwrap()
                    .last()
                    .map(|a| a.id.clone())
                    .unwrap_or_else(|| "att_missing".into())
            };
            let ok = match s(&step["op"]) {
                "enqueue" => {
                    actions
                        .submit(&NewAction::new("email.send", json!({})).id(id), at)
                        .unwrap();
                    true
                }
                "lease" => actions
                    .lease_action(id, owner, step["leaseMs"].as_i64().unwrap(), at)
                    .unwrap()
                    .is_some(),
                "begin" => actions.begin_attempt(id, owner, at).is_ok(),
                "complete" => actions.complete_attempt(&latest(), owner, at).is_ok(),
                "fail" => {
                    let policy = RetryPolicy {
                        max_attempts: step["maxAttempts"].as_u64().unwrap() as u32,
                        ..RetryPolicy::default()
                    };
                    let class = ErrorClass::parse(s(&step["errorClass"])).unwrap();
                    actions
                        .fail_attempt(&latest(), owner, "e", class, policy, at)
                        .is_ok()
                }
                other => panic!("unknown op {other}"),
            };
            let row = actions.get(id).unwrap().unwrap();
            let expect = step.get("expect_rust").unwrap_or(&step["expect"]);
            if step.get("expect_rust").is_some() || step.get("expect_node").is_some() {
                assert!(
                    step.get("note").is_some(),
                    "{label}: difference needs a note"
                );
            }
            if let Some(v) = expect.get("ok") {
                assert_eq!(Some(ok), v.as_bool(), "{label}: ok");
            }
            if let Some(v) = expect.get("status") {
                assert_eq!(row.status.as_str(), s(v), "{label}: status");
            }
            if let Some(v) = expect.get("owner") {
                assert_eq!(row.lease_owner.as_deref(), v.as_str(), "{label}: owner");
            }
            if let Some(v) = expect.get("next_attempt_at") {
                assert_eq!(
                    Some(row.next_attempt_at_ms),
                    v.as_i64(),
                    "{label}: next_attempt_at"
                );
            }
        }
    }
}
