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
    const id = newId('wake');
    const fireAt = new Date(time).toISOString();
    const trigger = createTrigger({ name: 'Bounded goal wake', kind: 'timer', source: 'goal',
      config: { fireAt, action: { kind: 'goal_run', wakeId: id } } });
    getDb().prepare(`INSERT INTO goal_wakes (id, goal_id, goal_revision, trigger_id, fire_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, goal.id, goal.revision, trigger.id, fireAt, new Date(now).toISOString(), new Date(now).toISOString());
    return getGoalDraft(goal.id, ownerId);
  });
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
