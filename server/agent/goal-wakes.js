import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { createTrigger } from '../triggers/trigger-engine.js';
import { getGoalDraft, goalRunObjective } from './goal-store.js';
import { getRun } from './run-store.js';

/** Owner-selected, once-only wake. No model chooses timing or authority. */
export function scheduleGoalWake(goalId, ownerId, input) {
  if (!input || Object.keys(input).some((key) => !['fireAt', 'expectedRevision'].includes(key)) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.fireAt !== 'string') throw error(400, 'fireAt and a positive expectedRevision are required');
  const time = Date.parse(input.fireAt);
  const now = Date.now();
  if (!Number.isFinite(time) || time <= now || time > now + 30 * 86400_000) throw error(400, 'Choose a future wake within 30 days');
  return withTransaction(getDb(), () => {
    const goal = getGoalDraft(goalId, ownerId);
    if (goal.revision !== input.expectedRevision) throw error(409, 'Goal changed; reload before scheduling');
    if (!goal.manualRunAvailable) throw error(409, 'Goal is stopped, busy, or out of budget; resolve it before scheduling');
    if (goal.nextWakeAt) throw error(409, 'A wake is already scheduled; pause the goal to cancel it');
    if (goal.researchSchedule?.status === 'active') throw error(409, 'Research schedule is active; pause the goal before changing its timing');
    createWake(goal, new Date(time).toISOString(), new Date(now).toISOString());
    return getGoalDraft(goal.id, ownerId);
  });
}

/** Called only inside the caller's transaction; never awaits or calls a model. */
function createWake(goal, fireAt, now) {
  const id = newId('wake');
  const trigger = createTrigger({ name: 'Bounded goal wake', kind: 'timer', source: 'goal',
    config: { fireAt, action: { kind: 'goal_run', wakeId: id } } });
  getDb().prepare(`INSERT INTO goal_wakes (id, goal_id, goal_revision, trigger_id, fire_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, goal.id, goal.revision, trigger.id, fireAt, now, now);
  return id;
}

/** Fixed timing and finite count come from the authenticated owner, not a plan. */
export function scheduleGoalResearch(goalId, ownerId, input) {
  if (!input || Array.isArray(input) || Object.keys(input).some((key) => !['fireAt', 'expectedRevision', 'intervalHours', 'maxPasses'].includes(key)) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.fireAt !== 'string' ||
      !Number.isSafeInteger(input.intervalHours) || input.intervalHours < 24 || input.intervalHours > 720 ||
      !Number.isSafeInteger(input.maxPasses) || input.maxPasses < 2 || input.maxPasses > 10) throw error(400, 'Choose 2–10 passes, 24–720 hour intervals, fireAt and expectedRevision');
  const now = Date.now();
  const time = Date.parse(input.fireAt);
  if (!Number.isFinite(time) || time <= now || time > now + 30 * 86400_000) throw error(400, 'Choose a future start within 30 days');
  return withTransaction(getDb(), () => {
    const goal = getGoalDraft(goalId, ownerId);
    if (goal.revision !== input.expectedRevision) throw error(409, 'Goal changed; reload before scheduling');
    if (goal.permittedScope.domains.length !== 1 || goal.permittedScope.domains[0] !== 'web') throw error(409, 'Finite research requires web-only goal scope');
    if (!goal.manualRunAvailable || goal.nextWakeAt || goal.researchSchedule?.status === 'active') throw error(409, 'Goal is stopped, busy, scheduled or out of budget; review it first');
    if (goal.spent.runs + input.maxPasses > goal.budgets.maxRuns || goal.spent.modelCalls + input.maxPasses > goal.budgets.maxModelCalls) throw error(409, 'Selected pass count exceeds remaining run/model budgets');
    const nowIso = new Date(now).toISOString();
    const wakeId = createWake(goal, new Date(time).toISOString(), nowIso);
    getDb().prepare(`INSERT INTO goal_research_schedules
      (id, goal_id, goal_revision, interval_hours, max_passes, wake_id, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId('research'), goal.id, goal.revision, input.intervalHours, input.maxPasses, wakeId, nowIso, nowIso, nowIso);
    return getGoalDraft(goal.id, ownerId);
  });
}

/** Bounded local reconciliation. One transaction checkpoints each successful
 * pass and creates its next future wake; restart cannot rearm that pass. */
export function advanceGoalResearchSchedules(now = new Date()) {
  const db = getDb();
  const nowIso = now.toISOString();
  const rows = db.prepare("SELECT id FROM goal_research_schedules WHERE status = 'active' ORDER BY checked_at, id LIMIT 20").all();
  let unavailable = 0;
  for (const { id } of rows) {
    try {
      withTransaction(db, () => {
        const series = db.prepare("SELECT * FROM goal_research_schedules WHERE id = ? AND status = 'active'").get(id);
        if (!series) return;
        db.prepare('UPDATE goal_research_schedules SET checked_at = ? WHERE id = ?').run(nowIso, id);
        const stop = (blocker) => db.prepare("UPDATE goal_research_schedules SET status = 'blocked', blocker = ?, updated_at = ? WHERE id = ?")
          .run(blocker, nowIso, id);
        const owner = db.prepare('SELECT owner_id FROM goals WHERE id = ?').get(series.goal_id);
        if (!owner) return stop('goal_unavailable');
        const goal = getGoalDraft(series.goal_id, owner.owner_id);
        if (goal.revision !== series.goal_revision || !['draft', 'active'].includes(goal.status) ||
            goal.permittedScope.domains.length !== 1 || goal.permittedScope.domains[0] !== 'web') return stop('goal_unavailable');
        const wake = db.prepare('SELECT * FROM goal_wakes WHERE id = ? AND goal_id = ? AND goal_revision = ?')
          .get(series.wake_id, goal.id, series.goal_revision);
        if (!wake) return stop('inspect_wake');
        if (wake.status === 'pending') return;
        if (wake.status !== 'started' || !wake.run_id) return stop('inspect_wake');
        if (!db.prepare('SELECT 1 FROM agent_runs WHERE id = ? AND goal_id = ? AND actor_id = ? AND goal_revision = ?')
          .get(wake.run_id, goal.id, owner.owner_id, series.goal_revision)) return stop('inspect_run');
        const run = getRun(wake.run_id);
        if (['failed', 'cancelled', 'budget_exhausted', 'needs_attention'].includes(run.status) ||
            run.steps.some((step) => ['failed', 'blocked', 'rejected', 'cancelled', 'skipped', 'uncertain', 'outcome_uncertain', 'needs_attention'].includes(step.status))) return stop('inspect_run_outcome');
        if (run.status !== 'completed') return; // No model polling or overlapping work.
        const actions = db.prepare(`SELECT s.tool, s.status, a.status AS outcome FROM agent_run_steps s
          LEFT JOIN agent_actions a ON a.id = s.action_id WHERE s.run_id = ?`).all(run.id);
        if (!actions.length || actions.some((action) => action.status !== 'executed' || action.outcome !== 'executed') ||
            !actions.some((action) => action.tool === 'web.search')) return stop('no_confirmed_research');
        db.prepare('UPDATE goal_research_schedules SET successful_passes = successful_passes + 1, blocker = NULL, updated_at = ? WHERE id = ?').run(nowIso, id);
        if (series.scheduled_passes >= series.max_passes) {
          db.prepare("UPDATE goal_research_schedules SET status = 'completed' WHERE id = ?").run(id);
          return;
        }
        if (!goal.manualRunAvailable) return stop('review_goal_budget_or_run');
        // Skip missed intervals: the next pass is never a catch-up burst.
        const fireAt = new Date(Math.max(now.getTime(), Date.parse(wake.fire_at)) + series.interval_hours * 3600_000).toISOString();
        const wakeId = createWake(goal, fireAt, nowIso);
        db.prepare(`UPDATE goal_research_schedules SET wake_id = ?, scheduled_passes = scheduled_passes + 1,
          updated_at = ? WHERE id = ?`).run(wakeId, nowIso, id);
      });
    } catch {
      // A local projection/checkpoint failure must not stall unrelated due
      // wakes or leak raw database text. Retrying this transaction performs
      // no external effect; the previous run remains authoritative.
      unavailable++;
      try { db.prepare("UPDATE goal_research_schedules SET blocker = 'checkpoint_unavailable', checked_at = ? WHERE id = ? AND status = 'active'").run(nowIso, id); } catch { /* Storage itself may be unavailable. */ }
    }
  }
  return { checked: rows.length, unavailable };
}

/** The run store atomically consumes the wake together with run creation,
 * before any await/model/provider call. Restart never replays that wake. */
export async function runScheduledGoalWake(trigger, agent) {
  const wake = getDb().prepare('SELECT * FROM goal_wakes WHERE id = ? AND trigger_id = ?')
    .get(trigger.config?.action?.wakeId, trigger.id);
  if (!wake || trigger.source !== 'goal' || trigger.kind !== 'timer') return { status: 'blocked', blocker: 'invalid_goal_wake' };
  if (wake.status !== 'pending') return { status: wake.status, runId: wake.run_id, blocker: wake.blocker };
  const owner = getDb().prepare('SELECT owner_id FROM goals WHERE id = ?').get(wake.goal_id);
  try {
    const goal = getGoalDraft(wake.goal_id, owner?.owner_id);
    if (goal.revision !== wake.goal_revision || !['draft', 'active'].includes(goal.status)) throw error(409, 'Goal changed', 'goal_unavailable');
    if (!goal.manualRunAvailable) throw error(409, 'Goal busy or budget exhausted', 'review_goal_budget_or_run');
    const result = await agent.handleMessage({ text: goalRunObjective(goal), actorId: owner.owner_id,
      goalId: goal.id, goalWakeId: wake.id });
    if (getRun(result.runId).status !== 'completed') getDb().prepare("UPDATE goal_wakes SET blocker = 'inspect_run_status' WHERE id = ?")
      .run(wake.id);
    return { goalId: goal.id, runId: result.runId, status: 'started' };
  } catch (cause) {
    // Never persist provider/model error text (may contain private content).
    // If a run exists, its actual status/evidence is authoritative.
    const blocker = ['goal_unavailable', 'review_goal_budget_or_run'].includes(cause?.blocker) ? cause.blocker : 'run_not_started';
    getDb().prepare(`UPDATE goal_wakes SET status = 'blocked', blocker = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run(blocker, new Date().toISOString(), wake.id);
    getDb().prepare("UPDATE goal_wakes SET blocker = 'inspect_run_failure' WHERE id = ? AND status = 'started'").run(wake.id);
    const current = getDb().prepare('SELECT status, run_id FROM goal_wakes WHERE id = ?').get(wake.id);
    return { goalId: wake.goal_id, runId: current.run_id, status: current.status,
      blocker: current.run_id ? 'inspect_run_failure' : blocker };
  }
}

function error(status, message, blocker) { const result = new Error(message); result.status = status; result.blocker = blocker; return result; }
