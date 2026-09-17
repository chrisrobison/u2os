// Allowlists per docs/dashboards.md. No dashboard schema reaches an HTTP
// response without passing validateDashboard() -- this is a hard security
// boundary (the LLM never emits HTML/JS, only this JSON shape).
const ALLOWED_LAYOUTS = new Set(['dashboard']);

const ALLOWED_COMPONENT_TYPES = new Set([
  // Phase 1 functional components
  'schedule',
  'task-list',
  'email-summary',
  'approval',
  'activity',
  'alert',
  // Reserved for Phase 2+ (allowed, but render only as a placeholder today)
  'person',
  'project',
  'photo-grid',
  'document',
  'map',
  'chart',
  'conversation',
  'agent-status',
]);

const ALLOWED_SOURCES = new Set([
  'calendar.today',
  'calendar.upcoming',
  'tasks.priority',
  'tasks.all',
  'email.important',
  'email.unread',
  'actions.pending',
  'events.recent',
]);

export function validateDashboard(schema) {
  if (!schema || typeof schema !== 'object') {
    throw new Error('Dashboard schema must be an object');
  }
  if (!ALLOWED_LAYOUTS.has(schema.layout)) {
    throw new Error(`Invalid dashboard layout: ${schema.layout}`);
  }
  if (!Array.isArray(schema.components)) {
    throw new Error('Dashboard schema requires a components array');
  }
  for (const component of schema.components) {
    if (!component || !ALLOWED_COMPONENT_TYPES.has(component.type)) {
      throw new Error(`Invalid dashboard component type: ${component?.type}`);
    }
    if (component.source !== undefined && !ALLOWED_SOURCES.has(component.source)) {
      throw new Error(`Invalid dashboard component source: ${component.source}`);
    }
  }
  return true;
}
