// Trigger engine: PROMPT.md §9 / docs/automation.md. Two halves:
//
//   1. Event-driven ('event_rule' triggers): subscribes to the event bus at
//      startAll() and matches every incoming event against enabled
//      event_rule triggers' eventType/when clause.
//   2. Polled ('timer' | 'schedule' | 'condition_watch' triggers): a single
//      setInterval tick (default 60s) that finds due timers/schedules and
//      re-evaluates condition_watch's built-in checks every tick.
//
// Actions are a fixed, small, trusted set (never arbitrary code, same
// "trusted primitives" boundary as tools/dashboards): notify, create_task,
// evaluate. notify/create_task route through agent.evaluateAndMaybeExecute()
// -- the SAME policy-gated, audited pipeline chat/voice messages use. This
// module is a new *source* of proposed actions, never a bypass of that gate
// -- it never calls a tool directly and never touches policy-engine.js.
//
// stopAll()/resetForTests() mirror server/integrations/sync-scheduler.js's
// exact hermetic pattern: startAll() always calls stopAll() first, and
// stopAll() must leave zero dangling timers/subscriptions.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { getProvider } from '../integrations/provider-registry.js';
import * as tasksProvider from '../integrations/mock-tasks-provider.js';
import { getCachedCalendarEvent } from '../integrations/calendar-store.js';
import { findEntities } from '../memory/entity-store.js';
import { getFacts } from '../memory/fact-store.js';
import { log } from '../logging/logger.js';

const DEFAULT_TICK_MS = 60 * 1000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const VALID_KINDS = new Set(['timer', 'schedule', 'event_rule', 'condition_watch']);
const PROCESS_LEASE_OWNER = newId('scheduler');

let unsubscribe = null;
let tickHandle = null;
// Tracks every in-flight async tick/event-handler invocation. setInterval
// fires on a fixed schedule regardless of whether the previous invocation's
// async work has finished, and clearInterval()/unsubscribe() only stop
// FUTURE invocations -- neither cancels one already running. Without this,
// stopAll() could return while a stale tick was still mid-flight, and that
// tick's later steps (e.g. its next getDb() call, which reads
// process.env.U2OS_HOME fresh every time by design) could execute after a
// test's cleanup had already deleted that env var, silently falling back to
// the real ~/.u2os default. Observed in practice via tests/trigger-engine.test.js's
// tickMs:15 stress test. stopAll() now awaits this set to be empty before
// returning, so no caller can race a stale invocation this way again.
const inFlight = new Set();

function track(promise) {
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise));
  return promise;
}

/**
 * Starts both halves. Safe to call repeatedly (always stops first, same as
 * sync-scheduler.startAll()). Returns { started: true, tickMs }.
 */
export function startAll({ eventBus, agent, tickMs = DEFAULT_TICK_MS } = {}) {
  stopAll();
  if (!eventBus || !agent) return { started: false };

  unsubscribe = eventBus.subscribe('*', (event) => {
    track(
      handleEventDriven(event, { eventBus, agent }).catch((err) => {
        log.error('trigger-engine', 'event_rule handling failed', { error: err?.message || String(err) });
      })
    );
  });

  tickHandle = setInterval(() => {
    track(
      runTick({ eventBus, agent }).catch((err) => {
        log.error('trigger-engine', 'tick failed', { error: err?.message || String(err) });
      })
    );
  }, tickMs);
  // Defense in depth for callers that boot a server and close it without
  // knowing about this module (e.g. an older test file): this interval
  // alone must never be the thing keeping the process alive. stopAll() is
  // still the real, explicit cleanup path (see tests/trigger-engine.test.js);
  // this just guarantees a forgotten one can't hang a process on its own.
  tickHandle.unref?.();

  return { started: true, tickMs };
}

/** Clears the interval and unsubscribes from the event bus, THEN awaits any
 * tick/event-handler invocation that was already in flight at the moment of
 * the call, so a caller who immediately tears down process-wide state right
 * after calling this (e.g. a test deleting process.env.U2OS_HOME) can't race
 * a stale invocation still using the old value -- see the `inFlight` comment
 * above. Async, unlike sync-scheduler.js's stopAll(): that module never has
 * this specific risk (it starts zero timers with no connectors configured,
 * which is always true in tests unless a test explicitly connects one),
 * whereas this module always starts a real interval because the seed data
 * always ships enabled triggers. Existing callers that don't `await` this
 * still work exactly as before (clearInterval/unsubscribe happen
 * synchronously, before this function returns anything) -- only callers that
 * specifically want the drain guarantee (tests' cleanup helpers) need to add
 * `await`. */
export async function stopAll() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (inFlight.size) {
    await Promise.allSettled([...inFlight]);
  }
}

/** Test-only alias -- some suites prefer resetForTests() as the cleanup name. */
export async function resetForTests() {
  await stopAll();
}

/** Runs one polled tick immediately (manual "run now" / test helper). */
export async function runTick({ eventBus, agent, now = new Date(), leaseOwner = PROCESS_LEASE_OWNER, leaseMs = DEFAULT_LEASE_MS } = {}) {
  if (!eventBus || !agent) return;
  const db = getDb();
  const nowIso = now.toISOString();

  const dueRows = db
    .prepare(
      "SELECT * FROM triggers WHERE enabled = 1 AND kind IN ('timer','schedule') AND next_check_at IS NOT NULL AND next_check_at <= ?"
    )
    .all(nowIso);
  for (const row of dueRows) {
    const trigger = claimTrigger(row.id, { leaseOwner, leaseMs, now, requireDue: true });
    if (!trigger) continue;
    await withLeaseHeartbeat(trigger.id, { leaseOwner, leaseMs }, () =>
      fireTimerOrSchedule(trigger, { eventBus, agent, now, leaseOwner })
    );
  }

  const watchRows = db.prepare("SELECT * FROM triggers WHERE enabled = 1 AND kind = 'condition_watch'").all();
  for (const row of watchRows) {
    const trigger = claimTrigger(row.id, { leaseOwner, leaseMs, now });
    if (!trigger) continue;
    await withLeaseHeartbeat(trigger.id, { leaseOwner, leaseMs }, () =>
      runConditionWatch(trigger, { eventBus, agent, now })
    );
  }
}

function claimTrigger(id, { leaseOwner, leaseMs, now, requireDue = false }) {
  const db = getDb();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const dueClause = requireDue ? ' AND next_check_at IS NOT NULL AND next_check_at <= ?' : '';
  const params = [leaseOwner, expiresAt, nowIso, id, nowIso];
  if (requireDue) params.push(nowIso);
  const result = db.prepare(
    `UPDATE triggers SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND enabled = 1
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)${dueClause}`
  ).run(...params);
  return result.changes === 1 ? getTrigger(id) : null;
}

function renewTriggerLease(id, { leaseOwner, leaseMs }) {
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();
  getDb().prepare(
    'UPDATE triggers SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?'
  ).run(expiresAt, id, leaseOwner);
}

function releaseTriggerLease(id, leaseOwner) {
  getDb().prepare(
    'UPDATE triggers SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?'
  ).run(id, leaseOwner);
}

async function withLeaseHeartbeat(id, { leaseOwner, leaseMs }, work) {
  const heartbeatMs = Math.max(10, Math.floor(leaseMs / 3));
  const handle = setInterval(() => renewTriggerLease(id, { leaseOwner, leaseMs }), heartbeatMs);
  handle.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(handle);
    releaseTriggerLease(id, leaseOwner);
  }
}

async function handleEventDriven(event, { eventBus, agent }) {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM triggers WHERE kind = 'event_rule' AND enabled = 1").all();
  for (const row of rows) {
    const trigger = rowToTrigger(row);
    if (trigger.config.eventType !== event.type) continue;
    // Each trigger's `when` clause is evaluated independently -- a bad
    // pattern in one trigger (e.g. one that predates the /api/triggers
    // safety validation, such as a stale row from before that check
    // existed) must not stop every OTHER enabled trigger from being
    // checked against this same event. Fail that one trigger safe (treat
    // as "no match", log it) rather than letting the exception propagate.
    let matched;
    try {
      matched = matchesWhen(trigger.config.when, event);
    } catch (err) {
      log.error('trigger-engine', `trigger ${trigger.id} has an invalid when-clause, skipping it for this event`, {
        error: err?.message || String(err),
      });
      continue;
    }
    if (!matched) continue;
    await runAction(trigger, event, { eventBus, agent });
  }
}

// MAX_MATCH_VALUE_LENGTH: belt-and-suspenders cap alongside the creation-time
// safety check in server/triggers/regex-safety.js (which is the real
// guarantee) -- bounds worst-case regex evaluation time even for a pattern
// that somehow reached storage without going through that validation (e.g.
// a row edited directly in the database), since catastrophic-backtracking
// blowup is exponential in input length.
const MAX_MATCH_VALUE_LENGTH = 2000;

function matchesWhen(when, event) {
  if (!when) return true;
  const value = getPath(event, when.path);
  if (when.equals !== undefined) return value === when.equals;
  if (when.matches !== undefined) {
    if (typeof value !== 'string') return false;
    const bounded = value.length > MAX_MATCH_VALUE_LENGTH ? value.slice(0, MAX_MATCH_VALUE_LENGTH) : value;
    return new RegExp(when.matches, 'i').test(bounded);
  }
  // Unrecognized `when` shape -- fail safe toward not matching, never toward
  // silently matching everything.
  return false;
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// --- Actions --------------------------------------------------------------

/**
 * Runs a trigger's configured action against the event that caused it to
 * fire. `notify`/`create_task` are fixed, policy-gated tool proposals routed
 * through agent.evaluateAndMaybeExecute(); `evaluate` hands the event to
 * agent.evaluateEvent() for a full proactive-agent decision. Publishes
 * agent.action.completed/.failed bookkeeping either way so triggers are
 * visible in the activity feed like any other action (PROMPT.md §14).
 */
export async function runAction(trigger, event, { eventBus, agent }) {
  const action = trigger.config?.action || { kind: 'evaluate' };
  const correlationId = newId('corr');
  const actor = { type: 'system', id: `trigger:${trigger.id}` };
  let result;

  try {
    switch (action.kind) {
      case 'notify':
        result = await agent.evaluateAndMaybeExecute({
          tool: 'notifications.send',
          arguments: {
            title: action.title || `Trigger: ${trigger.name}`,
            body: action.body || `Trigger "${trigger.name}" fired on ${event.type}.`,
            priority: action.priority,
          },
          requestedBy: 'trigger-engine',
          requestText: `trigger:${trigger.id}`,
          reasoningSummary: `Trigger "${trigger.name}" (${trigger.kind}) matched ${event.type}.`,
          correlationId,
          actor,
        });
        break;
      case 'create_task':
        result = await agent.evaluateAndMaybeExecute({
          tool: 'tasks.create',
          arguments: {
            title: action.title || `Follow up: ${trigger.name}`,
            dueAt: action.dueAt,
            relatedEntityId: action.relatedEntityId || event.subject?.id || null,
          },
          requestedBy: 'trigger-engine',
          requestText: `trigger:${trigger.id}`,
          reasoningSummary: `Trigger "${trigger.name}" (${trigger.kind}) matched ${event.type}.`,
          correlationId,
          actor,
        });
        break;
      case 'evaluate':
      default:
        result = await agent.evaluateEvent(event, { correlationId, actor, triggerId: trigger.id });
        break;
    }
  } catch (err) {
    eventBus.publish({
      type: 'agent.action.failed',
      source: 'trigger-engine',
      actor,
      subject: { type: 'trigger', id: trigger.id },
      data: { trigger: trigger.name, triggerId: trigger.id, eventType: event.type, actionKind: action.kind, error: err.message },
      metadata: { correlationId, provenance: `trigger:${trigger.id}` },
    });
    throw err;
  }

  eventBus.publish({
    type: 'agent.action.completed',
    source: 'trigger-engine',
    actor,
    subject: { type: 'trigger', id: trigger.id },
    data: { trigger: trigger.name, triggerId: trigger.id, eventType: event.type, actionKind: action.kind, result },
    metadata: { correlationId, provenance: `trigger:${trigger.id}` },
  });
  touchLastFired(trigger.id);
  return result;
}

// --- condition_watch built-in checks ---------------------------------------

async function runConditionWatch(trigger, { eventBus, agent, now }) {
  switch (trigger.config?.check) {
    case 'calendar_approaching':
      return checkCalendarApproaching(trigger, { eventBus, agent, now });
    case 'task_overdue':
      return checkTaskOverdue(trigger, { eventBus, agent, now });
    case 'birthday_approaching':
      return checkBirthdayApproaching(trigger, { eventBus, agent, now });
    default:
      log.error('trigger-engine', `unknown condition_watch check for trigger ${trigger.id}`, { check: trigger.config?.check });
  }
}

async function checkCalendarApproaching(trigger, { eventBus, agent, now }) {
  const leadMinutes = trigger.config?.params?.leadMinutes ?? 60;
  const windowEnd = new Date(now.getTime() + leadMinutes * 60000);
  const provider = getProvider('calendar');
  const events = provider.listEvents({ from: now.toISOString(), to: windowEnd.toISOString() });

  for (const event of events) {
    if (event.status === 'cancelled') continue;
    if (alreadyFired(trigger.id, event.id)) continue;

    const minutesUntil = Math.round((new Date(event.start_at).getTime() - now.getTime()) / 60000);
    const synthetic = eventBus.publish({
      type: 'calendar.event_approaching',
      source: 'trigger-engine',
      actor: { type: 'system', id: `trigger:${trigger.id}` },
      subject: { type: 'calendar_event', id: event.id },
      data: { eventId: event.id, minutesUntil },
      metadata: { provenance: `trigger:${trigger.id}` },
    });
    markFiredObject(trigger.id, event.id);
    await runAction(trigger, synthetic, { eventBus, agent });
  }
}

async function checkTaskOverdue(trigger, { eventBus, agent, now }) {
  const openTasks = tasksProvider.listTasks({ status: 'open' });

  for (const task of openTasks) {
    if (!task.due_at) continue;
    if (new Date(task.due_at).getTime() >= now.getTime()) continue;
    if (alreadyFired(trigger.id, task.id)) continue;

    const synthetic = eventBus.publish({
      type: 'task.overdue',
      source: 'trigger-engine',
      actor: { type: 'system', id: `trigger:${trigger.id}` },
      subject: { type: 'task', id: task.id },
      data: { taskId: task.id, title: task.title, dueAt: task.due_at },
      metadata: { provenance: `trigger:${trigger.id}` },
    });
    markFiredObject(trigger.id, task.id);
    await runAction(trigger, synthetic, { eventBus, agent });
  }
}

const BIRTHDAY_PATTERN = /^(\d{2})-(\d{2})$/;

async function checkBirthdayApproaching(trigger, { eventBus, agent, now }) {
  const leadDays = trigger.config?.params?.leadDays ?? 7;
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);

  const people = findEntities({ type: 'Person' });
  for (const person of people) {
    const birthdayFacts = getFacts(person.id).filter((f) => f.key === 'birthday');
    for (const fact of birthdayFacts) {
      const match = BIRTHDAY_PATTERN.exec(String(fact.value).replace(/"/g, ''));
      if (!match) continue;
      const [, mm, dd] = match;

      let year = todayMidnight.getFullYear();
      let occurrence = new Date(year, Number(mm) - 1, Number(dd));
      if (occurrence.getTime() < todayMidnight.getTime()) {
        year += 1;
        occurrence = new Date(year, Number(mm) - 1, Number(dd));
      }

      const daysUntil = Math.round((occurrence.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000));
      if (daysUntil < 0 || daysUntil > leadDays) continue;

      // Dedupe key includes the year, so this fires again next year (per
      // docs/automation.md's condition_watch note).
      const objectId = `${person.id}:${year}`;
      if (alreadyFired(trigger.id, objectId)) continue;

      const synthetic = eventBus.publish({
        type: 'contact.birthday_approaching',
        source: 'trigger-engine',
        actor: { type: 'system', id: `trigger:${trigger.id}` },
        subject: { type: 'entity', id: person.id },
        data: { entityId: person.id, birthday: fact.value, daysUntil },
        metadata: { provenance: `trigger:${trigger.id}` },
      });
      markFiredObject(trigger.id, objectId);
      await runAction(trigger, synthetic, { eventBus, agent });
    }
  }
}

// --- timer / schedule ------------------------------------------------------

async function fireTimerOrSchedule(trigger, { eventBus, agent, now, leaseOwner }) {
  // Not published to the durable event log (it isn't a real domain event,
  // just an internal handoff object) -- only ever passed directly to
  // runAction() for this one trigger.
  const synthetic = {
    type: 'trigger.fired',
    timestamp: now.toISOString(),
    source: 'trigger-engine',
    actor: { type: 'system', id: `trigger:${trigger.id}` },
    subject: { type: 'trigger', id: trigger.id },
    data: { triggerId: trigger.id, kind: trigger.kind },
    metadata: {},
    correlationId: null,
    causationId: null,
  };

  await runAction(trigger, synthetic, { eventBus, agent });

  if (trigger.kind === 'timer') {
    // Fires once, then disables itself (docs/automation.md).
    const db = getDb();
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE triggers SET enabled = 0, next_check_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?').run(nowIso, trigger.id, leaseOwner);
  } else if (trigger.kind === 'schedule') {
    const next = computeNextForSchedule(trigger.config, now);
    const db = getDb();
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE triggers SET next_check_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?').run(next, nowIso, trigger.id, leaseOwner);
  }
}

function computeNextForSchedule(config, from) {
  if (config?.everyMinutes) {
    return new Date(from.getTime() + config.everyMinutes * 60000).toISOString();
  }
  if (config?.dailyAt) {
    const [h, m] = config.dailyAt.split(':').map(Number);
    const next = new Date(from);
    next.setHours(h, m || 0, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  // No recognizable recurrence shape -- fail safe toward checking again
  // soon rather than never rescheduling at all.
  return new Date(from.getTime() + 60 * 60000).toISOString();
}

function computeInitialNextCheckAt(kind, config, now = new Date()) {
  if (kind === 'timer') return config?.fireAt || now.toISOString();
  if (kind === 'schedule') return computeNextForSchedule(config, now);
  return null;
}

// --- trigger_fired_log dedupe ----------------------------------------------

function alreadyFired(triggerId, objectId) {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM trigger_fired_log WHERE trigger_id = ? AND object_id = ?').get(triggerId, objectId);
  return !!row;
}

function markFiredObject(triggerId, objectId) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO trigger_fired_log (id, trigger_id, object_id, fired_at) VALUES (?,?,?,?)').run(
    newId('tfl'),
    triggerId,
    objectId,
    new Date().toISOString()
  );
}

function touchLastFired(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

// --- triggers CRUD (backs server/api/routes/triggers.js and seed.js) ------

export function createTrigger({ name, kind, config = {}, enabled = true, source = 'system', id } = {}) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid trigger kind: ${kind}. Must be one of ${[...VALID_KINDS].join(', ')}`);
  }
  const db = getDb();
  const triggerId = id || newId('trg');
  const now = new Date().toISOString();
  const nextCheckAt = computeInitialNextCheckAt(kind, config);
  db.prepare(
    `INSERT INTO triggers (id, name, kind, enabled, config, last_fired_at, next_check_at, lease_owner, lease_expires_at, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(triggerId, name, kind, enabled ? 1 : 0, JSON.stringify(config), null, nextCheckAt, null, null, source, now, now);
  return getTrigger(triggerId);
}

export function getTrigger(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
  return row ? rowToTrigger(row) : null;
}

export function listTriggers({ kind, enabled } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  if (enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(enabled ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM triggers ${where} ORDER BY created_at DESC`).all(...params);
  return rows.map(rowToTrigger);
}

export function listTriggerHistory(id, { limit = 20 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const rows = getDb().prepare(
    `SELECT id, type, timestamp, data, correlation_id
     FROM events
     WHERE subject_type = 'trigger' AND subject_id = ?
       AND type IN ('agent.action.completed', 'agent.action.failed')
     ORDER BY timestamp DESC, id DESC LIMIT ?`
  ).all(id, boundedLimit);
  return rows.map((row) => {
    let data = {};
    try { data = JSON.parse(row.data || '{}'); } catch { /* malformed historical data stays metadata-free */ }
    return {
      id: row.id,
      timestamp: row.timestamp,
      status: row.type === 'agent.action.completed' ? 'completed' : 'failed',
      eventType: boundedHistoryText(data.eventType),
      actionKind: boundedHistoryText(data.actionKind),
      correlationId: row.correlation_id || null,
    };
  });
}

function boundedHistoryText(value) {
  return typeof value === 'string' ? value.slice(0, 120) : null;
}

export function updateTrigger(id, patch = {}) {
  const existing = getTrigger(id);
  if (!existing) return null;
  const db = getDb();
  const name = patch.name !== undefined ? patch.name : existing.name;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
  const config = patch.config !== undefined ? patch.config : existing.config;
  const now = new Date().toISOString();
  db.prepare('UPDATE triggers SET name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?').run(
    name,
    enabled,
    JSON.stringify(config),
    now,
    id
  );
  return getTrigger(id);
}

export function deleteTrigger(id) {
  const db = getDb();
  db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  db.prepare('DELETE FROM trigger_fired_log WHERE trigger_id = ?').run(id);
}

function rowToTrigger(row) {
  return { ...row, enabled: !!row.enabled, config: JSON.parse(row.config || '{}') };
}
