//! Durable, append-only event log and a bounded in-process bus.
//!
//! **Node remains authoritative.** This is Phase 4a's isolated Rust event log
//! in `majordomo.sqlite`; nothing here is wired to Node's event bus or its
//! `events` table, and Node does not read it.
//!
//! The model mirrors `server/events/event-bus.js`: every event is persisted
//! first and delivered second, so a subscriber that misses delivery can always
//! catch up from the log. Differences from Node, on purpose:
//!
//! - Events have a monotonic `seq` (SQLite `AUTOINCREMENT`, never reused) used
//!   as the replay cursor; Node replays by `rowid` of an event id.
//! - The log is append-only at the database level: triggers abort any
//!   `UPDATE` or `DELETE`.
//! - Payloads are limited to [`MAX_PAYLOAD_BYTES`]. Events carry ids, states
//!   and error classes, never action arguments or error messages, and `Debug`
//!   output never prints a payload, so a stray `{:?}` cannot leak a secret.
//! - Delivery is read back from the log in `seq` order under one lock, so a
//!   subscriber sees events in log order with no gaps. A subscriber that is
//!   more than its channel capacity behind is marked lagged and refills from
//!   the log automatically.

use crate::clock::Clock;
use crate::store::{new_id, Store, StoreError};
use rusqlite::{params, Connection, Row};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_FIELD_CHARS: usize = 128;
pub const MAX_SUBSCRIBERS: usize = 64;
pub const DEFAULT_CHANNEL_CAPACITY: usize = 256;
const REPLAY_BATCH: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum EventError {
    #[error("event payload is {size} bytes, over the {max}-byte limit")]
    PayloadTooLarge { size: usize, max: usize },
    #[error("invalid event: {0}")]
    Invalid(String),
    #[error("too many event subscribers (limit {0})")]
    TooManySubscribers(usize),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl From<rusqlite::Error> for EventError {
    fn from(e: rusqlite::Error) -> Self {
        EventError::Store(StoreError::Sqlite(e))
    }
}

/// Who did it, or what it was about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Party {
    pub kind: String,
    pub id: String,
}

impl Party {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Party {
            kind: kind.into(),
            id: id.into(),
        }
    }
}

#[derive(Clone)]
pub struct NewEvent {
    pub event_type: String,
    pub source: String,
    pub actor: Option<Party>,
    pub subject: Option<Party>,
    pub data: Value,
    pub correlation_id: Option<String>,
    pub causation_id: Option<String>,
}

impl NewEvent {
    pub fn new(event_type: impl Into<String>, source: impl Into<String>) -> Self {
        NewEvent {
            event_type: event_type.into(),
            source: source.into(),
            actor: None,
            subject: None,
            data: Value::Object(Default::default()),
            correlation_id: None,
            causation_id: None,
        }
    }

    pub fn data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }

    pub fn actor(mut self, actor: Party) -> Self {
        self.actor = Some(actor);
        self
    }

    pub fn subject(mut self, subject: Party) -> Self {
        self.subject = Some(subject);
        self
    }

    pub fn correlation(mut self, id: Option<String>) -> Self {
        self.correlation_id = id;
        self
    }

    pub fn causation(mut self, id: Option<String>) -> Self {
        self.causation_id = id;
        self
    }
}

impl fmt::Debug for NewEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NewEvent")
            .field("event_type", &self.event_type)
            .field("source", &self.source)
            .field("data", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Serialize, PartialEq)]
pub struct Event {
    pub seq: i64,
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub ts_ms: i64,
    pub source: String,
    pub actor: Option<Party>,
    pub subject: Option<Party>,
    pub data: Value,
    pub correlation_id: Option<String>,
    pub causation_id: Option<String>,
}

impl fmt::Debug for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Event")
            .field("seq", &self.seq)
            .field("id", &self.id)
            .field("event_type", &self.event_type)
            .field("data", &"<redacted>")
            .finish()
    }
}

fn check_field(name: &str, value: &str) -> Result<(), EventError> {
    if value.is_empty() || value.chars().count() > MAX_FIELD_CHARS {
        return Err(EventError::Invalid(format!(
            "{name} must be 1 to {MAX_FIELD_CHARS} characters"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(EventError::Invalid(format!(
            "{name} must not contain control characters"
        )));
    }
    Ok(())
}

fn validate(e: &NewEvent) -> Result<String, EventError> {
    check_field("type", &e.event_type)?;
    if !e
        .event_type
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    {
        return Err(EventError::Invalid(
            "type may contain only letters, digits and _ . : -".into(),
        ));
    }
    check_field("source", &e.source)?;
    for p in [&e.actor, &e.subject].into_iter().flatten() {
        check_field("party kind", &p.kind)?;
        check_field("party id", &p.id)?;
    }
    for (n, v) in [
        ("correlation_id", &e.correlation_id),
        ("causation_id", &e.causation_id),
    ] {
        if let Some(v) = v {
            check_field(n, v)?;
        }
    }
    let data = serde_json::to_string(&e.data)
        .map_err(|err| EventError::Invalid(format!("payload is not serializable: {err}")))?;
    if data.len() > MAX_PAYLOAD_BYTES {
        return Err(EventError::PayloadTooLarge {
            size: data.len(),
            max: MAX_PAYLOAD_BYTES,
        });
    }
    Ok(data)
}

/// Append inside the caller's transaction (or connection). Used by the action
/// store so a state change and its event commit or roll back together.
pub fn append(conn: &Connection, e: &NewEvent, ts_ms: i64) -> Result<Event, EventError> {
    let data = validate(e)?;
    let id = new_id("evt")?;
    conn.execute(
        "INSERT INTO events (id, type, ts_ms, source, actor_type, actor_id, subject_type,
           subject_id, data, correlation_id, causation_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            id,
            e.event_type,
            ts_ms,
            e.source,
            e.actor.as_ref().map(|p| &p.kind),
            e.actor.as_ref().map(|p| &p.id),
            e.subject.as_ref().map(|p| &p.kind),
            e.subject.as_ref().map(|p| &p.id),
            data,
            e.correlation_id,
            e.causation_id,
        ],
    )?;
    Ok(Event {
        seq: conn.last_insert_rowid(),
        id,
        event_type: e.event_type.clone(),
        ts_ms,
        source: e.source.clone(),
        actor: e.actor.clone(),
        subject: e.subject.clone(),
        data: e.data.clone(),
        correlation_id: e.correlation_id.clone(),
        causation_id: e.causation_id.clone(),
    })
}

const COLUMNS: &str = "seq, id, type, ts_ms, source, actor_type, actor_id, subject_type, subject_id, data, correlation_id, causation_id";

fn party(kind: Option<String>, id: Option<String>) -> Option<Party> {
    match (kind, id) {
        (Some(kind), Some(id)) => Some(Party { kind, id }),
        _ => None,
    }
}

fn row_to_event(r: &Row<'_>) -> rusqlite::Result<Event> {
    let data: String = r.get(9)?;
    Ok(Event {
        seq: r.get(0)?,
        id: r.get(1)?,
        event_type: r.get(2)?,
        ts_ms: r.get(3)?,
        source: r.get(4)?,
        actor: party(r.get(5)?, r.get(6)?),
        subject: party(r.get(7)?, r.get(8)?),
        data: serde_json::from_str(&data).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(e))
        })?,
        correlation_id: r.get(10)?,
        causation_id: r.get(11)?,
    })
}

/// Events with `seq > after`, oldest first.
pub fn read_after(conn: &Connection, after: i64, limit: usize) -> Result<Vec<Event>, EventError> {
    let limit = i64::try_from(limit.clamp(1, 2000)).unwrap_or(2000);
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![after, limit], row_to_event)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The newest `limit` events, returned oldest first (for `tail`).
pub fn read_last(conn: &Connection, limit: usize) -> Result<Vec<Event>, EventError> {
    let limit = i64::try_from(limit.clamp(1, 2000)).unwrap_or(2000);
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ?1) ORDER BY seq ASC"
    ))?;
    let rows = stmt.query_map(params![limit], row_to_event)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn max_seq(conn: &Connection) -> Result<i64, EventError> {
    Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?)
}

/// `*`, a domain prefix such as `action.*`, or an exact type (as in Node).
pub fn matches_pattern(pattern: &str, event_type: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    match pattern.strip_suffix(".*") {
        Some(prefix) => event_type
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('.')),
        None => pattern == event_type,
    }
}

/// Where a new subscription starts reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cursor {
    /// Replay the whole log, then follow.
    Start,
    /// Events with a `seq` greater than this, then follow.
    After(i64),
    /// Only events delivered after subscribing.
    Now,
}

struct Subscriber {
    pattern: String,
    tx: SyncSender<Event>,
    lagged: Arc<AtomicBool>,
}

struct BusState {
    subscribers: Vec<Subscriber>,
    delivered: i64,
}

/// Persists, then delivers. Cloning the `Arc` shares one bus.
pub struct EventBus {
    store: Arc<Store>,
    clock: Arc<dyn Clock>,
    capacity: usize,
    state: Mutex<BusState>,
}

impl EventBus {
    pub fn new(store: Arc<Store>, clock: Arc<dyn Clock>) -> Result<Self, EventError> {
        Self::with_capacity(store, clock, DEFAULT_CHANNEL_CAPACITY)
    }

    pub fn with_capacity(
        store: Arc<Store>,
        clock: Arc<dyn Clock>,
        capacity: usize,
    ) -> Result<Self, EventError> {
        let delivered = store.with_conn(|c| max_seq(c))?;
        Ok(EventBus {
            store,
            clock,
            capacity: capacity.max(1),
            state: Mutex::new(BusState {
                subscribers: Vec::new(),
                delivered,
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BusState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Persist the event, then deliver everything not yet delivered.
    pub fn publish(&self, event: NewEvent) -> Result<Event, EventError> {
        let ts = self.clock.now_ms();
        let stored = self.store.with_conn(|c| append(c, &event, ts))?;
        if let Err(e) = self.deliver_pending() {
            // The event is durable; subscribers will catch up from the log.
            tracing::warn!(error = %e, "event delivery failed after persist");
        }
        Ok(stored)
    }

    /// Deliver events that were appended (for example inside an action
    /// transaction) but not yet announced. Safe to call at any time.
    pub fn deliver_pending(&self) -> Result<usize, EventError> {
        let mut state = self.lock();
        let mut total = 0;
        loop {
            let batch = self
                .store
                .with_conn(|c| read_after(c, state.delivered, REPLAY_BATCH))?;
            if batch.is_empty() {
                break;
            }
            for event in batch {
                state.delivered = event.seq;
                total += 1;
                state.subscribers.retain(|s| {
                    if !matches_pattern(&s.pattern, &event.event_type) {
                        return true;
                    }
                    match s.tx.try_send(event.clone()) {
                        Ok(()) => true,
                        Err(TrySendError::Full(_)) => {
                            s.lagged.store(true, Ordering::SeqCst);
                            true
                        }
                        Err(TrySendError::Disconnected(_)) => false,
                    }
                });
            }
        }
        Ok(total)
    }

    pub fn subscribe(&self, pattern: &str, from: Cursor) -> Result<Subscription, EventError> {
        check_field("pattern", pattern)?;
        let mut state = self.lock();
        if state.subscribers.len() >= MAX_SUBSCRIBERS {
            return Err(EventError::TooManySubscribers(MAX_SUBSCRIBERS));
        }
        let (tx, rx) = mpsc::sync_channel(self.capacity);
        let lagged = Arc::new(AtomicBool::new(false));
        state.subscribers.push(Subscriber {
            pattern: pattern.to_string(),
            tx,
            lagged: lagged.clone(),
        });
        let (cursor, replay) = match from {
            Cursor::Start => (0, true),
            Cursor::After(seq) => (seq.max(0), true),
            Cursor::Now => (state.delivered, false),
        };
        Ok(Subscription {
            store: self.store.clone(),
            pattern: pattern.to_string(),
            rx,
            lagged,
            cursor,
            needs_replay: replay,
            buffer: VecDeque::new(),
        })
    }
}

/// A cursor over the log that is also woken by live delivery.
pub struct Subscription {
    store: Arc<Store>,
    pattern: String,
    rx: Receiver<Event>,
    lagged: Arc<AtomicBool>,
    cursor: i64,
    needs_replay: bool,
    buffer: VecDeque<Event>,
}

impl Subscription {
    /// The `seq` of the last event handed out. Persist it to resume later.
    pub fn cursor(&self) -> i64 {
        self.cursor
    }

    /// The next matching event, or `None` after `timeout` with nothing new.
    pub fn recv_timeout(&mut self, timeout: Duration) -> Result<Option<Event>, EventError> {
        loop {
            if let Some(e) = self.buffer.pop_front() {
                self.cursor = e.seq;
                return Ok(Some(e));
            }
            if self.lagged.swap(false, Ordering::SeqCst) {
                // Live events were dropped: discard the channel, refill from the log.
                while self.rx.try_recv().is_ok() {}
                self.needs_replay = true;
            }
            if self.needs_replay {
                self.refill()?;
                if !self.buffer.is_empty() {
                    continue;
                }
                self.needs_replay = false;
            }
            match self.rx.recv_timeout(timeout) {
                Ok(e) => {
                    if e.seq > self.cursor {
                        self.cursor = e.seq;
                        return Ok(Some(e));
                    }
                }
                Err(_) => return Ok(None),
            }
        }
    }

    fn refill(&mut self) -> Result<(), EventError> {
        let mut after = self.cursor;
        let batch = self
            .store
            .with_conn(|c| read_after(c, after, REPLAY_BATCH))?;
        for e in batch {
            after = e.seq;
            if matches_pattern(&self.pattern, &e.event_type) {
                self.buffer.push_back(e);
            }
        }
        if self.buffer.is_empty() && after > self.cursor {
            // Everything in the batch was filtered out; skip past it.
            self.cursor = after;
            return self.refill();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;
    use crate::store::store_path;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, Arc<Store>, EventBus) {
        let t = tempfile::Builder::new().prefix("mje").tempdir().unwrap();
        let store = Arc::new(Store::open(&store_path(&t.path().join("majordomo"))).unwrap());
        let bus = EventBus::new(store.clone(), Arc::new(ManualClock::new(1000))).unwrap();
        (t, store, bus)
    }

    #[test]
    fn patterns_match_like_node() {
        assert!(matches_pattern("*", "a.b"));
        assert!(matches_pattern("action.*", "action.transition"));
        assert!(!matches_pattern("action.*", "actions.transition"));
        assert!(!matches_pattern("action.*", "action"));
        assert!(matches_pattern("a.b", "a.b"));
        assert!(!matches_pattern("a.b", "a.bc"));
    }

    #[test]
    fn publish_persists_then_delivers() {
        let (_t, store, bus) = fixture();
        let mut sub = bus.subscribe("*", Cursor::Now).unwrap();
        let e = bus
            .publish(NewEvent::new("test.one", "t").data(json!({"k": 1})))
            .unwrap();
        // Durable before (and regardless of) delivery.
        let stored = store.with_conn(|c| read_after(c, 0, 10)).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, e.id);
        let got = sub.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
        assert_eq!(got.seq, e.seq);
        assert_eq!(got.data, json!({"k": 1}));
        assert!(sub
            .recv_timeout(Duration::from_millis(10))
            .unwrap()
            .is_none());
    }

    #[test]
    fn invalid_and_oversized_events_are_rejected_and_not_stored() {
        let (_t, store, bus) = fixture();
        let big = json!({"x": "a".repeat(MAX_PAYLOAD_BYTES)});
        assert!(matches!(
            bus.publish(NewEvent::new("t.big", "t").data(big)),
            Err(EventError::PayloadTooLarge { .. })
        ));
        for bad in ["", "has space", "a\nb", &"x".repeat(200)] {
            assert!(matches!(
                bus.publish(NewEvent::new(bad, "t")),
                Err(EventError::Invalid(_))
            ));
        }
        assert!(bus.publish(NewEvent::new("t.ok", "")).is_err());
        assert_eq!(store.with_conn(|c| max_seq(c)).unwrap(), 0);
    }

    #[test]
    fn log_is_append_only_at_the_database() {
        let (_t, store, bus) = fixture();
        bus.publish(NewEvent::new("t.one", "t")).unwrap();
        store
            .with_conn(|c| -> Result<(), StoreError> {
                assert!(c.execute("UPDATE events SET type = 'x'", []).is_err());
                assert!(c.execute("DELETE FROM events", []).is_err());
                Ok(())
            })
            .unwrap();
        assert_eq!(store.with_conn(|c| max_seq(c)).unwrap(), 1);
    }

    #[test]
    fn replay_from_cursor_survives_reopen() {
        let t = tempfile::Builder::new().prefix("mje").tempdir().unwrap();
        let path = store_path(&t.path().join("majordomo"));
        let clock = Arc::new(ManualClock::new(5));
        {
            let store = Arc::new(Store::open(&path).unwrap());
            let bus = EventBus::new(store, clock.clone()).unwrap();
            for i in 0..5 {
                bus.publish(NewEvent::new(format!("t.e{i}"), "t")).unwrap();
            }
        }
        let store = Arc::new(Store::open(&path).unwrap());
        let bus = EventBus::new(store, clock).unwrap();
        let mut sub = bus.subscribe("*", Cursor::After(2)).unwrap();
        let seqs: Vec<i64> = (0..3)
            .map(|_| {
                sub.recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .unwrap()
                    .seq
            })
            .collect();
        assert_eq!(seqs, vec![3, 4, 5]);
        assert_eq!(sub.cursor(), 5);
        // New live events keep coming in order, sequence numbers continue.
        bus.publish(NewEvent::new("t.e5", "t")).unwrap();
        assert_eq!(
            sub.recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap()
                .seq,
            6
        );
    }

    #[test]
    fn slow_subscriber_lags_then_catches_up_in_order_without_gaps() {
        let (_t, store, _bus) = fixture();
        let bus = EventBus::with_capacity(store, Arc::new(ManualClock::new(0)), 2).unwrap();
        let mut sub = bus.subscribe("*", Cursor::Now).unwrap();
        for i in 0..10 {
            bus.publish(NewEvent::new(format!("t.e{i}"), "t")).unwrap();
        }
        let mut seqs = Vec::new();
        while let Some(e) = sub.recv_timeout(Duration::from_millis(20)).unwrap() {
            seqs.push(e.seq);
        }
        assert_eq!(seqs, (1..=10).collect::<Vec<_>>());
    }

    #[test]
    fn pattern_filtering_skips_but_advances() {
        let (_t, _s, bus) = fixture();
        bus.publish(NewEvent::new("a.x", "t")).unwrap();
        bus.publish(NewEvent::new("b.y", "t")).unwrap();
        bus.publish(NewEvent::new("a.z", "t")).unwrap();
        let mut sub = bus.subscribe("a.*", Cursor::Start).unwrap();
        let types: Vec<String> =
            std::iter::from_fn(|| sub.recv_timeout(Duration::from_millis(20)).unwrap())
                .map(|e| e.event_type)
                .collect();
        assert_eq!(types, vec!["a.x", "a.z"]);
    }

    #[test]
    fn debug_output_never_prints_payloads() {
        let (_t, _s, bus) = fixture();
        let secret = "hunter2-sk-live-123";
        let new = NewEvent::new("t.secret", "t").data(json!({"token": secret}));
        assert!(!format!("{new:?}").contains(secret));
        let stored = bus.publish(new).unwrap();
        assert!(!format!("{stored:?}").contains(secret));
    }

    #[test]
    fn subscriber_count_is_bounded() {
        let (_t, _s, bus) = fixture();
        let subs: Vec<_> = (0..MAX_SUBSCRIBERS)
            .map(|_| bus.subscribe("*", Cursor::Now).unwrap())
            .collect();
        assert!(matches!(
            bus.subscribe("*", Cursor::Now),
            Err(EventError::TooManySubscribers(_))
        ));
        drop(subs);
    }
}
