// Core capabilities (docs/plugin-architecture.md §1): every existing Tool
// is registered as a capability contract under its existing id, and the
// connector manifests in skills/*/manifest.json are listed as the providers
// that can back it. Nothing is renamed and no tool changes behaviour.
//
// Execution of a core capability always goes through the Tool itself via
// Agent.evaluateAndMaybeExecute(), so connector selection stays in
// connectors.yaml (server/integrations/provider-registry.js).
import { loadSkillManifests } from '../integrations/skill-manifests.js';

export const CORE_CAPABILITY_VERSION = '1.0.0';

// Tool name -> permissions a package needs to invoke it. A tool missing here
// is not exposed to packages at all (fail closed).
export const CORE_CAPABILITY_PERMISSIONS = Object.freeze({
  'email.search': ['email.read'],
  'email.read': ['email.read'],
  'email.draft': ['email.draft'],
  'email.send': ['email.send'],
  'calendar.list': ['calendar.read'],
  'calendar.create': ['calendar.write'],
  'calendar.reschedule': ['calendar.write'],
  'contacts.search': ['contacts.read'],
  'tasks.list': ['tasks.read'],
  'tasks.create': ['tasks.write'],
  'tasks.complete': ['tasks.write'],
  'web.search': ['network'],
  'notifications.send': ['notifications.send'],
  'presentation.present': ['devices.control'],
  'presentation.notify': ['devices.control'],
});

const DESCRIPTIONS = {
  'email.search': 'Search the owner\'s mailbox.',
  'email.read': 'Read one email message.',
  'email.draft': 'Create a local email draft.',
  'email.send': 'Send an email through the configured account.',
  'calendar.list': 'List calendar events in a range.',
  'calendar.create': 'Create a calendar event.',
  'calendar.reschedule': 'Move an existing calendar event.',
  'contacts.search': 'Search contacts.',
  'tasks.list': 'List tasks.',
  'tasks.create': 'Create a task.',
  'tasks.complete': 'Complete a task.',
  'web.search': 'Search the web.',
  'notifications.send': 'Send the owner a notification.',
  'presentation.present': 'Present content on an eligible device.',
  'presentation.notify': 'Notify the owner on an eligible device.',
};

export function registerCoreCapabilities(capabilityRegistry, toolRegistry, { manifests = safeManifests() } = {}) {
  const registered = [];
  for (const tool of toolRegistry.list()) {
    const permissions = CORE_CAPABILITY_PERMISSIONS[tool.name];
    if (!permissions) continue;
    capabilityRegistry.registerContract({
      id: tool.name,
      version: CORE_CAPABILITY_VERSION,
      description: tool.description || DESCRIPTIONS[tool.name] || '',
      effect: tool.category === 'read' ? 'read' : 'write',
      domain: tool.domain,
      inputSchema: tool.schema,
      outputSchema: null,
      requiredPermissions: permissions,
      source: 'core',
    });
    capabilityRegistry.registerProvider({
      id: 'core',
      capability: tool.name,
      kind: 'tool',
      toolName: tool.name,
      description: 'Built-in tool; connector chosen in connectors.yaml',
      connectors: manifests.filter((manifest) => (manifest.provides || []).includes(tool.name)).map((manifest) => manifest.id),
    });
    registered.push(tool.name);
  }
  return registered;
}

function safeManifests() {
  try { return loadSkillManifests(); } catch { return []; }
}
