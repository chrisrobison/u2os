// Semantic presentation -- Phase 5 (docs/devices.md). These are ordinary
// Tools, registered like any other (server/tools/register-all.js), which
// is what actually closes the "capability invocation isn't policy-gated
// yet" gap Phases 2-4 left open: by going through the SAME
// evaluateAndMaybeExecute() pipeline every tool call already uses, a
// presentation now gets PolicyEngine evaluation, an agent_actions audit
// row, and (per policies.yaml) an approval step, for free -- no bespoke
// authorization code needed here.
//
// Unlike every other tool in this directory, these two take a constructor
// dependency (deviceRegistry/capabilityRegistry) rather than reaching a
// module-level singleton the way server/integrations/provider-registry.js's
// getProvider() does -- because, unlike connector providers, the device
// registry is a real per-server-instance object (server/index.js
// constructs one), not something resolvable from U2OS_HOME alone. This
// mirrors how Agent/ActionExecutor/etc. already take their dependencies
// via constructor injection.
import { Tool } from './tool.js';
import { invokeCapability } from '../devices/capabilities.js';

const PRIVACY_VALUES = ['public', 'personal', 'private', 'sensitive'];

/**
 * present({ audience, privacy?, content }) -- the agent-facing "show this
 * to someone" primitive PROMPT.md's `present()` sketch describes. The
 * agent never names a device; server/devices/capability-resolver.js picks
 * one deterministically from `audience`/`privacy` alone.
 */
export class PresentationPresentTool extends Tool {
  constructor({ deviceRegistry, capabilityRegistry } = {}) {
    super();
    this.deviceRegistry = deviceRegistry;
    this.capabilityRegistry = capabilityRegistry;
  }

  get name() {
    return 'presentation.present';
  }
  get domain() {
    return 'presentation';
  }
  get category() {
    return 'consequential';
  }
  get schema() {
    return {
      type: 'object',
      properties: {
        audience: { type: 'string' },
        privacy: { type: 'string', enum: PRIVACY_VALUES },
        content: { type: 'object' },
      },
      required: ['audience', 'content'],
    };
  }

  async execute(args, context) {
    if (!this.deviceRegistry || !this.capabilityRegistry) {
      throw new Error('presentation.present: the device subsystem is not configured on this server');
    }
    const outcome = await invokeCapability(
      'ui.render',
      { content: args.content },
      { audience: args.audience, privacy: args.privacy || 'personal', correlationId: context.correlationId },
      { deviceRegistry: this.deviceRegistry, capabilityRegistry: this.capabilityRegistry, eventBus: context.eventBus }
    );
    return { device: outcome.device, delivered: true, result: outcome.result };
  }
}

/** notify({ audience, privacy?, title, body? }) -- the lighter-weight
 * sibling of present(), for a short notice rather than a full card. */
export class PresentationNotifyTool extends Tool {
  constructor({ deviceRegistry, capabilityRegistry } = {}) {
    super();
    this.deviceRegistry = deviceRegistry;
    this.capabilityRegistry = capabilityRegistry;
  }

  get name() {
    return 'presentation.notify';
  }
  get domain() {
    return 'presentation';
  }
  get category() {
    return 'consequential';
  }
  get schema() {
    return {
      type: 'object',
      properties: {
        audience: { type: 'string' },
        privacy: { type: 'string', enum: PRIVACY_VALUES },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['audience', 'title'],
    };
  }

  async execute(args, context) {
    if (!this.deviceRegistry || !this.capabilityRegistry) {
      throw new Error('presentation.notify: the device subsystem is not configured on this server');
    }
    const outcome = await invokeCapability(
      'ui.notify',
      { title: args.title, body: args.body },
      { audience: args.audience, privacy: args.privacy || 'personal', correlationId: context.correlationId },
      { deviceRegistry: this.deviceRegistry, capabilityRegistry: this.capabilityRegistry, eventBus: context.eventBus }
    );
    return { device: outcome.device, delivered: true, result: outcome.result };
  }
}
