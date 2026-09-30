// Package event rules (docs/plugin-architecture.md §10). The envelope is
// the existing EventBus envelope (docs/events.md); this module only decides
// which event types a package may emit, so a package can never spoof core
// events (a fake email.received, agent.action.completed, ...).

export const EVENT_TYPE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;

// Domains published by U2OS core. A package may subscribe to them but never
// emit them.
export const RESERVED_EVENT_DOMAINS = Object.freeze([
  'agent', 'action', 'run', 'vault', 'routine', 'automation', 'package', 'capability', 'skill', 'workflow',
  'device', 'stream', 'email', 'mail', 'calendar', 'contact', 'contacts', 'task', 'tasks', 'memory', 'commitment',
  'notification', 'user', 'system', 'goal', 'trigger', 'voice', 'connector', 'auth', 'owner', 'recommendation',
  'feedback', 'coding', 'presentation', 'message', 'subscription', 'project', 'document', 'purchase', 'location',
]);

export function isValidEventType(type) {
  return typeof type === 'string' && type.length <= 128 && EVENT_TYPE.test(type);
}

export function isReservedEventType(type) {
  return RESERVED_EVENT_DOMAINS.includes(String(type).split('.')[0]);
}

/** Returns an error message if a package may not emit `type`, else null. */
export function emitProblem(type, declaredEmits = []) {
  if (!isValidEventType(type)) return `"${type}" is not a valid event type (use lowercase dotted names such as job.candidate)`;
  if (isReservedEventType(type)) return `"${type}" uses a reserved core event domain`;
  if (!declaredEmits.includes(type)) return `"${type}" is not declared in events.emits`;
  return null;
}
