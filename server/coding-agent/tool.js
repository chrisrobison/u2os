// The gated entry point (docs/coding-agents.md#gate). Anything that acts for
// the owner without the owner typing the command -- a package, a routine, a
// trigger -- reaches a coding agent only through this tool, so it passes the
// same policy, approval, queue and audit path as every other consequential
// action:
//
//   Agent.evaluateAndMaybeExecute -> policies.yaml `coding.agent`
//     (confirm unless the owner says otherwise) -> action queue -> execute()
//
// The tool is HIDDEN: the planner never sees it and plan validation refuses
// it, so a model cannot start a coding agent by proposing a plan.
import { Tool } from '../tools/tool.js';
import { CAPABILITY_ID, FILESYSTEM_LEVELS, DEFAULT_PERMISSIONS } from './types.js';

export const CODING_AGENT_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['task', 'cwd'],
  properties: {
    task: { type: 'string', description: 'What the coding agent should do.' },
    cwd: { type: 'string', description: 'Absolute path of the project directory.' },
    provider: { type: 'string', default: 'auto', description: '"auto" (configured preference) or a provider id such as codex.' },
    preference: { type: 'array', items: { type: 'string' }, description: 'Provider ids to try in order, instead of the configured order.' },
    permissions: {
      type: 'object',
      properties: {
        filesystem: { type: 'string', enum: [...FILESYSTEM_LEVELS], default: DEFAULT_PERMISSIONS.filesystem },
        shell: { type: 'boolean', default: DEFAULT_PERMISSIONS.shell },
        network: { type: 'boolean', default: DEFAULT_PERMISSIONS.network },
        git: { type: 'boolean', default: DEFAULT_PERMISSIONS.git },
      },
    },
    timeout: { type: 'integer', description: 'Milliseconds before the run is stopped.' },
  },
});

export class CodingAgentTool extends Tool {
  constructor({ service }) {
    super();
    this._service = service;
  }
  get name() { return CAPABILITY_ID; }
  get domain() { return 'coding'; }
  get category() { return 'consequential'; }
  get description() { return 'Delegate a software-engineering task to an installed coding agent (Codex, Claude Code) working in a project directory.'; }
  get schema() { return CODING_AGENT_INPUT_SCHEMA; }

  async execute(args, context = {}) {
    const actor = context.actor ? `${context.actor.type}:${context.actor.id}` : 'unknown';
    // Only the declared fields: a caller cannot add environment variables or
    // metadata that the capability's schema does not offer.
    const { task, cwd, provider, preference, permissions, timeout } = args;
    const run = await this._service.run({ task, cwd, provider, preference, permissions, timeout, requestedBy: actor, correlationId: context.correlationId || null });
    return {
      runId: run.id,
      provider: run.provider,
      status: run.status,
      exitCode: run.exitCode ?? null,
      summary: run.summary ?? null,
      filesChanged: run.filesChanged ?? null,
      error: run.error ?? null,
    };
  }
}

/**
 * Registers `coding.agent` as a hidden gated tool and as a core capability
 * contract, so packages can depend on the capability without naming a vendor.
 */
export function registerCodingAgentCapability({ capabilityRegistry, toolRegistry, service }) {
  if (!toolRegistry.has(CAPABILITY_ID)) toolRegistry.register(new CodingAgentTool({ service }), { hidden: true });
  capabilityRegistry.registerContract({
    id: CAPABILITY_ID,
    version: '1.0.0',
    description: 'Delegate a software-engineering task to an installed coding agent.',
    effect: 'write',
    domain: 'coding',
    inputSchema: CODING_AGENT_INPUT_SCHEMA,
    outputSchema: null,
    // A coding agent can run commands in the project, so it needs the same
    // (sensitive) grant as any other shell use.
    requiredPermissions: ['shell.execute'],
    source: 'core',
  });
  capabilityRegistry.registerProvider({
    id: 'core',
    capability: CAPABILITY_ID,
    kind: 'tool',
    toolName: CAPABILITY_ID,
    description: 'Official coding CLIs, chosen by preference in coding-agents.yaml',
    connectors: service.registry.list().map((provider) => provider.id),
  });
}
