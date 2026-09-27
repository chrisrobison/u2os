// CapabilityInvoker (docs/plugin-architecture.md §7): the only way package
// workflows and code reach a capability.
//
//   input schema -> permission (declared ∩ granted) -> package policy
//     -> Agent.evaluateAndMaybeExecute()  (policies.yaml, audit, approval,
//        durable queue) -> provider -> output schema
//
// Nothing here executes a provider directly: package capabilities are
// registered as hidden tools so the existing gate and queue run them, and
// the queue worker re-checks package authority at execution time.
import { Tool } from '../tools/tool.js';
import { getAgentAction } from '../policy/policy-engine.js';
import { validate } from './json-schema.js';
import { checkPermissions } from './permissions.js';
import { listGrants, effectiveSettings } from './store.js';
import { getPackageSecret } from './secrets.js';

export class CapabilityInvoker {
  /**
   * gate: the Agent (evaluateAndMaybeExecute, toolRegistry, setPackageAuthority)
   */
  constructor({ registries, gate }) {
    this.registries = registries;
    this.gate = gate;
    gate.setPackageAuthority?.((action) => this.recheck(action));
  }

  /** Permission decision for `packageId` invoking `contract`. */
  permissionFor(packageId, contract) {
    const record = this.registries.packages.get(packageId);
    if (!record) return { allowed: false, required: contract.requiredPermissions, missingDeclared: [], missingGrant: [], reason: 'package is not installed' };
    if (!record.enabled) return { allowed: false, required: contract.requiredPermissions, missingDeclared: [], missingGrant: [], reason: 'package is disabled' };
    return checkPermissions({ required: contract.requiredPermissions, declared: record.manifest.permissions, granted: listGrants(packageId) });
  }

  /**
   * invoke(capabilityId, input, ctx) -> outcome
   * ctx: { packageId, automationId, skillId, workflowRunId, stepId, actionId,
   *        correlationId, policy }
   * outcome.status: completed | waiting | denied | failed
   */
  async invoke(capabilityId, input = {}, ctx = {}) {
    if (!this.registries.capabilities.has(capabilityId)) return { status: 'failed', reason: `Unknown capability ${capabilityId}`, code: 'unknown_capability' };
    const contract = this.registries.capabilities.get(capabilityId);
    const prepared = this.registries.capabilities.prepareInput(capabilityId, input ?? {});
    const inputErrors = validate(contract.inputSchema, prepared, 'input');
    if (inputErrors.length) return { status: 'failed', reason: `Invalid input for ${capabilityId}: ${inputErrors.join('; ')}`, code: 'invalid_input' };
    const provider = this.registries.capabilities.resolveProvider(capabilityId);
    if (!provider) return { status: 'failed', reason: `No provider for ${capabilityId}`, code: 'no_provider' };
    if (contract.source !== 'core') this.ensureTool(contract);

    const authority = {
      packageId: ctx.packageId,
      automationId: ctx.automationId || null,
      skillId: ctx.skillId || null,
      workflowRunId: ctx.workflowRunId || null,
      rootRunId: ctx.rootRunId || ctx.workflowRunId || null,
      stepId: ctx.stepId || null,
      capabilityId,
      providerId: provider.id,
      permission: this.permissionFor(ctx.packageId, contract),
      policy: ctx.policy || null,
    };
    const origin = ctx.automationId ? `automation ${ctx.automationId}` : ctx.skillId ? `skill ${ctx.skillId}` : 'package code';
    const outcome = await this.gate.evaluateAndMaybeExecute({
      actionId: ctx.actionId,
      tool: capabilityId,
      arguments: prepared,
      requestedBy: `package:${ctx.packageId}`,
      requestText: null,
      reasoningSummary: `${ctx.packageId} ${origin}${ctx.stepId ? `, step ${ctx.stepId}` : ''}${ctx.policy ? `, policy ${ctx.policy.name}` : ''}`,
      correlationId: ctx.correlationId || null,
      actor: { type: 'package', id: ctx.packageId },
      modelIdentity: 'none (deterministic package workflow)',
      authority,
    });
    return this.mapOutcome(contract, outcome);
  }

  /** Current outcome of an action proposed earlier (resume after restart/approval). */
  actionOutcome(capabilityId, actionId) {
    const action = getAgentAction(actionId);
    if (!action) return { status: 'failed', reason: 'The proposed action record is missing', actionId };
    const contract = this.registries.capabilities.has(capabilityId) ? this.registries.capabilities.get(capabilityId) : null;
    return this.mapOutcome(contract, { id: action.id, status: action.status, result: action.result, error: action.result?.error, reason: action.result?.error });
  }

  mapOutcome(contract, outcome) {
    const actionId = outcome?.id || null;
    switch (outcome?.status) {
      case 'executed': {
        const output = outcome.result ?? null;
        const errors = contract?.outputSchema ? validate(contract.outputSchema, output, 'output') : [];
        if (errors.length) return { status: 'failed', actionId, reason: `Invalid output from ${contract.id}: ${errors.join('; ')}`, code: 'invalid_output' };
        return { status: 'completed', actionId, output };
      }
      case 'rejected': return { status: 'denied', actionId, reason: 'The owner rejected this action', code: 'rejected' };
      case 'blocked': case 'cancelled': return { status: 'denied', actionId, reason: outcome.reason || outcome.error || 'Blocked by policy', code: 'blocked' };
      case 'failed': case 'dead_letter': return { status: 'failed', actionId, reason: outcome.error || outcome.reason || 'Action failed', code: 'action_failed' };
      default: return { status: 'waiting', actionId, reason: outcome?.reason || 'Waiting for approval or delivery' };
    }
  }

  /**
   * Execution-time re-check installed into the action queue worker. Returns
   * a reason string to stop the action, or null to allow it.
   */
  recheck(action) {
    const context = action.packageContext;
    const record = this.registries.packages.get(context.package);
    if (!record) return `Package ${context.package} is no longer installed`;
    if (!record.enabled) return `Package ${context.package} is disabled`;
    if (!this.registries.capabilities.has(action.tool)) return `Capability ${action.tool} is no longer available`;
    const permission = this.permissionFor(context.package, this.registries.capabilities.get(action.tool));
    if (!permission.allowed) return `Package ${context.package} no longer holds ${[...permission.missingDeclared, ...permission.missingGrant].join(', ') || 'the required permission'}`;
    return null;
  }

  /** Registers package contracts as hidden tools; removes stale ones. */
  syncTools() {
    const registry = this.gate.toolRegistry;
    for (const contract of this.registries.capabilities.list()) if (contract.source !== 'core') this.ensureTool(contract);
    for (const name of registry.hiddenNames()) {
      if (!this.registries.capabilities.has(name)) registry.unregister(name);
    }
  }

  ensureTool(contract) {
    const registry = this.gate.toolRegistry;
    if (registry.has(contract.id)) {
      if (!registry.isHidden(contract.id)) throw new Error(`Capability ${contract.id} collides with a core tool`);
      return;
    }
    registry.register(new PackageCapabilityTool(contract.id, this.registries), { hidden: true });
  }

  /**
   * The narrow context a `module` provider or skill receives: its own
   * package's settings, its declared secrets, and permission-checked
   * invocation of other capabilities attributed to its package.
   */
  providerContext(packageId, { parent = {} } = {}) {
    const record = () => this.registries.packages.get(packageId);
    return Object.freeze({
      packageId,
      get settings() { const r = record(); return r ? effectiveSettings(r.manifest) : {}; },
      getSecret: (name) => { const r = record(); if (!r) throw new Error('Package is not installed'); return getPackageSecret(r.manifest, name); },
      invoke: async (capabilityId, input) => {
        const outcome = await this.invoke(capabilityId, input, { ...parent, packageId, actionId: undefined });
        if (outcome.status !== 'completed') {
          const error = new Error(`${capabilityId} did not complete: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
          error.code = `CAPABILITY_${outcome.status.toUpperCase()}`;
          throw error;
        }
        return outcome.output;
      },
    });
  }
}

/**
 * Hidden Tool adapter for a package capability contract. The gate and queue
 * call execute(); it dispatches to whichever provider is selected now.
 */
export class PackageCapabilityTool extends Tool {
  constructor(capabilityId, registries) {
    super();
    this._id = capabilityId;
    this._registries = registries;
  }
  get _contract() { return this._registries.capabilities.get(this._id); }
  get name() { return this._id; }
  get domain() { return this._contract.domain; }
  get category() { return this._contract.effect === 'read' ? 'read' : 'consequential'; }
  get schema() { return this._contract.inputSchema; }
  get description() { return this._contract.description; }
  async execute(args, context = {}) {
    const provider = this._registries.capabilities.resolveProvider(this._id);
    if (!provider?.execute) throw new Error(`No executable provider for ${this._id}`);
    return provider.execute(args, { idempotencyKey: context.idempotencyKey || null, correlationId: context.correlationId || null });
  }
}
