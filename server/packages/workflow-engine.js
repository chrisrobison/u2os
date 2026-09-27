// Durable workflow engine (docs/plugin-architecture.md §7-8).
//
// Runs skills and automations as a sequence of steps over plain data. After
// every step and every foreach item the run is checkpointed; waiting (for an
// approval, a child skill run, a timer or an event) stores a structured
// handle, never JavaScript state. A crashed or restarted process resumes a
// run from its last checkpoint, and a step that already proposed an action
// re-reads that action instead of proposing it again.
//
// The engine never touches providers: capability steps go through the
// CapabilityInvoker, i.e. permissions, package policy, policies.yaml, the
// audit log and the durable action queue.
import { newId } from '../db/ids.js';
import { getAgentAction, updateAgentAction } from '../policy/policy-engine.js';
import { log } from '../logging/logger.js';
import { evaluate, resolveTemplate, truthy } from './expression.js';
import { applyDefaults, validate } from './json-schema.js';
import { evaluatePackagePolicy } from './policy.js';
import { emitProblem } from './events.js';
import { conditionSource, parseDuration, parseUse } from './workflow.js';
import { effectiveSettings, getStoredSettings } from './store.js';
import { moduleExecutor } from './providers.js';
import {
  insertRun, getRun, getRunByDedupe, leaseRun, renewRunLease, checkpointRun, suspendRun, finishRun, wakeRun, listWaitingRuns,
  recordStep, listRuns, getInstance, getInstanceByAutomation, updateInstance, TERMINAL_RUN_STATUSES, ACTIVE_RUN_STATUSES,
} from './workflow-store.js';

export const MAX_FOREACH_ITEMS = 500;
export const MAX_SKILL_DEPTH = 8;
const MAX_ERROR_LENGTH = 500;

export class WorkflowEngine {
  constructor({ registries, invoker, eventBus, leaseOwner = newId('wfworker'), leaseMs = 60_000, clock = () => new Date() }) {
    this.registries = registries;
    this.invoker = invoker;
    this.eventBus = eventBus;
    this.leaseOwner = leaseOwner;
    this.leaseMs = leaseMs;
    this.clock = clock;
  }

  // --- creating runs -----------------------------------------------------------

  /**
   * Creates an automation run. Returns { run, created } -- created is false
   * when the dedupe key was already claimed (duplicate trigger delivery).
   */
  createAutomationRun({ automationId, trigger = { type: 'manual' }, inputs = {}, dedupeKey = null, status = 'pending', error = null }) {
    const definition = this.registries.automations.get(automationId);
    const record = this.registries.packages.get(definition.packageId);
    const instance = this._instanceFor(automationId);
    const run = insertRun({
      kind: 'automation', definitionId: automationId, packageId: definition.packageId, packageVersion: record?.manifest.version,
      instanceId: instance?.id, trigger, dedupeKey, status, error, workflow: definition.workflow,
      inputs: this._prepareInputs(definition.workflow, inputs), correlationId: newId('corr'),
    });
    if (!run) return { run: dedupeKey ? getRunByDedupe(dedupeKey) : null, created: false };
    if (instance && ACTIVE_RUN_STATUSES.includes(status)) updateInstance(instance.id, { lastRunId: run.id, lastRunAt: run.createdAt, lastStatus: status });
    else if (instance) updateInstance(instance.id, { lastRunId: run.id, lastRunAt: run.createdAt, lastStatus: status, lastError: error });
    return { run, created: true };
  }

  /** Runs a skill to completion (or its first wait) outside any automation. */
  async runSkill(skillId, input = {}, { packageId = null } = {}) {
    const skill = this.registries.skills.get(skillId);
    const inputs = this._prepareSkillInput(skill, input);
    const errors = validate(skill.inputSchema, inputs, 'input');
    const run = insertRun({
      kind: 'skill', definitionId: skillId, packageId: packageId || skill.packageId, packageVersion: skill.version,
      trigger: { type: 'manual' }, workflow: skill.workflow || { implementation: skill.implementation },
      inputs, correlationId: newId('corr'),
      ...(errors.length ? { status: 'failed', error: `Invalid input for skill ${skillId}: ${errors.join('; ')}` } : {}),
    });
    return errors.length ? run : this.advance(run.id);
  }

  _instanceFor(automationId) {
    return getInstanceByAutomation(automationId);
  }

  _prepareInputs(workflow, inputs) {
    const schema = workflow?.inputs ? { type: 'object', properties: workflow.inputs } : null;
    return schema ? applyDefaults(schema, inputs || {}) : (inputs || {});
  }

  _prepareSkillInput(skill, input) {
    const prepared = applyDefaults(skill.inputSchema, input ?? {});
    return skill.workflow ? this._prepareInputs(skill.workflow, prepared) : prepared;
  }

  // --- execution -------------------------------------------------------------------

  /**
   * Executes a pending run until it completes, fails or waits. Safe to call
   * for any run id: a run that is not pending (already leased, waiting or
   * finished) is returned unchanged.
   */
  async advance(runId) {
    const leased = leaseRun(runId, { leaseOwner: this.leaseOwner, leaseMs: this.leaseMs });
    if (!leased) return getRun(runId);
    const heartbeat = setInterval(() => renewRunLease(runId, { leaseOwner: this.leaseOwner, leaseMs: this.leaseMs }), Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      if (leased.kind === 'automation' && leased.position.step === 0 && !leased.position.handle && !Object.keys(leased.context).length) {
        this._publish('automation.started', leased);
      }
      return await this._execute(leased);
    } catch (error) {
      log.error('workflow', 'Workflow run failed unexpectedly', { runId, error: error?.code || 'internal' });
      return this._finish(getRun(runId), 'failed', { error: boundedError(error) });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async _execute(run) {
    const record = this.registries.packages.get(run.packageId);
    if (!record) return this._finish(run, 'failed', { error: `Package ${run.packageId} is not installed` });
    if (!record.enabled) return this._finish(run, 'failed', { error: `Package ${run.packageId} is disabled` });
    const instance = run.instanceId ? getInstance(run.instanceId) : null;
    const workflow = run.workflow;
    const context = run.context;
    const position = run.position;
    const scope = {
      inputs: run.inputs,
      steps: context,
      settings: effectiveSettings(record.manifest),
      state: instance ? instance.state : {},
      trigger: run.trigger,
      run: { id: run.id, startedAt: run.startedAt },
    };
    const env = { run, record, instance, context, position, scope, workflow };

    if (workflow.implementation) return this._executeCodeSkill(env);

    while (position.step < workflow.steps.length) {
      const step = workflow.steps[position.step];
      const result = await this._executeStep(env, step);
      if (result.type === 'wait') {
        const suspended = suspendRun(run.id, { context, position, wait: result.wait, wakeAt: result.wakeAt || null, leaseOwner: this.leaseOwner });
        if (run.kind === 'automation') {
          this._publish('automation.waiting', suspended, { waitingFor: result.wait.type });
          if (run.instanceId) updateInstance(run.instanceId, { lastStatus: 'waiting' });
        }
        return suspended;
      }
      if (result.type === 'fail') return this._finish(run, 'failed', { error: result.error, context, position });
      position.step += 1;
      position.iteration = 0;
      position.items = null;
      position.results = [];
      position.handle = null;
      checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
    }

    let output;
    try {
      output = workflow.output !== undefined ? resolveTemplate(workflow.output, scope, { now: this.clock() }) : lastOutput(workflow, context);
    } catch (error) {
      return this._finish(run, 'failed', { error: `output: ${boundedError(error)}`, context, position });
    }
    if (run.kind === 'skill') {
      const skill = this.registries.skills.find(run.definitionId);
      const errors = skill?.outputSchema ? validate(skill.outputSchema, output, 'output') : [];
      if (errors.length) return this._finish(run, 'failed', { error: `Skill ${run.definitionId} returned invalid output: ${errors.join('; ')}`, context, position });
    }
    return this._finish(run, 'completed', { outputs: output ?? null, context, position });
  }

  async _executeCodeSkill({ run, record, position }) {
    const execute = moduleExecutor({ packageId: run.packageId, packageDir: record.installPath, implementation: run.workflow.implementation, invoker: this.invoker, label: `skill ${run.definitionId}` });
    try {
      const output = await execute(run.inputs, { skillId: run.definitionId, workflowRunId: run.id, correlationId: run.correlationId });
      const skill = this.registries.skills.find(run.definitionId);
      const errors = skill?.outputSchema ? validate(skill.outputSchema, output, 'output') : [];
      if (errors.length) return this._finish(run, 'failed', { error: `Skill ${run.definitionId} returned invalid output: ${errors.join('; ')}` });
      return this._finish(run, 'completed', { outputs: output ?? null, position });
    } catch (error) {
      return this._finish(run, 'failed', { error: boundedError(error) });
    }
  }

  /**
   * Executes one step (all of its foreach items). Returns { type: 'next' },
   * { type: 'wait', wait, wakeAt } or { type: 'fail', error }.
   */
  async _executeStep(env, step) {
    const { run, context, position, scope } = env;
    const use = parseUse(step.use);
    const now = () => this.clock();

    if (step.foreach !== undefined && position.items === null) {
      let items;
      try { items = resolveTemplate(step.foreach, scope, { now: now() }); } catch (error) { return { type: 'fail', error: `${step.id}.foreach: ${boundedError(error)}` }; }
      if (items === null || items === undefined) items = [];
      if (!Array.isArray(items)) return { type: 'fail', error: `${step.id}.foreach must resolve to a list` };
      if (items.length > MAX_FOREACH_ITEMS) return { type: 'fail', error: `${step.id}.foreach has more than ${MAX_FOREACH_ITEMS} items` };
      position.items = items;
      position.results = [];
      position.iteration = 0;
      checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
    }
    const iterations = step.foreach !== undefined ? position.items.length : 1;

    while (position.iteration < iterations) {
      const iteration = step.foreach !== undefined ? position.iteration : -1;
      const unitScope = step.foreach !== undefined ? { ...scope, item: position.items[iteration], index: iteration } : scope;

      if (step.when !== undefined && !position.handle) {
        let pass;
        try { pass = truthy(evaluate(conditionSource(step.when), unitScope, { now: now() })); } catch (error) { return { type: 'fail', error: `${step.id}.when: ${boundedError(error)}` }; }
        if (!pass) {
          recordStep({ runId: run.id, stepId: step.id, iteration, kind: use.kind, status: 'skipped', output: null });
          this._advanceIteration(env, step, { skipped: true });
          continue;
        }
      }

      const outcome = await this._runUnit(env, step, use, unitScope, iteration);
      if (outcome.status === 'waiting') {
        recordStep({ runId: run.id, stepId: step.id, iteration, kind: use.kind, status: 'waiting', attempts: position.handle?.attempt || 0,
          actionId: position.handle?.actionId, childRunId: position.handle?.childRunId, policy: position.handle?.policy });
        return { type: 'wait', wait: outcome.wait, wakeAt: outcome.wakeAt };
      }
      if (outcome.status === 'completed') {
        recordStep({ runId: run.id, stepId: step.id, iteration, kind: use.kind, status: 'completed', attempts: (position.handle?.attempt || 0) + 1,
          actionId: outcome.actionId || position.handle?.actionId, childRunId: position.handle?.childRunId, policy: position.handle?.policy, output: outcome.output });
        this._advanceIteration(env, step, { output: outcome.output });
        continue;
      }
      if (outcome.status === 'skipped') {
        // Package policy said no, or the owner rejected the action: the item
        // is skipped and audited, and the run goes on.
        recordStep({ runId: run.id, stepId: step.id, iteration, kind: use.kind, status: 'skipped', actionId: outcome.actionId,
          policy: position.handle?.policy, error: outcome.reason, output: null });
        this._advanceIteration(env, step, { skipped: true });
        continue;
      }

      // failed or denied
      const attempt = (position.handle?.attempt || 0) + 1;
      const retry = step.retry && outcome.retryable !== false && attempt < step.retry.attempts;
      if (retry) {
        const backoff = parseDuration(step.retry.backoff ?? 0) || 0;
        position.handle = { attempt };
        recordStep({ runId: run.id, stepId: step.id, iteration, kind: use.kind, status: 'waiting', attempts: attempt, error: outcome.reason });
        if (backoff > 0) {
          const wakeAt = new Date(now().getTime() + backoff).toISOString();
          return { type: 'wait', wait: { type: 'retry', attempt, until: wakeAt }, wakeAt };
        }
        checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
        continue;
      }
      recordStep({ runId: run.id, stepId: step.id, iteration, kind: use.kind, status: outcome.status === 'denied' ? 'denied' : 'failed', attempts: attempt,
        actionId: outcome.actionId || position.handle?.actionId, childRunId: position.handle?.childRunId, policy: position.handle?.policy, error: outcome.reason, output: null });
      if (step.onError === 'continue') {
        this._advanceIteration(env, step, { failed: true });
        continue;
      }
      return { type: 'fail', error: `Step ${step.id}${iteration >= 0 ? `[${iteration}]` : ''} ${outcome.status === 'denied' ? 'was denied' : 'failed'}: ${outcome.reason || 'unknown error'}` };
    }

    if (step.foreach !== undefined) context[step.id] = { status: 'completed', output: position.results };
    return { type: 'next' };
  }

  _advanceIteration({ run, context, position }, step, { output = null, skipped = false, failed = false } = {}) {
    if (step.foreach !== undefined) {
      // Skipped items are left out; failed items (onError: continue) are null.
      if (!skipped) position.results.push(failed ? null : output);
    } else {
      context[step.id] = { status: skipped ? 'skipped' : failed ? 'failed' : 'completed', output: skipped || failed ? null : output };
    }
    position.iteration += 1;
    position.handle = null;
    checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
  }

  /** Runs one unit (a step, or one foreach item). */
  async _runUnit(env, step, use, scope, iteration) {
    const now = this.clock();
    try {
      switch (use.kind) {
        case 'capability': return await this._capabilityUnit(env, step, use.target, scope);
        case 'skill': return await this._skillUnit(env, step, use.target, scope, iteration);
        case 'transform': return { status: 'completed', output: resolveTemplate(step.with?.value, scope, { now }) };
        case 'filter': {
          const source = resolveTemplate(step.with.source, scope, { now });
          if (!Array.isArray(source)) return { status: 'failed', reason: 'filter source must be a list', retryable: false };
          const where = conditionSource(step.with.where);
          return { status: 'completed', output: source.filter((item) => truthy(evaluate(where, { ...scope, item }, { now }))) };
        }
        case 'emit': return this._emitUnit(env, step, scope);
        case 'state': return this._stateUnit(env, step, scope);
        case 'sleep': return this._sleepUnit(env, step, scope);
        case 'wait': return this._waitUnit(env, step, scope);
        default: return { status: 'failed', reason: `Unsupported step ${step.use}`, retryable: false };
      }
    } catch (error) {
      return { status: 'failed', reason: boundedError(error) };
    }
  }

  async _capabilityUnit({ run, record, context, position }, step, capabilityId, scope) {
    const handle = position.handle || {};
    const contract = this.registries.capabilities.has(capabilityId) ? this.registries.capabilities.get(capabilityId) : null;
    // Resume: an action was already proposed for this unit.
    if (handle.actionId && getAgentAction(handle.actionId)) {
      const outcome = this.invoker.actionOutcome(capabilityId, handle.actionId);
      return this._mapCapabilityOutcome(outcome, contract, handle.actionId);
    }
    const input = resolveTemplate(step.with || {}, scope, { now: this.clock() });
    let policy = null;
    if (step.policy) {
      const stored = getStoredSettings(record.manifest.id);
      policy = evaluatePackagePolicy(step.policy, record.manifest.policies[step.policy], { ...scope, input }, { approvalOverride: stored.policies[step.policy], now: this.clock() });
    }
    // Checkpoint the action id before proposing, so a crash never proposes twice.
    const actionId = handle.actionId || newId('act');
    position.handle = { ...handle, actionId, policy };
    checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
    // Capability calls act with the grants of the package the owner
    // delegated to (the root automation's), never a skill's own package, so
    // composing another package's skill cannot borrow its permissions.
    const ctx = {
      packageId: run.principalPackageId,
      automationId: run.kind === 'automation' ? run.definitionId : null,
      skillId: run.kind === 'skill' ? run.definitionId : null,
      workflowRunId: run.id,
      stepId: step.id,
      actionId,
      correlationId: run.correlationId,
      policy,
    };
    const timeoutMs = step.timeout !== undefined && contract?.effect === 'read' ? parseDuration(step.timeout) : null;
    const outcome = timeoutMs ? await withTimeout(this.invoker.invoke(capabilityId, input, ctx), timeoutMs, `${capabilityId} timed out`) : await this.invoker.invoke(capabilityId, input, ctx);
    return this._mapCapabilityOutcome(outcome, contract, actionId);
  }

  _mapCapabilityOutcome(outcome, contract, actionId) {
    const consequential = contract?.effect !== 'read';
    switch (outcome.status) {
      case 'completed': return { status: 'completed', output: outcome.output, actionId };
      case 'waiting': return { status: 'waiting', wait: { type: 'action', actionId, capability: contract?.id }, actionId };
      case 'denied': {
        const rule = getAgentAction(actionId)?.policy_rule || '';
        if (rule.startsWith('package-policy:') || outcome.code === 'rejected') return { status: 'skipped', reason: outcome.reason, actionId };
        return { status: 'denied', reason: outcome.reason, actionId, retryable: false };
      }
      default:
        // The action queue owns retries and uncertain outcomes for
        // consequential capabilities; the workflow never re-proposes them.
        return { status: 'failed', reason: outcome.reason, actionId, retryable: !consequential && !['invalid_input', 'unknown_capability', 'no_provider'].includes(outcome.code) };
    }
  }

  async _skillUnit({ run, context, position }, step, skillId, scope, iteration) {
    const handle = position.handle || {};
    let child = handle.childRunId ? getRun(handle.childRunId) : null;
    if (!child) {
      const skill = this.registries.skills.find(skillId);
      if (!skill) return { status: 'failed', reason: `Unknown skill ${skillId}`, retryable: false };
      if (run.depth + 1 > MAX_SKILL_DEPTH) return { status: 'failed', reason: `Skills are nested more than ${MAX_SKILL_DEPTH} levels deep`, retryable: false };
      const input = this._prepareSkillInput(skill, resolveTemplate(step.with || {}, scope, { now: this.clock() }));
      const errors = validate(skill.inputSchema, input, 'input');
      if (errors.length) return { status: 'failed', reason: `Invalid input for skill ${skillId}: ${errors.join('; ')}`, retryable: false };
      const dedupeKey = `child:${run.id}:${step.id}:${iteration}:${handle.attempt || 0}`;
      child = insertRun({
        kind: 'skill', definitionId: skillId, packageId: skill.packageId, packageVersion: skill.version,
        principalPackageId: run.principalPackageId, rootRunId: run.rootRunId, parentRunId: run.id, parentStepId: step.id, depth: run.depth + 1,
        trigger: { type: 'skill', parentRunId: run.id }, dedupeKey, correlationId: run.correlationId,
        workflow: skill.workflow || { implementation: skill.implementation }, inputs: input,
      }) || getRunByDedupe(dedupeKey);
      position.handle = { ...handle, childRunId: child.id };
      checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
    }
    if (child.status === 'pending') child = await this.advance(child.id);
    if (child.status === 'completed') return { status: 'completed', output: child.outputs };
    if (child.status === 'failed' || child.status === 'cancelled') return { status: 'failed', reason: `skill ${skillId}: ${child.error || child.status}` };
    return { status: 'waiting', wait: { type: 'child', runId: child.id } };
  }

  _emitUnit({ run, record }, step, scope) {
    const type = step.with.type;
    const problem = emitProblem(type, record.manifest.events.emits);
    if (problem) return { status: 'failed', reason: problem, retryable: false };
    const data = resolveTemplate(step.with.data ?? {}, scope, { now: this.clock() });
    const subject = step.with.subject !== undefined ? resolveTemplate(step.with.subject, scope, { now: this.clock() }) : null;
    if (subject !== null && (typeof subject?.type !== 'string' || typeof subject?.id !== 'string')) return { status: 'failed', reason: 'emit subject must be { type, id }', retryable: false };
    const event = this.eventBus.publish({
      type,
      source: `package:${run.packageId}`,
      actor: { type: 'package', id: run.packageId },
      subject,
      data: data && typeof data === 'object' ? data : { value: data },
      correlationId: run.correlationId,
      metadata: { packageId: run.packageId, workflowRunId: run.id, automationInstanceId: run.instanceId || null, stepId: step.id, provenance: `package:${run.packageId}` },
    });
    return { status: 'completed', output: { eventId: event.id, type } };
  }

  _stateUnit({ run, instance }, step, scope) {
    if (!instance) return { status: 'failed', reason: 'state steps need an automation instance', retryable: false };
    const updates = resolveTemplate(step.with.set, scope, { now: this.clock() });
    const next = { ...scope.state, ...updates };
    const definition = this.registries.automations.find(run.definitionId);
    const errors = definition?.state?.schema ? validate(definition.state.schema, next, 'state') : [];
    if (errors.length) return { status: 'failed', reason: `Invalid automation state: ${errors.join('; ')}`, retryable: false };
    const saved = updateInstance(instance.id, { state: next });
    scope.state = saved.state;
    return { status: 'completed', output: saved.state };
  }

  _sleepUnit({ run, context, position }, step, scope) {
    const handle = position.handle || {};
    let until = handle.until;
    if (!until) {
      if (step.with.until !== undefined) {
        const value = resolveTemplate(step.with.until, scope, { now: this.clock() });
        const time = Date.parse(value);
        if (!Number.isFinite(time)) return { status: 'failed', reason: 'sleep.until must be a date', retryable: false };
        until = new Date(time).toISOString();
      } else {
        const ms = parseDuration(resolveTemplate(step.with.duration, scope, { now: this.clock() }));
        if (ms === null) return { status: 'failed', reason: 'sleep.duration must be a duration such as 10m', retryable: false };
        until = new Date(this.clock().getTime() + ms).toISOString();
      }
      position.handle = { ...handle, until };
      checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
    }
    if (this.clock().getTime() >= Date.parse(until)) return { status: 'completed', output: { sleptUntil: until } };
    return { status: 'waiting', wait: { type: 'timer', until }, wakeAt: until };
  }

  _waitUnit({ run, context, position }, step) {
    const handle = position.handle || {};
    if (handle.event) return { status: 'completed', output: handle.event };
    if (handle.timedOut) return { status: 'completed', output: { timedOut: true } };
    let deadline = handle.deadline ?? null;
    if (!handle.waiting) {
      const timeoutMs = step.with.timeout !== undefined ? parseDuration(step.with.timeout) : null;
      deadline = timeoutMs ? new Date(this.clock().getTime() + timeoutMs).toISOString() : null;
      position.handle = { ...handle, waiting: true, since: this.clock().toISOString(), deadline };
      checkpointRun(run.id, { context, position, leaseOwner: this.leaseOwner });
    }
    return { status: 'waiting', wait: { type: 'event', event: step.with.event, where: step.with.where ? conditionSource(step.with.where) : null, since: position.handle.since, deadline }, wakeAt: deadline };
  }

  // --- completion ----------------------------------------------------------------

  _finish(run, status, { outputs = null, error = null, context, position } = {}) {
    const finished = finishRun(run.id, { status, outputs, error, context, position });
    if (run.kind === 'automation') {
      if (run.instanceId) updateInstance(run.instanceId, { lastRunId: run.id, lastStatus: status, lastError: error });
      this._publish(status === 'completed' ? 'automation.completed' : 'automation.failed', finished, status === 'completed' ? {} : { reason: status === 'cancelled' ? 'cancelled' : 'run_failed' });
    }
    if (run.parentRunId) this._wakeParent(run.parentRunId, run.id);
    return finished;
  }

  _wakeParent(parentId, childId) {
    const parent = getRun(parentId);
    if (parent?.status === 'waiting' && parent.wait?.type === 'child' && parent.wait.runId === childId) wakeRun(parentId);
  }

  // --- waking waiting runs --------------------------------------------------------

  /** Timers, retry backoffs and event-wait deadlines that are due. */
  wakeDueRuns(now = this.clock()) {
    const woken = [];
    for (const run of listWaitingRuns({ dueBefore: now.toISOString() })) {
      if (run.wait?.type === 'event') {
        const position = { ...run.position, handle: { ...run.position.handle, timedOut: true } };
        if (wakeRun(run.id, { position })) woken.push(run.id);
      } else if (run.wait?.type === 'timer' || run.wait?.type === 'retry') {
        if (wakeRun(run.id)) woken.push(run.id);
      }
    }
    return woken;
  }

  /** Runs waiting on an action whose outcome is now known (approval, rejection, delivery). */
  wakeActionWaits() {
    const woken = [];
    for (const run of listWaitingRuns()) {
      if (run.wait?.type !== 'action') continue;
      if (this.invoker.actionOutcome(run.wait.capability, run.wait.actionId).status !== 'waiting' && wakeRun(run.id)) woken.push(run.id);
    }
    return woken;
  }

  /** Runs waiting on a child that already finished (e.g. resumed separately). */
  wakeChildWaits() {
    const woken = [];
    for (const run of listWaitingRuns()) {
      if (run.wait?.type !== 'child') continue;
      const child = getRun(run.wait.runId);
      if ((!child || TERMINAL_RUN_STATUSES.includes(child.status) || child.status === 'pending') && wakeRun(run.id)) woken.push(run.id);
    }
    return woken;
  }

  /** Delivers a published event to runs waiting for it. */
  deliverEvent(event) {
    const woken = [];
    for (const run of listWaitingRuns()) {
      if (run.wait?.type !== 'event' || run.wait.event !== event.type) continue;
      if (event.metadata?.workflowRunId === run.id) continue;
      if (run.wait.since && event.timestamp && event.timestamp < run.wait.since) continue;
      if (run.wait.where) {
        let matched = false;
        try { matched = truthy(evaluate(run.wait.where, { event, inputs: run.inputs }, { now: this.clock() })); } catch { matched = false; }
        if (!matched) continue;
      }
      const position = { ...run.position, handle: { ...run.position.handle, event: publicEvent(event) } };
      if (wakeRun(run.id, { position })) woken.push(run.id);
    }
    return woken;
  }

  // --- control ------------------------------------------------------------------

  /** Cancels a run and its active children; pending approvals it proposed are withdrawn. */
  cancelRun(runId, reason = 'cancelled') {
    const run = getRun(runId);
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return run;
    for (const child of listRuns({ parentRunId: runId, status: ACTIVE_RUN_STATUSES })) this.cancelRun(child.id, reason);
    const actionId = run.wait?.type === 'action' ? run.wait.actionId : null;
    if (actionId && getAgentAction(actionId)?.status === 'pending') updateAgentAction(actionId, { status: 'cancelled', result: { error: 'Workflow run cancelled' } });
    return this._finish(run, 'cancelled', { error: reason });
  }

  _publish(type, run, data = {}) {
    try {
      this.eventBus?.publish({
        type,
        source: 'automation-runtime',
        actor: { type: 'package', id: run.packageId },
        subject: { type: 'workflow_run', id: run.id },
        data: { automation: run.definitionId, package: run.packageId, runId: run.id, status: run.status, trigger: run.trigger?.type || null, ...data },
        correlationId: run.correlationId,
        metadata: { automationInstanceId: run.instanceId || null, workflowRunId: run.id, provenance: 'automation-runtime' },
      });
    } catch {
      log.error('workflow', 'Could not publish automation event', { runId: run.id });
    }
  }
}

function lastOutput(workflow, context) {
  for (let i = workflow.steps.length - 1; i >= 0; i--) {
    const entry = context[workflow.steps[i].id];
    if (entry && entry.status === 'completed') return entry.output;
  }
  return null;
}

function publicEvent(event) {
  return { id: event.id, type: event.type, timestamp: event.timestamp, source: event.source, subject: event.subject || null, data: event.data || {} };
}

function boundedError(error) {
  const message = typeof error === 'string' ? error : error?.message || 'unknown error';
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'failed', reason: message, code: 'timeout' }), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}
