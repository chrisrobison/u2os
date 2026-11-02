//! Trigger definitions and slot computation, mirroring
//! `server/routines/routines.js` (`parseTrigger`, `dueSlot`, `eventMatches`).
//!
//! Definitions are supplied programmatically or from a `when` mapping in the
//! same shape as a routine's front matter. Reading routines from the vault is
//! Phase 7; nothing here touches the vault.

use super::zone::Zone;
use super::SchedulerError;
use regex::Regex;
use serde_json::Value;

pub const MIN_EVERY_MINUTES: i64 = 15;
pub const DEFAULT_GRACE_MINUTES: i64 = 60;
const DAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/// Events a routine may not react to (its own lifecycle and internals).
const FORBIDDEN_EVENT_PREFIXES: [&str; 5] = ["routine.", "vault.", "agent.", "action.", "run."];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Condition {
    Equals {
        path: String,
        value: String,
    },
    /// `value` is lower-cased, as in Node.
    Contains {
        path: String,
        value: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    Daily {
        hour: i64,
        minute: i64,
        /// Lower-case three-letter days; `None` means every day.
        days: Option<Vec<String>>,
    },
    Every {
        minutes: i64,
    },
    Event {
        event_type: String,
        condition: Option<Condition>,
    },
}

impl Trigger {
    /// The `trigger_kind` recorded on a claim (Node: `routine.trigger.kind`).
    pub fn kind(&self) -> &'static str {
        match self {
            Trigger::Daily { .. } => "daily",
            Trigger::Every { .. } => "every",
            Trigger::Event { .. } => "event",
        }
    }

    pub fn daily(hour: i64, minute: i64, days: Option<&[&str]>) -> Result<Trigger, SchedulerError> {
        if !(0..24).contains(&hour) || !(0..60).contains(&minute) {
            return Err(invalid("daily must be a time like \"07:30\""));
        }
        let days = match days {
            None => None,
            Some([]) => return Err(invalid("days must be a list such as [mon, wed, fri]")),
            Some(list) => {
                let days: Vec<String> = list.iter().map(|d| day_name(d)).collect();
                if days.iter().any(|d| !DAY_NAMES.contains(&d.as_str())) {
                    return Err(invalid("days must use mon, tue, wed, thu, fri, sat or sun"));
                }
                Some(days)
            }
        };
        Ok(Trigger::Daily { hour, minute, days })
    }

    pub fn every(minutes: i64) -> Result<Trigger, SchedulerError> {
        if minutes < MIN_EVERY_MINUTES {
            return Err(invalid(&format!(
                "every_minutes must be a whole number of at least {MIN_EVERY_MINUTES}"
            )));
        }
        Ok(Trigger::Every { minutes })
    }

    pub fn event(
        event_type: &str,
        condition: Option<Condition>,
    ) -> Result<Trigger, SchedulerError> {
        let event_type = event_type.trim();
        let shape = Regex::new(r"(?i)^[a-z0-9_]+(\.[a-z0-9_]+)+$").expect("static regex");
        if !shape.is_match(event_type) {
            return Err(invalid(
                "event must be an event type such as email.received",
            ));
        }
        if FORBIDDEN_EVENT_PREFIXES
            .iter()
            .any(|p| event_type.starts_with(p))
        {
            return Err(invalid("routines cannot react to that event domain"));
        }
        Ok(Trigger::Event {
            event_type: event_type.to_string(),
            condition,
        })
    }

    /// Parse a routine's `when:` mapping with Node's `parseTrigger` rules.
    pub fn from_when(when: &Value) -> Result<Trigger, SchedulerError> {
        let Some(map) = when.as_object() else {
            return Err(invalid(
                "when: must be a mapping with daily, every_minutes or event",
            ));
        };
        let kinds: Vec<&str> = ["daily", "every_minutes", "event"]
            .into_iter()
            .filter(|k| map.contains_key(*k))
            .collect();
        if kinds.len() != 1 {
            return Err(invalid(
                "when: must contain exactly one of daily, every_minutes or event",
            ));
        }
        match kinds[0] {
            "daily" => {
                let text = js_string(&map["daily"]);
                let re = Regex::new(r"^([01]?[0-9]|2[0-3]):([0-5][0-9])$").expect("static regex");
                let caps = re
                    .captures(&text)
                    .ok_or_else(|| invalid("daily must be a time like \"07:30\""))?;
                let days: Option<Vec<String>> = match map.get("days") {
                    None => None,
                    Some(Value::Array(list)) if !list.is_empty() => {
                        Some(list.iter().map(js_string).collect())
                    }
                    Some(_) => return Err(invalid("days must be a list such as [mon, wed, fri]")),
                };
                let refs: Option<Vec<&str>> = days
                    .as_ref()
                    .map(|d| d.iter().map(String::as_str).collect());
                Trigger::daily(
                    caps[1].parse().expect("digits"),
                    caps[2].parse().expect("digits"),
                    refs.as_deref(),
                )
            }
            "every_minutes" => {
                let minutes = match &map["every_minutes"] {
                    Value::Number(n) => n
                        .as_i64()
                        .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
                    _ => None,
                };
                match minutes {
                    Some(m) => Trigger::every(m),
                    None => Err(invalid(&format!(
                        "every_minutes must be a whole number of at least {MIN_EVERY_MINUTES}"
                    ))),
                }
            }
            _ => {
                let condition = match map.get("if") {
                    None => None,
                    Some(cond) => Some(parse_condition(cond)?),
                };
                Trigger::event(&js_string(&map["event"]), condition)
            }
        }
    }
}

fn parse_condition(cond: &Value) -> Result<Condition, SchedulerError> {
    let path = cond.get("path").and_then(Value::as_str).unwrap_or("");
    if path.is_empty()
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
    {
        return Err(invalid(
            "if.path must be a dotted field path such as data.after.from",
        ));
    }
    let equals = cond.get("equals");
    let contains = cond.get("contains");
    match (equals, contains) {
        (Some(e), None) => Ok(Condition::Equals {
            path: path.to_string(),
            value: js_string(e),
        }),
        (None, Some(c)) => Ok(Condition::Contains {
            path: path.to_string(),
            value: js_string(c).to_lowercase(),
        }),
        _ => Err(invalid("if must contain exactly one of equals or contains")),
    }
}

/// `String(value)` for the scalar JSON values a front matter can hold.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Array(_) | Value::Object(_) => "[object]".to_string(),
        other => other.to_string(),
    }
}

fn day_name(day: &str) -> String {
    day.chars().take(3).collect::<String>().to_lowercase()
}

fn invalid(message: &str) -> SchedulerError {
    SchedulerError::InvalidTrigger(message.to_string())
}

/// A routine definition. Supplied by the caller; never read from the vault in
/// this phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Routine {
    /// Stable identity, a vault-relative path in Node (`routines/brief.md`).
    pub path: String,
    pub enabled: bool,
    pub trigger: Trigger,
}

impl Routine {
    pub fn new(path: impl Into<String>, trigger: Trigger) -> Routine {
        Routine {
            path: path.into(),
            enabled: true,
            trigger,
        }
    }

    pub fn disabled(mut self) -> Routine {
        self.enabled = false;
        self
    }
}

/// The slot a time-based trigger should claim at `now_ms`, or `None`.
/// Daily routines fire within `grace_minutes` after their local time, so a
/// restart hours later does not replay the morning brief. Missed slots are
/// never caught up.
pub fn due_slot(trigger: &Trigger, now_ms: i64, zone: &Zone, grace_minutes: i64) -> Option<String> {
    match trigger {
        Trigger::Every { minutes } => {
            let window = minutes * 60_000;
            Some(format!("every:{minutes}:{}", now_ms.div_euclid(window)))
        }
        Trigger::Daily { hour, minute, days } => {
            let now = zone.local(now_ms);
            if let Some(days) = days {
                if !days
                    .iter()
                    .any(|d| d == DAY_NAMES[usize::from(now.weekday)])
                {
                    return None;
                }
            }
            let scheduled = zone.wall_to_utc(now.year, now.month, now.day, *hour, *minute);
            let late = now_ms - scheduled;
            if late < 0 || late > grace_minutes * 60_000 {
                return None;
            }
            Some(format!("daily:{}", zone.local(scheduled).date_string()))
        }
        Trigger::Event { .. } => None,
    }
}

/// `event` is shaped like Node's: `{type, data, subject, actor, ...}`.
pub fn event_matches(trigger: &Trigger, event: &Value) -> bool {
    let Trigger::Event {
        event_type,
        condition,
    } = trigger
    else {
        return false;
    };
    if event.get("type").and_then(Value::as_str) != Some(event_type.as_str()) {
        return false;
    }
    let Some(condition) = condition else {
        return true;
    };
    let (path, expected, exact) = match condition {
        Condition::Equals { path, value } => (path, value, true),
        Condition::Contains { path, value } => (path, value, false),
    };
    let mut current = Some(event);
    for key in path.split('.') {
        current = current.and_then(|c| c.get(key));
    }
    let text = match current {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => return false,
    };
    if exact {
        text == *expected
    } else {
        text.to_lowercase().contains(expected.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trigger_validation_matches_node() {
        assert_eq!(
            Trigger::from_when(&json!({"daily": "07:30", "days": ["Mon", "friday"]})).unwrap(),
            Trigger::Daily {
                hour: 7,
                minute: 30,
                days: Some(vec!["mon".into(), "fri".into()])
            }
        );
        assert_eq!(
            Trigger::from_when(&json!({"every_minutes": 60})).unwrap(),
            Trigger::Every { minutes: 60 }
        );
        for bad in [
            json!(null),
            json!({}),
            json!({"daily": "25:00"}),
            json!({"every_minutes": 5}),
            json!({"daily": "07:00", "every_minutes": 60}),
            json!({"event": "routine.fired"}),
            json!({"event": "email.received", "if": {"path": "data.x"}}),
            json!({"daily": "07:00", "days": ["someday"]}),
        ] {
            assert!(Trigger::from_when(&bad).is_err(), "{bad}");
        }
    }
}
