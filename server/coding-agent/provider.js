// The provider contract (docs/coding-agents.md).
//
//   detect -> translate a normalized task -> execute -> translate the output
//
// Nothing outside an adapter may know how a particular agent is invoked. The
// service and registry only ever call the methods below. Cancellation is a
// signal passed to run(); resume is not implemented yet (capabilities().resume
// is false for every adapter).

/**
 * @typedef {object} ProviderCapabilities
 * @property {string[]} filesystem  levels this agent can honour
 * @property {boolean} shell  can the agent be told not to run commands
 * @property {boolean} network  can network use be restricted
 * @property {boolean} git  can git use be restricted separately from the shell
 * @property {boolean} streaming  emits output while running
 * @property {boolean} resume  can continue an earlier run
 * @property {boolean} cancel  can be stopped mid-run
 * @property {Record<string,string>} enforcement  what each permission maps to, and what is NOT enforced
 */

export class CodingAgentProvider {
  /** Stable identifier used in configuration and run records, e.g. "codex". */
  get id() { throw new Error('CodingAgentProvider.id not implemented'); }

  /** Human-readable name. */
  get name() { throw new Error('CodingAgentProvider.name not implemented'); }

  /**
   * Is this agent callable right now? Resolves to
   * { available: boolean, version?: string, reason?: string }.
   * Must not throw: a broken install is "unavailable", not an error.
   */
  async probe() { throw new Error(`${this.id}: probe() not implemented`); }

  async available() { return (await this.probe()).available === true; }

  /** @returns {Promise<ProviderCapabilities>} */
  async capabilities() { throw new Error(`${this.id}: capabilities() not implemented`); }

  /**
   * Runs a normalized, validated task to completion.
   *
   * `task` is the output of normalizeTask() with `cwd` already resolved and
   * checked. `hooks` = { signal, onSpawn(pid), onOutput(stream, text) }.
   * Resolves to { status, exitCode?, summary?, output?, error?, metadata? }
   * with status one of completed | failed | cancelled | needs_input. The
   * promise rejects only for bugs; expected failures are a `failed` result.
   */
  async run(_task, _hooks) { throw new Error(`${this.id}: run() not implemented`); }
}
