// Automation runtime (docs/plugin-architecture.md §9): turns triggers into
// durable workflow runs and keeps waiting runs moving.
//
//   schedule  next_run_at per automation instance, claimed once per slot
//   event     every published event (and any published while stopped, via a
//             durable cursor), deduplicated per automation and event id
//   manual    run now, on the owner's request
//
// Guards: an automation never triggers on events its own runs emitted; at
// most MAX_RUNS_PER_HOUR runs per automation per rolling hour; concurrency
// 'single' records overlapping triggers as skipped. Nothing here calls a
// capability: runs execute in WorkflowEngine, through the invoker and gate.
import { getDb } from '../db/connection.js';
import { log } from '../logging/logger.js';
import { resolveTemplate } from './expression.js';
import { defaultTriggerRegistry } from './triggers.js';
import { automationRequirements } from './dependencies.js';
import { effectiveSettings, listGrants, getStoredSettings } from './store.js';
import { checkPermissions } from './permissions.js';
import { summarizePolicy } from './policy.js';
import { workflowReferences } from './workflow.js';
import {
  getInstanceByAutomation, updateInstance, listRuns, listRunnableRuns, recoverInterruptedRuns, getEventCursor, setEventCursor,
  getRun, listSteps, ACTIVE_RUN_STATUSES,
} from './workflow-store.js';

export const MAX_RUNS_PER_HOUR = 60;
export const SCHEDULE_GRACE_MS = 60 * 60_000;
const DEFAULT_TICK_MS = 15_000;
const CATCH_UP_LIMIT = 500;

export class AutomationRuntime {
  constructor({ registries, engine, eventBus, triggerRegistry = defaultTriggerRegistry, clock = () => new Date(), maxRunsPerHour = MAX_RUNS_PER_HOUR }) {
    this.registries = registries;
    this.engine = engine;
    this.eventBus = eventBus;
    this.triggers = triggerRegistry;
    this.clock = clock;
    this.maxRunsPerHour = maxRunsPerHour;
    this._timer = null;
    this._unsubscribe = null;
    this._draining = null;
    this._drainRequested = 0;
    this._drainCompleted = 0;
    this._inFlight = new Set();
    // Set by stop(); drain() and tick() also work without start() (CLI, tests).
    this._stopped = false;
  }

  // --- lifecycle of the runtime itself ----------------------------------------

  start({ tickMs = Number(process.env.U2OS_AUTOMATION_TICK_MS) || DEFAULT_TICK_MS } = {}) {
    this._stopped = false;
    // This process owns the home (runtime/home-guard.js): anything left
    // 'running' belonged to a process that is gone.
    const recovered = recoverInterruptedRuns();
    if (recovered) log.info('automation', 'Recovered interrupted workflow runs', { count: recovered });
    if (getEventCursor() === null) setEventCursor(maxEventRowid());
    this._unsubscribe = this.eventBus.subscribe('*', (event) => this.handleEvent(event));
    this.catchUpEvents();
    this._timer = setInterval(() => this._track(this.tick()), tickMs);
    this._timer.unref?.();
    this._track(this.tick());
    return { tickMs };
  }

  async stop() {
    this._stopped = true;
    this._unsubscribe?.();
    this._unsubscribe = null;
    clearInterval(this._timer);
    this._timer = null;
    while (this._inFlight.size) await Promise.allSettled([...this._inFlight]);
  }

  _track(promise) {
    const tracked = Promise.resolve(promise).catch(() => log.error('automation', 'Automation runtime work failed'));
    this._inFlight.add(tracked);
    tracked.finally(() => this._inFlight.delete(tracked));
    return tracked;
  }

  // --- periodic work -------------------------------------------------------------

  async tick(now = this.clock()) {
    this.fireDueSchedules(now);
    this.engine.wakeDueRuns(now);
    this.engine.wakeActionWaits();
    this.engine.wakeChildWaits();
    await this.drain();
  }

  /** Starts runs for schedule triggers that are due; reschedules the rest. */
  fireDueSchedules(now = this.clock()) {
    const fired = [];
    for (const definition of this.registries.automations.list()) {
      const schedules = definition.triggers.filter((trigger) => trigger.type === 'schedule');
      if (!schedules.length) continue;
      const instance = getInstanceByAutomation(definition.id);
      if (!instance || !instance.enabled || instance.paused || !this._packageEnabled(definition)) continue;
      if (!instance.nextRunAt) { this._reschedule(instance, definition, now); continue; }
      const due = Date.parse(instance.nextRunAt);
      if (due > now.getTime()) continue;
      const slot = instance.nextRunAt;
      // The schedule whose next time from just before the slot is the slot.
      const trigger = schedules.find((candidate) => this.triggers.get('schedule').nextRun(candidate, new Date(due - 60_000))?.toISOString() === slot) || schedules[0];
      if (now.getTime() - due > SCHEDULE_GRACE_MS) {
        // Long downtime: do not replay stale work; record that it was missed.
        this._createRun(definition, instance, { type: 'schedule', slot, missed: true }, `schedule:${definition.id}:${slot}`, {}, { status: 'skipped', error: 'missed_schedule' });
      } else {
        const run = this._fire(definition, instance, trigger, { type: 'schedule', slot, cron: trigger.cron || null, every: trigger.every || null }, `schedule:${definition.id}:${slot}`);
        if (run) fired.push(run.id);
      }
      this._reschedule(getInstanceByAutomation(definition.id), definition, now);
    }
    return fired;
  }

  _reschedule(instance, definition, from) {
    const times = definition.triggers.filter((trigger) => trigger.type === 'schedule')
      .map((trigger) => this.triggers.get('schedule').nextRun(trigger, from)).filter(Boolean).map((date) => date.getTime());
    const next = times.length ? new Date(Math.min(...times)).toISOString() : null;
    updateInstance(instance.id, { nextRunAt: next });
    return next;
  }

  // --- events ----------------------------------------------------------------

  /** EventBus subscriber. Synchronous bookkeeping; execution is scheduled. */
  handleEvent(event) {
    if (this._stopped || !this._unsubscribe) return;
    try {
      const rowid = getDb().prepare('SELECT rowid FROM events WHERE id = ?').get(event.id)?.rowid;
      this._processEvent(event);
      if (rowid) setEventCursor(rowid);
    } catch {
      log.error('automation', 'Automation event handling failed', { type: event?.type });
    }
    this._track(this.drain());
  }

  /** Delivers events published while the runtime was stopped, once. */
  catchUpEvents() {
    const cursor = getEventCursor() ?? 0;
    const rows = getDb().prepare('SELECT rowid, * FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?').all(cursor, CATCH_UP_LIMIT);
    for (const row of rows) {
      try { this._processEvent(rowToEvent(row)); } catch { log.error('automation', 'Automation catch-up event failed', { type: row.type }); }
      setEventCursor(row.rowid);
    }
    return rows.length;
  }

  _processEvent(event) {
    if (event.type.startsWith('agent.action.')) this.engine.wakeActionWaits();
    this.engine.deliverEvent(event);
    for (const definition of this.registries.automations.list()) {
      const triggers = definition.triggers.filter((trigger) => trigger.type === 'event');
      if (!triggers.length) continue;
      const instance = getInstanceByAutomation(definition.id);
      if (!instance || !instance.enabled || instance.paused || !this._packageEnabled(definition)) continue;
      // Recursion guard: never react to events this automation's runs caused.
      if (event.metadata?.automationInstanceId === instance.id) continue;
      const settings = this._settings(definition);
      const trigger = triggers.find((candidate) => this.triggers.get('event').matches(candidate, event, { settings }));
      if (!trigger) continue;
      this._fire(definition, instance, trigger, { type: 'event', event: { id: event.id, type: event.type, source: event.source, subject: event.subject || null, data: event.data || {} } },
        `event:${definition.id}:${event.id}`);
    }
  }

  // --- starting runs ---------------------------------------------------------------

  _fire(definition, instance, trigger, triggerData, dedupeKey, extraInputs = {}) {
    let inputs = { ...extraInputs };
    if (trigger?.with) {
      try { inputs = { ...resolveTemplate(trigger.with, { trigger: triggerData, event: triggerData.event || null, settings: this._settings(definition) }, { now: this.clock() }), ...extraInputs }; }
      catch (error) { return this._createRun(definition, instance, triggerData, dedupeKey, {}, { status: 'failed', error: `trigger inputs: ${error.message}` }); }
    }
    const recent = getDb().prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE automation_instance_id = ? AND parent_run_id IS NULL AND created_at > ? AND status NOT IN ('skipped','throttled')")
      .get(instance.id, new Date(this.clock().getTime() - 3_600_000).toISOString()).n;
    if (recent >= this.maxRunsPerHour) return this._createRun(definition, instance, triggerData, dedupeKey, inputs, { status: 'throttled', error: 'hourly_run_limit' });
    if (definition.concurrency !== 'parallel' && listRuns({ instanceId: instance.id, status: ACTIVE_RUN_STATUSES, limit: 1 }).some((run) => !run.parentRunId)) {
      return this._createRun(definition, instance, triggerData, dedupeKey, inputs, { status: 'skipped', error: 'already_running' });
    }
    return this._createRun(definition, instance, triggerData, dedupeKey, inputs);
  }

  _createRun(definition, _instance, trigger, dedupeKey, inputs, { status = 'pending', error = null } = {}) {
    const { run, created } = this.engine.createAutomationRun({ automationId: definition.id, trigger, inputs, dedupeKey, status, error });
    return created ? run : null;
  }

  /**
   * Executes runnable runs one at a time (single flight). Resolves only
   * after a pass that began after this call has finished, so a caller that
   * just created a run can await its execution.
   */
  async drain() {
    const requested = ++this._drainRequested;
    while (!this._stopped && this._drainCompleted < requested) {
      if (this._draining) { await this._draining; continue; }
      const covers = this._drainRequested;
      this._draining = this._drainPass();
      try { await this._draining; } finally {
        this._draining = null;
        this._drainCompleted = Math.max(this._drainCompleted, covers);
      }
    }
  }

  async _drainPass() {
    for (let guard = 0; guard < 100 && !this._stopped; guard++) {
      const runnable = listRunnableRuns(25).filter((run) => this._mayExecute(run));
      if (!runnable.length) return;
      for (const run of runnable) {
        if (this._stopped) return;
        await this.engine.advance(run.id);
      }
    }
  }

  _mayExecute(run) {
    if (!run.instanceId) return true;
    const root = run.rootRunId && run.rootRunId !== run.id ? getRun(run.rootRunId) : run;
    return !(root?.instanceId && instancePaused(root.instanceId));
  }

  _packageEnabled(definition) {
    return this.registries.packages.get(definition.packageId)?.enabled === true;
  }

  _settings(definition) {
    const record = this.registries.packages.get(definition.packageId);
    return record ? effectiveSettings(record.manifest) : {};
  }

  // --- owner operations -----------------------------------------------------------

  _definition(automationId) {
    return this.registries.automations.get(automationId);
  }

  requirements(automationId) {
    const definition = this._definition(automationId);
    const record = this.registries.packages.get(definition.packageId);
    const { capabilities, permissions } = automationRequirements(definition, this.registries);
    const check = checkPermissions({ required: permissions, declared: record?.manifest.permissions || [], granted: listGrants(definition.packageId) });
    return { capabilities, permissions, missing: [...new Set([...check.missingDeclared, ...check.missingGrant])] };
  }

  enable(automationId) {
    const definition = this._definition(automationId);
    const instance = getInstanceByAutomation(automationId);
    if (!instance) throw httpError(404, `Automation ${automationId} is not installed`);
    if (!this._packageEnabled(definition)) throw httpError(409, `Package ${definition.packageId} is disabled`);
    const { missing } = this.requirements(automationId);
    if (missing.length) throw httpError(409, `Grant ${definition.packageId} these permissions before enabling ${automationId}: ${missing.join(', ')}`);
    updateInstance(instance.id, { enabled: true, paused: false });
    this._reschedule(getInstanceByAutomation(automationId), definition, this.clock());
    return this.inspect(automationId);
  }

  disable(automationId) {
    const instance = this._requireInstance(automationId);
    updateInstance(instance.id, { enabled: false, nextRunAt: null });
    return this.inspect(automationId);
  }

  pause(automationId) {
    const instance = this._requireInstance(automationId);
    updateInstance(instance.id, { paused: true });
    return this.inspect(automationId);
  }

  resume(automationId) {
    const instance = this._requireInstance(automationId);
    updateInstance(instance.id, { paused: false });
    this._track(this.drain());
    return this.inspect(automationId);
  }

  /** Manual trigger. Allowed while disabled (owner's explicit request), not while paused. */
  async runNow(automationId, inputs = {}, { wait = true } = {}) {
    const definition = this._definition(automationId);
    const instance = this._requireInstance(automationId);
    if (instance.paused) throw httpError(409, `${automationId} is paused`);
    if (!this._packageEnabled(definition)) throw httpError(409, `Package ${definition.packageId} is disabled`);
    const trigger = definition.triggers.find((candidate) => candidate.type === 'manual') || null;
    const run = this._fire(definition, instance, trigger, { type: 'manual', requestedAt: this.clock().toISOString() }, null, inputs || {});
    if (!run) throw httpError(409, 'Run could not be created');
    if (run.status !== 'pending') return run;
    if (!wait) { this._track(this.drain()); return getRun(run.id); }
    await this.drain();
    return getRun(run.id);
  }

  /** Cancels active runs of an automation. */
  stopRuns(automationId) {
    const instance = this._requireInstance(automationId);
    const cancelled = [];
    for (const run of listRuns({ instanceId: instance.id, status: ACTIVE_RUN_STATUSES, limit: 1000 })) {
      if (run.parentRunId) continue;
      this.engine.cancelRun(run.id, 'stopped by owner');
      cancelled.push(run.id);
    }
    return cancelled;
  }

  inspect(automationId, { runLimit = 20 } = {}) {
    const definition = this._definition(automationId);
    const instance = this._requireInstance(automationId);
    const record = this.registries.packages.get(definition.packageId);
    const stored = getStoredSettings(definition.packageId);
    const policyNames = new Set();
    for (const step of definition.workflow.steps || []) if (step.policy) policyNames.add(step.policy);
    const refs = workflowReferences(definition.workflow);
    const runs = listRuns({ instanceId: instance.id, limit: runLimit }).filter((run) => !run.parentRunId);
    return {
      id: definition.id,
      packageId: definition.packageId,
      name: definition.name,
      description: definition.description,
      enabled: instance.enabled,
      paused: instance.paused,
      packageEnabled: record?.enabled === true,
      running: runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status)),
      concurrency: definition.concurrency,
      triggers: definition.triggers.map((trigger) => ({ ...trigger, description: this.triggers.get(trigger.type)?.describe(trigger) || trigger.type })),
      nextRunAt: instance.enabled ? instance.nextRunAt : null,
      lastRun: runs[0] ? summarizeRun(runs[0]) : null,
      state: instance.state,
      requirements: this.requirements(automationId),
      uses: refs,
      policies: [...policyNames].map((name) => summarizePolicy(name, record?.manifest.policies[name], stored.policies[name])),
      runs: runs.map(summarizeRun),
    };
  }

  runDetail(runId) {
    const run = getRun(runId);
    if (!run) throw httpError(404, 'Run not found');
    const children = listRuns({ parentRunId: runId, limit: 1000 });
    return { ...summarizeRun(run), inputs: run.inputs, outputs: run.outputs, wait: run.wait, steps: listSteps(runId), children: children.map(summarizeRun) };
  }

  list() {
    return this.registries.automations.list().map((definition) => {
      try { return this.inspect(definition.id, { runLimit: 5 }); } catch { return null; }
    }).filter(Boolean);
  }

  _requireInstance(automationId) {
    this._definition(automationId);
    const instance = getInstanceByAutomation(automationId);
    if (!instance) throw httpError(404, `Automation ${automationId} is not installed`);
    return instance;
  }
}

function instancePaused(id) {
  return getDb().prepare('SELECT paused FROM automation_instances WHERE id = ?').get(id)?.paused === 1;
}

export function summarizeRun(run) {
  return {
    id: run.id, kind: run.kind, definitionId: run.definitionId, status: run.status, trigger: run.trigger?.type || null,
    error: run.error, waitingFor: run.status === 'waiting' ? run.wait?.type || null : null, wakeAt: run.wakeAt,
    createdAt: run.createdAt, startedAt: run.startedAt, completedAt: run.completedAt,
  };
}

function maxEventRowid() {
  return getDb().prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM events').get().n;
}

function rowToEvent(row) {
  return {
    id: row.id, type: row.type, timestamp: row.timestamp, source: row.source,
    actor: row.actor_type ? { type: row.actor_type, id: row.actor_id } : null,
    subject: row.subject_type ? { type: row.subject_type, id: row.subject_id } : null,
    data: JSON.parse(row.data || '{}'), metadata: JSON.parse(row.metadata || '{}'),
    correlationId: row.correlation_id, causationId: row.causation_id, createdAt: row.created_at,
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
