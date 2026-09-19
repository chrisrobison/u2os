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
const TOP_LEVEL_FIELDS = new Set(['title', 'layout', 'components']);
const COMPONENT_FIELDS = new Set(['type', 'source', 'data']);
const MAX_COMPONENTS = 50;
const MAX_DATA_BYTES = 100000;

export function validateDashboard(schema) {
  if (!schema || typeof schema !== 'object') {
    throw new Error('Dashboard schema must be an object');
  }
  rejectUnknown(schema, TOP_LEVEL_FIELDS, 'dashboard');
  if (typeof schema.title !== 'string' || !schema.title.trim() || schema.title.length > 200) {
    throw new Error('Dashboard title must be a non-empty string of at most 200 characters');
  }
  if (!ALLOWED_LAYOUTS.has(schema.layout)) {
    throw new Error(`Invalid dashboard layout: ${schema.layout}`);
  }
  if (!Array.isArray(schema.components)) {
    throw new Error('Dashboard schema requires a components array');
  }
  if (schema.components.length > MAX_COMPONENTS) throw new Error(`Dashboard may contain at most ${MAX_COMPONENTS} components`);
  for (const component of schema.components) {
    if (!component || !ALLOWED_COMPONENT_TYPES.has(component.type)) {
      throw new Error(`Invalid dashboard component type: ${component?.type}`);
    }
    rejectUnknown(component, COMPONENT_FIELDS, 'dashboard component');
    if (component.source !== undefined && !ALLOWED_SOURCES.has(component.source)) {
      throw new Error(`Invalid dashboard component source: ${component.source}`);
    }
    if (component.data !== undefined) {
      if (!component.data || typeof component.data !== 'object' || Array.isArray(component.data)) throw new Error('Dashboard component data must be an object');
      if (Buffer.byteLength(JSON.stringify(component.data), 'utf8') > MAX_DATA_BYTES) throw new Error('Dashboard component data is too large');
      assertSafeData(component.data, 0);
    }
  }
  return true;
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unrecognized ${label} field: ${unknown}`);
}

function assertSafeData(value, depth) {
  if (depth > 8) throw new Error('Dashboard component data is nested too deeply');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Unsafe dashboard data key: ${key}`);
    if (child && typeof child === 'object') assertSafeData(child, depth + 1);
  }
}
