// CodingAgentService (docs/coding-agents.md): what the rest of U2OS calls.
//
//   const run = await service.run({ provider: 'auto', cwd, task });
//
// It validates the task, resolves a provider through the registry, records
// the run, executes it through the provider, and publishes events. Callers
// never touch an adapter and never branch on a vendor.
import { normalizeTask, CodingAgentError } from './types.js';
import { resolveWorkingDirectory } from './cwd.js';
import { redact } from './redact.js';
import { gitSnapshot, changedFiles } from './git.js';
import { createRun, updateRun, getRun, listRuns, failInterruptedRuns } from './store.js';

const MAX_STORED_OUTPUT = 64 * 1024;
const MAX_SUMMARY = 2_000;
const MAX_ERROR = 2_000;
const LIVE_EVENT_LINE = 4_000;

// Lifecycle events are durable (EventBus -> events table) and carry no
// output text. Output is delivered live to subscribers and stored, redacted
// and capped, on the run record only: the append-only event log is also read
// by other parts of U2OS and must not accumulate raw agent output.
const DURABLE = new Set(['started', 'completed', 'failed', 'cancelled', 'needs_input', 'error']);

export class CodingAgentService {
  constructor({ registry, eventBus = null } = {}) {
    if (!registry) throw new Error('CodingAgentService needs a registry');
    this.registry = registry;
    this.eventBus = eventBus;
    this._active = new Map(); // run id -> AbortController
    this._listeners = new Set();
  }

  /** handler(event) receives every coding.agent.* event, including output lines. Returns unsubscribe. */
  subscribe(handler) {
    this._listeners.add(handler);
    return () => this._listeners.delete(handler);
  }

  /** Marks runs whose process is gone as failed. Call once when U2OS starts. */
  recoverInterrupted() { return failInterruptedRuns(); }

  discover() { return this.registry.discover(); }

  get(id) { return getRun(id); }
  list(filter) { return listRuns(filter); }

  /**
   * Validates, resolves and launches a run. Resolves once the run is
   * recorded and its process is being started:
   *   { run, done: Promise<run>, cancel(): boolean }
   * Validation and provider errors are thrown (CodingAgentError) before
   * anything is recorded.
   */
  async start(request = {}) {
    const { provider: providerId = 'auto', preference, requestedBy = 'owner', correlationId = null } = request;
    const task = normalizeTask(request);
    const config = this.registry.config();
    if (request.timeout === undefined && config.timeoutMs) task.timeoutMs = config.timeoutMs;
    task.cwd = resolveWorkingDirectory(task.cwd, { roots: config.roots });
    const provider = await this.registry.resolve({ provider: providerId, preference });

    const secrets = Object.values(task.environment);
    const run = createRun({ provider: provider.id, task: redact(task.task, { secrets }), cwd: task.cwd, permissions: task.permissions, requestedBy, correlationId, metadata: task.metadata });
    const controller = new AbortController();
    this._active.set(run.id, controller);
    const done = this._execute({ run, task, provider, controller, secrets, correlationId }).finally(() => this._active.delete(run.id));
    return { run, done, cancel: () => this.cancel(run.id) };
  }

  async run(request) {
    return (await this.start(request)).done;
  }

  /** Stops an active run started by this process. Returns false if it is not running here. */
  cancel(runId) {
    const controller = this._active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async _execute({ run, task, provider, controller, secrets, correlationId }) {
    const scrub = (text) => redact(text, { secrets });
    const base = { runId: run.id, provider: provider.id };
    const started = Date.now();
    let before = null;
    try {
      before = await gitSnapshot(task.cwd);
      updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
      this._publish('started', { ...base, cwd: task.cwd }, correlationId);

      const outcome = await provider.run(task, {
        signal: controller.signal,
        onSpawn: (pid) => updateRun(run.id, { pid }),
        onOutput: (stream, text) => this._publish('output', { ...base, stream, data: scrub(text).slice(0, LIVE_EVENT_LINE) }, correlationId),
      });

      const after = await gitSnapshot(task.cwd);
      const status = ['completed', 'failed', 'cancelled', 'needs_input'].includes(outcome.status) ? outcome.status : 'failed';
      const final = updateRun(run.id, {
        status,
        exitCode: outcome.exitCode,
        summary: cap(scrub(outcome.summary), MAX_SUMMARY),
        output: tail(scrub(outcome.output), MAX_STORED_OUTPUT),
        stderr: tail(scrub(outcome.stderr), MAX_STORED_OUTPUT),
        error: cap(scrub(outcome.error), MAX_ERROR),
        filesChanged: changedFiles(before, after),
        metadata: { ...run.metadata, ...outcome.metadata },
        completedAt: new Date().toISOString(),
      });
      if (final.error) this._publish('error', { ...base, message: final.error }, correlationId);
      this._publish(status, { ...base, exitCode: final.exitCode, durationMs: Date.now() - started }, correlationId);
      return final;
    } catch (error) {
      // An adapter bug or unexpected failure: record it, never leave the run "running".
      const message = cap(scrub(error?.message || String(error)), MAX_ERROR);
      const final = updateRun(run.id, { status: 'failed', error: message, completedAt: new Date().toISOString() });
      this._publish('error', { ...base, message }, correlationId);
      this._publish('failed', { ...base, durationMs: Date.now() - started }, correlationId);
      return final;
    }
  }

  _publish(kind, data, correlationId) {
    const type = `coding.agent.${kind}`;
    const event = { type, source: 'coding-agent', subject: { type: 'coding_agent_run', id: data.runId }, actor: { type: 'system', id: 'coding-agent' }, data, correlationId };
    for (const listener of [...this._listeners]) {
      try { listener(event); } catch { /* a listener must not affect the run */ }
    }
    if (this.eventBus && DURABLE.has(kind)) {
      try { this.eventBus.publish(event); } catch { /* the run record is the source of truth */ }
    }
  }
}

function cap(text, max) {
  return typeof text === 'string' && text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tail(text, max) {
  return typeof text === 'string' && text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

export { CodingAgentError };
