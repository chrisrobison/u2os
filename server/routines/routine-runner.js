import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { log } from '../logging/logger.js';
import { loadRoutines, dueSlot, eventMatches, describeTrigger } from './routines.js';

// Runs owner-written routines unattended (docs/routines.md). A routine is a
// new *source* of objectives for the ordinary agent run: the planner still
// proposes, the policy engine still decides, consequential actions still
// wait for approval, and every step is audited. Nothing here calls a tool.

const DEFAULT_TICK_MS = 60_000;
// Runaway guard: routines reacting to each other's effects cannot fire
// more than this many runs per rolling hour in total.
export const MAX_RUNS_PER_HOUR = 30;

let state = null;

export function startRoutineRunner({ eventBus, agent, tickMs = Number(process.env.U2OS_ROUTINE_TICK_MS) || DEFAULT_TICK_MS, now = () => new Date() } = {}) {
  stopRoutineRunnerSync();
  const inFlight = new Set();
  const track = (promise) => { inFlight.add(promise); promise.finally(() => inFlight.delete(promise)); return promise; };
  const unsubscribe = eventBus.subscribe('*', (event) => {
    if (!event?.type || event.type.startsWith('routine.')) return;
    track(runEventRoutines({ eventBus, agent, event }).catch(() => log.error('routines', 'Event routine dispatch failed')));
  });
  const timer = setInterval(() => {
    track(runScheduledRoutines({ eventBus, agent, now: now() }).catch(() => log.error('routines', 'Routine tick failed')));
  }, tickMs);
  timer.unref?.();
  state = { unsubscribe, timer, inFlight };
  return { tickMs };
}

export async function stopRoutineRunner() {
  const current = state;
  stopRoutineRunnerSync();
  if (current?.inFlight.size) await Promise.allSettled([...current.inFlight]);
}

function stopRoutineRunnerSync() {
  if (!state) return;
  state.unsubscribe();
  clearInterval(state.timer);
  state = null;
}

export async function runScheduledRoutines({ eventBus, agent, now = new Date() }) {
  const started = [];
  for (const routine of loadRoutines()) {
    if (!routine.enabled || routine.error || routine.trigger?.kind === 'event') continue;
    const slot = dueSlot(routine.trigger, now);
    if (slot) started.push(await runRoutine({ eventBus, agent, routine, slot, triggerKind: routine.trigger.kind }));
  }
  return started.filter(Boolean);
}

export async function runEventRoutines({ eventBus, agent, event }) {
  const started = [];
  for (const routine of loadRoutines()) {
    if (!routine.enabled || routine.error || !eventMatches(routine.trigger, event)) continue;
    started.push(await runRoutine({ eventBus, agent, routine, slot: `event:${event.id}`, triggerKind: 'event', event }));
  }
  return started.filter(Boolean);
}

/** Runs one routine now on the owner's request, regardless of its trigger. */
export async function runRoutineNow({ eventBus, agent, routinePath }) {
  const routine = loadRoutines().find((item) => item.path === routinePath);
  if (!routine) return { status: 'not_found' };
  if (routine.error) return { status: 'invalid', reason: routine.error };
  return runRoutine({ eventBus, agent, routine, slot: `manual:${newId('slot')}`, triggerKind: 'manual' });
}

/**
 * Claims the slot atomically before any model call. A slot already claimed
 * (by an earlier tick, another event delivery, or a run before a restart)
 * returns null and starts nothing, so a routine never runs twice per slot.
 */
async function runRoutine({ eventBus, agent, routine, slot, triggerKind, event = null }) {
  const db = getDb();
  const owner = db.prepare('SELECT id FROM owners ORDER BY created_at LIMIT 1').get();
  if (!owner) return null;
  const nowIso = new Date().toISOString();
  const id = newId('rtn');
  const claimed = db.prepare(`INSERT OR IGNORE INTO routine_runs (id, routine_path, slot, trigger_kind, event_id, status, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, routine.path, slot, triggerKind, event?.id ?? null, 'started', nowIso);
  if (!claimed.changes) return null;

  const recent = db.prepare("SELECT COUNT(*) AS n FROM routine_runs WHERE created_at > ? AND status != 'throttled' AND id != ?")
    .get(new Date(Date.now() - 3_600_000).toISOString(), id).n;
  if (triggerKind !== 'manual' && recent >= MAX_RUNS_PER_HOUR) {
    finish(db, id, 'throttled', null, 'hourly_routine_limit');
    publish(eventBus, 'routine.failed', routine, { routineRunId: id, reason: 'hourly_routine_limit' });
    return { id, status: 'throttled' };
  }

  publish(eventBus, 'routine.fired', routine, { routineRunId: id, trigger: triggerKind, slot, eventId: event?.id ?? null });
  try {
    const result = await agent.handleMessage({ text: objectiveFor(routine, triggerKind, event), actorId: owner.id });
    const pending = result.pendingActionIds?.length || 0;
    finish(db, id, 'completed', result.runId ?? null, pending ? 'awaiting_approval' : null);
    publish(eventBus, 'routine.completed', routine, { routineRunId: id, runId: result.runId ?? null, pendingApprovals: pending });
    return { id, status: 'completed', runId: result.runId ?? null, pendingApprovals: pending };
  } catch (error) {
    // Never persist model/provider error text: it may contain private content.
    const reason = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'run_failed';
    finish(db, id, 'failed', null, reason);
    publish(eventBus, 'routine.failed', routine, { routineRunId: id, reason });
    return { id, status: 'failed', reason };
  }
}

/**
 * The instruction is owner-authored. Triggering event content is NOT
 * copied into the objective: only its type and identifiers are, so the
 * planner reads the item through a normal read tool whose result passes the
 * data-processing policy like any other observation.
 */
export function objectiveFor(routine, triggerKind, event) {
  const lines = [
    'Carry out this standing routine from my vault on my behalf.',
    `Routine: ${routine.name}`,
    `Trigger: ${triggerKind === 'manual' ? 'run manually by me' : describeTrigger(routine.trigger)}`,
  ];
  if (event) {
    lines.push(`Triggering event: ${event.type} (event id ${event.id}${event.subject?.id ? `, ${event.subject.type || 'item'} id ${event.subject.id}` : ''})`);
  }
  lines.push('', routine.instruction);
  // Owner-authored skills from the vault: instructions, like the routine's own text.
  for (const skill of routine.skills || []) lines.push('', `Skill "${skill.name}" (how I want this done):`, skill.instructions);
  return lines.join('\n');
}

export function listRoutineStatus() {
  const db = getDb();
  const last = db.prepare('SELECT * FROM routine_runs WHERE routine_path = ? ORDER BY created_at DESC, id DESC LIMIT 1');
  return loadRoutines().map((routine) => {
    const run = last.get(routine.path);
    return {
      path: routine.path, name: routine.name, enabled: routine.enabled, error: routine.error,
      trigger: routine.trigger, schedule: describeTrigger(routine.trigger), instruction: routine.instruction, skills: (routine.skills || []).map((skill) => skill.name),
      lastRun: run ? { status: run.status, trigger: run.trigger_kind, runId: run.run_id, reason: run.reason, startedAt: run.created_at, completedAt: run.completed_at } : null,
    };
  });
}

function finish(db, id, status, runId, reason) {
  db.prepare('UPDATE routine_runs SET status = ?, run_id = ?, reason = ?, completed_at = ? WHERE id = ?').run(status, runId, reason, new Date().toISOString(), id);
}

function publish(eventBus, type, routine, data) {
  eventBus?.publish({ type, source: 'routine', actor: { type: 'routine', id: routine.path }, data: { routine: routine.path, ...data } });
}
