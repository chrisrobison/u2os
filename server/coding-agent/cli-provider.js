// Base class for adapters that drive an official coding CLI as a subprocess
// (docs/coding-agents.md). A concrete adapter supplies only:
//
//   defaultExecutable / versionArgs      detect
//   buildInvocation(task, options)       normalized task -> argv + stdin
//   parseLine(stream, line, state)       one output line -> display text
//   finalize({ state, result, task })    output -> summary / status / metadata
//
// Authentication is entirely the CLI's own business. This class never
// inspects credential files or environment tokens; it only learns whether
// `<executable> --version` runs.
import os from 'node:os';
import { CodingAgentProvider } from './provider.js';
import { runProcess } from './runner.js';
import { buildChildEnv } from './env.js';

const PROBE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;

export class CliCodingAgentProvider extends CodingAgentProvider {
  /**
   * @param {object} options
   * @param {() => {executable?: string|null, model?: string|null}} [options.providerConfig]
   *        live provider settings from coding-agents.yaml
   */
  constructor({ providerConfig = () => ({}) } = {}) {
    super();
    this._providerConfig = providerConfig;
    this._probeCache = new Map();
  }

  // --- to implement --------------------------------------------------------
  get defaultExecutable() { throw new Error(`${this.id}: defaultExecutable not implemented`); }
  get versionArgs() { return ['--version']; }
  /** Names of environment variables the CLI documents for locating its own config. */
  get envPassthrough() { return []; }
  buildInvocation(_task, _options) { throw new Error(`${this.id}: buildInvocation() not implemented`); }
  /** Returns text to show for a line, or null to hide it. `state` is per run. */
  parseLine(_stream, line, _state) { return line; }
  finalize({ result }) { return { summary: lastNonEmptyLine(result.stdout) }; }
  // -------------------------------------------------------------------------

  get executable() { return this._providerConfig().executable || this.defaultExecutable; }
  get model() { return this._providerConfig().model || null; }

  async probe() {
    const executable = this.executable;
    const cached = this._probeCache.get(executable);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;
    const result = await runProcess({
      executable,
      args: this.versionArgs,
      cwd: os.tmpdir(),
      env: buildChildEnv({ passthrough: this.envPassthrough }),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxCaptureBytes: 8 * 1024,
    });
    let value;
    if (result.spawnError) {
      const code = result.spawnError.code;
      value = { available: false, reason: code === 'ENOENT' ? `${executable} was not found (is it installed and on PATH?)` : code === 'EACCES' ? `${executable} is not executable` : `${executable} could not be started: ${result.spawnError.message}` };
    } else if (result.timedOut) {
      value = { available: false, reason: `${executable} ${this.versionArgs.join(' ')} did not respond` };
    } else if (result.exitCode !== 0) {
      value = { available: false, reason: `${executable} ${this.versionArgs.join(' ')} exited with ${result.exitCode ?? result.signal}` };
    } else {
      value = { available: true, version: firstLine(result.stdout) || firstLine(result.stderr) || undefined };
    }
    this._probeCache.set(executable, { at: Date.now(), value });
    return value;
  }

  async run(task, { signal, onSpawn, onOutput } = {}) {
    const invocation = await this.buildInvocation(task, { model: this.model });
    const state = {};
    const displayed = [];
    try {
      const result = await runProcess({
        executable: this.executable,
        args: invocation.args,
        cwd: task.cwd,
        env: buildChildEnv({ passthrough: [...this.envPassthrough, ...(invocation.envPassthrough || [])], extra: task.environment }),
        stdin: invocation.stdin ?? null,
        timeoutMs: task.timeoutMs,
        signal,
        onSpawn,
        onLine: (stream, line) => {
          const text = this.parseLine(stream, line, state);
          if (text === null || text === undefined) return;
          displayed.push(text);
          onOutput?.(stream, text);
        },
      });
      return this.toOutcome({ result, state, task, displayed });
    } finally {
      await invocation.cleanup?.();
    }
  }

  toOutcome({ result, state, task, displayed }) {
    const metadata = { executable: this.executable, signal: result.signal || undefined, truncated: result.stdoutTruncated || undefined };
    const base = { exitCode: result.exitCode ?? undefined, output: displayed.join('\n'), stderr: result.stderr || undefined, metadata };
    if (result.spawnError) return { ...base, status: 'failed', error: `Could not start ${this.executable}: ${result.spawnError.message}` };
    if (result.cancelled) return { ...base, status: 'cancelled', error: 'Cancelled' };
    if (result.timedOut) return { ...base, status: 'failed', error: `Timed out after ${Math.round(task.timeoutMs / 1000)}s` };
    const finished = this.finalize({ state, result, task }) || {};
    const { status: declared, metadata: extra, ...rest } = finished;
    const failed = result.exitCode !== 0;
    return {
      ...base,
      ...rest,
      metadata: { ...metadata, ...extra },
      status: declared && !failed ? declared : failed ? 'failed' : 'completed',
      error: failed ? (rest.error || `${this.executable} exited with ${result.exitCode ?? result.signal}`) : rest.error,
    };
  }
}

export function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

export function lastNonEmptyLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) || undefined;
}
