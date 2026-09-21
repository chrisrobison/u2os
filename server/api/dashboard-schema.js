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
  'recommendation',
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
  'recommendations.open',
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
      validateComponentData(component.type, component.data);
    }
  }
  return true;
}

function validateComponentData(type, data) {
  if (type === 'person') {
    requireString(data.name, 'person.name');
    boundedArray(data.facts, 10, 'person.facts');
    boundedArray(data.recentActivity, 10, 'person.recentActivity');
    boundedArray(data.commitments, 10, 'person.commitments');
    boundedArray(data.upcomingInteractions, 10, 'person.upcomingInteractions');
  }
  if (type === 'project') {
    requireString(data.name, 'project.name');
    boundedArray(data.openTasks, 20, 'project.openTasks');
    boundedArray(data.people, 20, 'project.people');
    boundedArray(data.deadlines, 20, 'project.deadlines');
    boundedArray(data.unresolvedDecisions, 20, 'project.unresolvedDecisions');
    boundedArray(data.relatedDocuments, 20, 'project.relatedDocuments');
  }
  if (type === 'conversation') {
    requireString(data.thread || data.person, 'conversation.thread');
    boundedArray(data.messages, 20, 'conversation.messages');
    for (const message of data.messages || []) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Dashboard conversation.messages entries must be objects');
      optionalString(message.sender, 200, 'conversation message sender');
      requireString(message.text, 'conversation message text');
      optionalString(message.at, 100, 'conversation message timestamp');
    }
    optionalString(data.summary, 2000, 'conversation.summary');
    optionalString(data.unresolvedQuestion, 1000, 'conversation.unresolvedQuestion');
    optionalString(data.nextStep, 1000, 'conversation.nextStep');
  }
  if (type === 'document') {
    requireString(data.title, 'document.title');
    optionalString(data.type, 100, 'document.type');
    optionalString(data.source, 500, 'document.source');
    optionalString(data.excerpt, 4000, 'document.excerpt');
    optionalString(data.whyRelevant, 2000, 'document.whyRelevant');
  }
  if (type === 'chart') validateChart(data);
  if (type === 'map') validateMap(data);
  if (type === 'photo-grid') validatePhotoGrid(data);
}

function validateChart(data) {
  optionalString(data.title, 200, 'chart.title');
  boundedArray(data.series, 4, 'chart.series');
  if (!data.series?.length) throw new Error('Dashboard chart.series requires at least one series');
  for (const series of data.series) {
    requireString(series.label, 'chart series label'); boundedArray(series.values, 24, 'chart series values');
    if (!series.values?.length || series.values.some((point) => !point || typeof point.label !== 'string' || point.label.length > 200 || typeof point.value !== 'number' || !Number.isFinite(point.value))) {
      throw new Error('Dashboard chart series values require bounded labels and finite numeric values');
    }
  }
}

function validateMap(data) {
  optionalString(data.title, 200, 'map.title'); boundedArray(data.locations, 50, 'map.locations');
  for (const location of data.locations || []) {
    requireString(location.label, 'map location label');
    if (typeof location.latitude !== 'number' || location.latitude < -90 || location.latitude > 90 || typeof location.longitude !== 'number' || location.longitude < -180 || location.longitude > 180) {
      throw new Error('Dashboard map locations require valid latitude and longitude');
    }
  }
}

function validatePhotoGrid(data) {
  optionalString(data.title, 200, 'photo-grid.title'); boundedArray(data.photos, 24, 'photo-grid.photos');
  for (const photo of data.photos || []) {
    if (!photo || typeof photo !== 'object' || !safeLocalImageSource(photo.src)) throw new Error('Dashboard photo-grid sources must be local media paths or bounded image data URLs');
    optionalString(photo.caption, 500, 'photo-grid caption');
    optionalString(photo.alt, 500, 'photo-grid alt text');
  }
}

function safeLocalImageSource(value) {
  return typeof value === 'string' && (value.startsWith('/media/') || value.startsWith('/api/media/') || /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value));
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`Dashboard ${label} must be a non-empty bounded string`);
}

function boundedArray(value, limit, label) {
  if (value !== undefined && (!Array.isArray(value) || value.length > limit)) throw new Error(`Dashboard ${label} must be an array of at most ${limit} items`);
}

function optionalString(value, limit, label) {
  if (value !== undefined && (typeof value !== 'string' || value.length > limit)) throw new Error(`Dashboard ${label} must be a string of at most ${limit} characters`);
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
