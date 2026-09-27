// u2os.yaml manifests and the capability/skill/automation definition files
// they export (docs/plugin-architecture.md §5). Pure validation: nothing
// here touches the filesystem or executes package content.
//
// Packages are untrusted input: validation is strict, lists every problem,
// and rejects unknown keys instead of ignoring them.
import yaml from 'js-yaml';
import { CAPABILITY_ID, LOCAL_ID, PACKAGE_ID } from './ids.js';
import { checkSchema, isPlainObject, validate as validateSchema } from './json-schema.js';
import { isValidRange, isValidVersion } from './semver.js';
import { normalizePermissions, isKnownPermission } from './permissions.js';
import { validatePolicies } from './policy.js';
import { emitProblem, isValidEventType } from './events.js';
import { validateWorkflow } from './workflow.js';
import { checkTemplate } from './expression.js';
import { defaultTriggerRegistry } from './triggers.js';

export const API_VERSION = 'u2os/v1';
export const MAX_DEFINITION_BYTES = 256 * 1024;
const TOP_KEYS = new Set(['apiVersion', 'kind', 'metadata', 'requires', 'exports', 'permissions', 'policies', 'settings', 'secrets', 'events', 'ui']);
const METADATA_KEYS = new Set(['id', 'name', 'version', 'description', 'author', 'license', 'homepage']);
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SECRET_NAME = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export class ManifestError extends Error {
  constructor(message, errors) {
    super(errors?.length ? `${message}:\n- ${errors.join('\n- ')}` : message);
    this.code = 'MANIFEST_INVALID';
    this.errors = errors || [];
  }
}

/** Parses YAML with the core schema (no custom tags, no code). */
export function parseYaml(text, where = 'document') {
  if (typeof text !== 'string') throw new ManifestError(`${where}: expected text`);
  if (Buffer.byteLength(text) > MAX_DEFINITION_BYTES) throw new ManifestError(`${where}: larger than ${MAX_DEFINITION_BYTES / 1024} KiB`);
  try {
    return yaml.load(text, { schema: yaml.CORE_SCHEMA, json: true }) ?? {};
  } catch (error) {
    throw new ManifestError(`${where}: invalid YAML (${error.reason || error.message})`);
  }
}

/**
 * A package-relative path that cannot escape the package: no absolute paths,
 * no "..", no hidden segments, no backslashes. Returns null when unsafe.
 */
export function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length > 256 || !SAFE_PATH.test(value)) return null;
  if (value.split('/').some((segment) => segment === '..' || segment === '.' || segment.startsWith('.'))) return null;
  return value;
}

/**
 * validateManifest(raw) -> normalized manifest; throws ManifestError listing
 * every problem.
 */
export function validateManifest(raw) {
  const errors = [];
  if (!isPlainObject(raw)) throw new ManifestError('u2os.yaml must be a mapping');
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`${key}: unknown top-level key`);
  if (raw.apiVersion !== API_VERSION) errors.push(`apiVersion: must be ${API_VERSION}`);
  if (raw.kind !== 'Package') errors.push('kind: must be Package');

  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};
  if (!isPlainObject(raw.metadata)) errors.push('metadata: is required');
  for (const key of Object.keys(metadata)) if (!METADATA_KEYS.has(key)) errors.push(`metadata.${key}: unknown key`);
  if (!PACKAGE_ID.test(metadata.id || '')) errors.push('metadata.id: a reverse-DNS id such as com.example.my-package');
  if (typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 120) errors.push('metadata.name: 1-120 characters');
  if (!isValidVersion(metadata.version)) errors.push('metadata.version: a semantic version such as 0.1.0');
  for (const key of ['description', 'author', 'license', 'homepage']) {
    if (metadata[key] !== undefined && (typeof metadata[key] !== 'string' || metadata[key].length > 1000)) errors.push(`metadata.${key}: text up to 1000 characters`);
  }

  const requires = normalizeRequires(raw.requires, errors);
  const exports = normalizeExports(raw.exports, errors);
  const { permissions, errors: permissionErrors } = normalizePermissions(raw.permissions);
  errors.push(...permissionErrors);
  validatePolicies(raw.policies, errors);
  const settings = normalizeSettings(raw.settings, errors);

  const secrets = raw.secrets === undefined ? [] : raw.secrets;
  if (!Array.isArray(secrets) || secrets.some((name) => typeof name !== 'string' || !SECRET_NAME.test(name))) {
    errors.push('secrets: a list of secret names such as gmail.oauth (names only, never values)');
  }

  const events = isPlainObject(raw.events) ? raw.events : {};
  if (raw.events !== undefined && !isPlainObject(raw.events)) errors.push('events: must be a mapping');
  for (const key of Object.keys(events)) if (key !== 'emits' && key !== 'subscribes') errors.push(`events.${key}: unknown key`);
  const emits = events.emits === undefined ? [] : events.emits;
  if (!Array.isArray(emits)) errors.push('events.emits: must be a list of event types');
  else for (const type of emits) {
    const problem = emitProblem(type, emits);
    if (problem) errors.push(`events.emits: ${problem}`);
  }
  const subscribes = events.subscribes === undefined ? [] : events.subscribes;
  if (!Array.isArray(subscribes) || subscribes.some((type) => !isValidEventType(type))) errors.push('events.subscribes: must be a list of event types');

  const ui = raw.ui === undefined ? {} : raw.ui;
  if (!isPlainObject(ui)) errors.push('ui: must be a mapping');
  else for (const [key, value] of Object.entries(ui)) {
    if (key !== 'dashboard') errors.push(`ui.${key}: unknown key`);
    else if (!safeRelativePath(value)) errors.push('ui.dashboard: a package-relative path');
  }

  if (errors.length) throw new ManifestError(`Invalid manifest${metadata.id ? ` for ${metadata.id}` : ''}`, errors);
  return {
    apiVersion: API_VERSION,
    id: metadata.id,
    name: metadata.name.trim(),
    version: metadata.version,
    description: metadata.description || '',
    author: metadata.author || null,
    license: metadata.license || null,
    homepage: metadata.homepage || null,
    requires,
    exports,
    permissions,
    policies: raw.policies || {},
    settings,
    secrets,
    events: { emits, subscribes },
    ui,
  };
}

function normalizeRequires(requires, errors) {
  const result = { u2os: null, capabilities: {}, skills: {} };
  if (requires === undefined) return result;
  if (!isPlainObject(requires)) { errors.push('requires: must be a mapping'); return result; }
  for (const key of Object.keys(requires)) if (!['u2os', 'capabilities', 'skills'].includes(key)) errors.push(`requires.${key}: unknown key`);
  if (requires.u2os !== undefined) {
    if (!isValidRange(requires.u2os)) errors.push('requires.u2os: a version range such as ">=0.1.0"');
    else result.u2os = String(requires.u2os);
  }
  for (const [kind, pattern] of [['capabilities', CAPABILITY_ID], ['skills', LOCAL_ID]]) {
    const value = requires[kind];
    if (value === undefined) continue;
    const entries = Array.isArray(value) ? value.map((id) => [id, '*']) : isPlainObject(value) ? Object.entries(value) : null;
    if (!entries) { errors.push(`requires.${kind}: a list of ids or a map of id to version range`); continue; }
    for (const [id, range] of entries) {
      if (typeof id !== 'string' || !pattern.test(id)) errors.push(`requires.${kind}: invalid id "${id}"`);
      else if (!isValidRange(range)) errors.push(`requires.${kind}.${id}: invalid version range "${range}"`);
      else result[kind][id] = String(range);
    }
  }
  return result;
}

function normalizeExports(exports, errors) {
  const result = { capabilities: [], skills: [], automations: [] };
  if (exports === undefined) return result;
  if (!isPlainObject(exports)) { errors.push('exports: must be a mapping'); return result; }
  for (const key of Object.keys(exports)) if (!(key in result)) errors.push(`exports.${key}: unknown key`);
  for (const kind of Object.keys(result)) {
    const list = exports[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { errors.push(`exports.${kind}: must be a list`); continue; }
    const seen = new Set();
    list.forEach((entry, index) => {
      const where = `exports.${kind}[${index}]`;
      if (!isPlainObject(entry)) { errors.push(`${where}: must be { id, file }`); return; }
      for (const key of Object.keys(entry)) if (!['id', 'file', 'entrypoint'].includes(key)) errors.push(`${where}.${key}: unknown key`);
      const pattern = kind === 'capabilities' ? CAPABILITY_ID : LOCAL_ID;
      if (typeof entry.id !== 'string' || !pattern.test(entry.id)) errors.push(`${where}.id: invalid id`);
      else if (seen.has(entry.id)) errors.push(`${where}.id: duplicate "${entry.id}"`);
      else seen.add(entry.id);
      const file = safeRelativePath(entry.file ?? entry.entrypoint);
      if (!file || !/\.ya?ml$/.test(file)) errors.push(`${where}.file: a package-relative .yaml path`);
      result[kind].push({ id: entry.id, file });
    });
  }
  return result;
}

const SETTING_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function normalizeSettings(settings, errors) {
  if (settings === undefined) return {};
  if (!isPlainObject(settings)) { errors.push('settings: must be a mapping'); return {}; }
  for (const [key, schema] of Object.entries(settings)) {
    const where = `settings.${key}`;
    if (!SETTING_KEY.test(key)) errors.push(`${where}: invalid setting name`);
    if (!isPlainObject(schema) || !SETTING_TYPES.has(schema.type)) { errors.push(`${where}.type: one of ${[...SETTING_TYPES].join(', ')} (store credentials under secrets)`); continue; }
    checkSchema(schema, where, 0, errors);
    if (schema.default !== undefined) errors.push(...validateSchema(schema, schema.default, `${where}.default`));
  }
  return settings;
}

// --- definition files ----------------------------------------------------

const CAPABILITY_KEYS = new Set(['id', 'version', 'description', 'effect', 'implements', 'permissions', 'inputSchema', 'outputSchema', 'implementation']);
const IMPLEMENTATION_TYPES = new Set(['fixture', 'static', 'module']);

/** Validates capabilities/*.yaml. Returns the normalized definition. */
export function validateCapabilityDefinition(raw, { id, version, where = `capability ${id}` }) {
  const errors = [];
  if (!isPlainObject(raw)) throw new ManifestError(`${where}: must be a mapping`);
  for (const key of Object.keys(raw)) if (!CAPABILITY_KEYS.has(key)) errors.push(`${where}.${key}: unknown key`);
  if (raw.id !== id) errors.push(`${where}.id: must match the exported id "${id}"`);
  const defVersion = raw.version ?? version;
  if (!isValidVersion(defVersion)) errors.push(`${where}.version: a semantic version`);
  if (raw.effect !== undefined && raw.effect !== 'read' && raw.effect !== 'write') errors.push(`${where}.effect: read or write`);
  if (raw.implements !== undefined && !CAPABILITY_ID.test(raw.implements)) errors.push(`${where}.implements: a capability id`);
  const permissions = raw.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some((perm) => typeof perm !== 'string' || !isKnownPermission(perm))) {
    errors.push(`${where}.permissions: a list of known permissions such as network or email.send`);
  }
  for (const key of ['inputSchema', 'outputSchema']) if (raw[key] !== undefined) checkSchema(raw[key], `${where}.${key}`, 0, errors);
  const implementation = normalizeImplementation(raw.implementation, where, errors, { allowData: true });
  if (errors.length) throw new ManifestError(`Invalid capability ${id}`, errors);
  return {
    id,
    version: defVersion,
    description: raw.description || '',
    effect: raw.effect || 'write',
    implements: raw.implements || null,
    requiredPermissions: [...new Set(permissions)].sort(),
    inputSchema: raw.inputSchema || { type: 'object' },
    outputSchema: raw.outputSchema || null,
    implementation,
  };
}

function normalizeImplementation(implementation, where, errors, { allowData }) {
  if (!isPlainObject(implementation)) { errors.push(`${where}.implementation: must be a mapping with a type`); return null; }
  const type = implementation.type;
  const allowed = allowData ? IMPLEMENTATION_TYPES : new Set(['module']);
  if (!allowed.has(type)) { errors.push(`${where}.implementation.type: one of ${[...allowed].join(', ')}`); return null; }
  const keys = { fixture: ['type', 'file', 'output'], static: ['type', 'output'], module: ['type', 'module', 'export'] }[type];
  for (const key of Object.keys(implementation)) if (!keys.includes(key)) errors.push(`${where}.implementation.${key}: unknown key for ${type}`);
  if (type === 'fixture') {
    const file = safeRelativePath(implementation.file);
    if (!file || !file.endsWith('.json')) errors.push(`${where}.implementation.file: a package-relative .json path`);
    if (implementation.output !== undefined) checkTemplate(implementation.output, `${where}.implementation.output`, errors);
    return { type, file, output: implementation.output ?? '{{ data }}' };
  }
  if (type === 'static') {
    if (implementation.output === undefined) errors.push(`${where}.implementation.output: is required for static implementations`);
    else checkTemplate(implementation.output, `${where}.implementation.output`, errors);
    return { type, output: implementation.output };
  }
  const module = safeRelativePath(implementation.module);
  if (!module || !/^src\/.+\.m?js$/.test(module)) errors.push(`${where}.implementation.module: a .js file under src/`);
  const exportName = implementation.export ?? 'default';
  if (typeof exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) errors.push(`${where}.implementation.export: an export name`);
  return { type, module, export: exportName };
}

const SKILL_KEYS = new Set(['id', 'version', 'description', 'inputSchema', 'outputSchema', 'requires', 'workflow', 'inputs', 'steps', 'output', 'implementation']);

/**
 * Validates skills/*.yaml. `loadWorkflow(path)` returns the parsed workflow
 * document when the skill references one by path.
 */
export function validateSkillDefinition(raw, { id, version, policies = [], emits = [], loadWorkflow, where = `skill ${id}` }) {
  const errors = [];
  if (!isPlainObject(raw)) throw new ManifestError(`${where}: must be a mapping`);
  for (const key of Object.keys(raw)) if (!SKILL_KEYS.has(key)) errors.push(`${where}.${key}: unknown key`);
  if (raw.id !== id) errors.push(`${where}.id: must match the exported id "${id}"`);
  const defVersion = raw.version ?? version;
  if (!isValidVersion(defVersion)) errors.push(`${where}.version: a semantic version`);
  for (const key of ['inputSchema', 'outputSchema']) if (raw[key] !== undefined) checkSchema(raw[key], `${where}.${key}`, 0, errors);
  const requires = normalizeRequires(raw.requires, errors);
  const forms = [raw.steps !== undefined, raw.workflow !== undefined, raw.implementation !== undefined].filter(Boolean).length;
  if (forms !== 1) errors.push(`${where}: define exactly one of steps, workflow or implementation`);
  let workflow = null;
  let implementation = null;
  if (raw.implementation !== undefined) implementation = normalizeImplementation(raw.implementation, where, errors, { allowData: false });
  else {
    workflow = resolveWorkflow(raw, { loadWorkflow, where, errors });
    if (workflow) errors.push(...validateWorkflow(workflow, { kind: 'skill', policies, emits, where: `${where}.workflow` }));
  }
  if (errors.length) throw new ManifestError(`Invalid skill ${id}`, errors);
  return {
    id,
    version: defVersion,
    description: raw.description || '',
    inputSchema: raw.inputSchema || { type: 'object' },
    outputSchema: raw.outputSchema || null,
    requires,
    workflow,
    implementation,
  };
}

const AUTOMATION_KEYS = new Set(['id', 'name', 'description', 'triggers', 'trigger', 'state', 'workflow', 'inputs', 'steps', 'output', 'concurrency']);

export function validateAutomationDefinition(raw, { id, policies = [], emits = [], loadWorkflow, triggerRegistry = defaultTriggerRegistry, where = `automation ${id}` }) {
  const errors = [];
  if (!isPlainObject(raw)) throw new ManifestError(`${where}: must be a mapping`);
  for (const key of Object.keys(raw)) if (!AUTOMATION_KEYS.has(key)) errors.push(`${where}.${key}: unknown key`);
  if (raw.id !== id) errors.push(`${where}.id: must match the exported id "${id}"`);
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 120)) errors.push(`${where}.name: up to 120 characters`);
  if (raw.trigger !== undefined && raw.triggers !== undefined) errors.push(`${where}: use trigger or triggers, not both`);
  const triggers = raw.triggers ?? (raw.trigger !== undefined ? [raw.trigger] : [{ type: 'manual' }]);
  if (!Array.isArray(triggers) || !triggers.length) errors.push(`${where}.triggers: a non-empty list`);
  else triggers.forEach((trigger, index) => errors.push(...triggerRegistry.validate(trigger, `${where}.triggers[${index}]`)));
  const state = raw.state === undefined ? {} : raw.state;
  if (!isPlainObject(state)) errors.push(`${where}.state: must be { schema, initial }`);
  else {
    for (const key of Object.keys(state)) if (key !== 'schema' && key !== 'initial') errors.push(`${where}.state.${key}: unknown key`);
    if (state.schema !== undefined) checkSchema(state.schema, `${where}.state.schema`, 0, errors);
    if (state.initial !== undefined && !isPlainObject(state.initial)) errors.push(`${where}.state.initial: must be a mapping`);
    if (state.schema && state.initial) errors.push(...validateSchema(state.schema, state.initial, `${where}.state.initial`));
  }
  if (raw.concurrency !== undefined && raw.concurrency !== 'single' && raw.concurrency !== 'parallel') errors.push(`${where}.concurrency: single or parallel`);
  const workflow = resolveWorkflow(raw, { loadWorkflow, where, errors, required: true });
  if (workflow) errors.push(...validateWorkflow(workflow, { kind: 'automation', policies, emits, where: `${where}.workflow` }));
  if (errors.length) throw new ManifestError(`Invalid automation ${id}`, errors);
  return {
    id,
    name: raw.name || id,
    description: raw.description || '',
    triggers: Array.isArray(triggers) ? triggers : [],
    state: { schema: state.schema || null, initial: state.initial || {} },
    concurrency: raw.concurrency || 'single',
    workflow,
  };
}

function resolveWorkflow(raw, { loadWorkflow, where, errors, required = false }) {
  if (raw.workflow !== undefined) {
    if (raw.steps !== undefined) { errors.push(`${where}: use workflow or inline steps, not both`); return null; }
    const file = safeRelativePath(raw.workflow);
    if (!file || !/\.ya?ml$/.test(file)) { errors.push(`${where}.workflow: a package-relative .yaml path`); return null; }
    if (!loadWorkflow) { errors.push(`${where}.workflow: workflow files cannot be loaded here`); return null; }
    try { return loadWorkflow(file); } catch (error) { errors.push(`${where}.workflow: ${error.message}`); return null; }
  }
  if (raw.steps !== undefined) {
    const workflow = { steps: raw.steps };
    if (raw.inputs !== undefined) workflow.inputs = raw.inputs;
    if (raw.output !== undefined) workflow.output = raw.output;
    return workflow;
  }
  if (required) errors.push(`${where}: needs a workflow file or inline steps`);
  return null;
}
