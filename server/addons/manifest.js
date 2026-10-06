// The add-on manifest, `addon.yaml` (docs/addons.md, ADR 0010).
//
// An add-on is a folder that DESCRIBES what it contributes. Nothing here reads
// the filesystem or runs anything: a manifest is untrusted input, so
// validation is strict, lists every problem, and rejects unknown keys. What
// the manifest says about a tool (read-only, privacy classification) is only a
// SUGGESTED default shown to the owner; it takes effect when the owner
// confirms it in the vault's addons.yaml.
import yaml from 'js-yaml';
import { isValidRange, isValidVersion } from '../packages/semver.js';
import { RESERVED_SERVER_NAMES, TOOL_NAME } from '../mcp/config.js';

export const ADDON_API_VERSION = 'u2os/v1';
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const ADDON_ID = /^[a-z][a-z0-9_]{0,31}$/;
const SERVER_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COMMAND = /^(?:[A-Za-z0-9._+-]{1,100}|\/[^\0\n\r]{1,300}|\$\{ADDON_DIR\}\/[A-Za-z0-9_./-]{1,200})$/;
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const TOP_KEYS = new Set(['apiVersion', 'kind', 'metadata', 'requires', 'servers', 'settings', 'skills', 'routines', 'ui']);
const METADATA_KEYS = new Set(['id', 'name', 'version', 'description', 'author', 'license', 'homepage']);
const REQUIRES_KEYS = new Set(['u2os', 'platform', 'commands']);
const PLATFORMS = ['darwin', 'linux', 'win32'];
const CLASSIFICATIONS = ['public', 'personal', 'private', 'sensitive'];
const SETTING_TYPES = ['string', 'number', 'boolean'];
const MAX_TOOLS = 100;
const MAX_FIXED_BYTES = 2_000;

export class AddonManifestError extends Error {
  constructor(message, errors = []) {
    super(errors.length ? `${message}:\n- ${errors.join('\n- ')}` : message);
    this.code = 'ADDON_MANIFEST_INVALID';
    this.errors = errors;
  }
}

/** YAML text -> raw value, core schema only (no tags, no code). */
export function parseAddonYaml(text) {
  if (typeof text !== 'string') throw new AddonManifestError('addon.yaml: expected text');
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new AddonManifestError(`addon.yaml: larger than ${MAX_MANIFEST_BYTES / 1024} KiB`);
  try { return yaml.load(text, { schema: yaml.CORE_SCHEMA, json: true }) ?? {}; }
  catch (error) { throw new AddonManifestError(`addon.yaml: invalid YAML (${error.reason || error.message})`); }
}

/** A path inside the add-on folder that cannot escape it, or null. */
export function safeAddonPath(value) {
  if (typeof value !== 'string' || value.length > 256 || !SAFE_PATH.test(value)) return null;
  return value.split('/').some((segment) => segment === '..' || segment === '.' || segment.startsWith('.')) ? null : value;
}

/** Validates a parsed manifest and returns it normalized; throws AddonManifestError listing every problem. */
export function validateAddonManifest(raw) {
  const errors = [];
  if (!isMapping(raw)) throw new AddonManifestError('addon.yaml must be a mapping');
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`${key}: unknown top-level key`);
  if (raw.apiVersion !== ADDON_API_VERSION) errors.push(`apiVersion: must be ${ADDON_API_VERSION}`);
  if (raw.kind !== 'Addon') errors.push('kind: must be Addon');

  const metadata = isMapping(raw.metadata) ? raw.metadata : {};
  if (!isMapping(raw.metadata)) errors.push('metadata: is required');
  for (const key of Object.keys(metadata)) if (!METADATA_KEYS.has(key)) errors.push(`metadata.${key}: unknown key`);
  if (!ADDON_ID.test(metadata.id || '')) errors.push('metadata.id: lowercase letters, digits and "_", starting with a letter (up to 32), such as apple');
  else if (RESERVED_SERVER_NAMES.has(metadata.id)) errors.push(`metadata.id: "${metadata.id}" is reserved for built-in tools`);
  if (typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 120) errors.push('metadata.name: 1-120 characters');
  if (!isValidVersion(metadata.version)) errors.push('metadata.version: a semantic version such as 0.1.0');
  for (const key of ['description', 'author', 'license', 'homepage']) {
    if (metadata[key] !== undefined && (typeof metadata[key] !== 'string' || metadata[key].length > 1000)) errors.push(`metadata.${key}: text up to 1000 characters`);
  }

  const requires = normalizeRequires(raw.requires, errors);
  const servers = normalizeServers(raw.servers, metadata.id, errors);
  const settings = normalizeSettings(raw.settings, errors);
  const skills = normalizePathList(raw.skills, 'skills', '.md', errors);
  const routines = normalizePathList(raw.routines, 'routines', '.md', errors);
  const ui = normalizeUi(raw.ui, errors);
  if (!servers.length && !skills.length && !routines.length) errors.push('an add-on must contribute at least one of: servers, skills, routines');

  if (errors.length) throw new AddonManifestError(`Invalid add-on manifest${typeof metadata.id === 'string' ? ` for ${metadata.id.slice(0, 40)}` : ''}`, errors);
  return {
    apiVersion: ADDON_API_VERSION,
    id: metadata.id, name: metadata.name.trim(), version: metadata.version,
    description: metadata.description || '', author: metadata.author || null, license: metadata.license || null, homepage: metadata.homepage || null,
    requires, servers, settings, skills, routines, ui,
  };
}

function normalizeRequires(value, errors) {
  if (value === undefined) return { u2os: null, platform: [], commands: [] };
  if (!isMapping(value)) { errors.push('requires: must be a mapping'); return { u2os: null, platform: [], commands: [] }; }
  for (const key of Object.keys(value)) if (!REQUIRES_KEYS.has(key)) errors.push(`requires.${key}: unknown key`);
  if (value.u2os !== undefined && !isValidRange(value.u2os)) errors.push('requires.u2os: a version range such as ">=0.1.0"');
  const platform = value.platform ?? [];
  if (!Array.isArray(platform) || platform.some((p) => !PLATFORMS.includes(p))) errors.push(`requires.platform: a list of ${PLATFORMS.join(', ')}`);
  const commands = value.commands ?? [];
  if (!Array.isArray(commands) || commands.length > 20 || commands.some((c) => typeof c !== 'string' || !/^[A-Za-z0-9._+-]{1,100}$/.test(c))) errors.push('requires.commands: a list of command names that must be on PATH');
  return { u2os: value.u2os ?? null, platform: Array.isArray(platform) ? platform : [], commands: Array.isArray(commands) ? commands : [] };
}

function normalizeServers(value, addonId, errors) {
  if (value === undefined) return [];
  if (!isMapping(value)) { errors.push('servers: must be a mapping of server name to its definition'); return []; }
  const out = [];
  for (const [name, spec] of Object.entries(value)) {
    const where = `servers.${name}`;
    if (!SERVER_KEY.test(name)) { errors.push(`${where}: server names use lowercase letters, digits and "_"`); continue; }
    if (RESERVED_SERVER_NAMES.has(name)) errors.push(`${where}: this name is reserved for built-in tools`);
    // Tools are named <server>.<tool> and policies are keyed by that domain, so an
    // add-on may only use its own name as the prefix.
    if (typeof addonId === 'string' && name !== addonId && !name.startsWith(`${addonId}_`)) errors.push(`${where}: a server name must be the add-on id ("${addonId}") or start with "${addonId}_"`);
    if (!isMapping(spec)) { errors.push(`${where}: must be a mapping`); continue; }
    for (const key of Object.keys(spec)) if (!['command', 'args', 'env', 'timeout_seconds', 'tools'].includes(key)) errors.push(`${where}.${key}: unknown key`);
    if (typeof spec.command !== 'string' || !COMMAND.test(spec.command) || spec.command.split('/').includes('..')) errors.push(`${where}.command: a command name, an absolute path, or \${ADDON_DIR}/relative/path (no shell strings)`);
    if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.length > 50 || spec.args.some((a) => !['string', 'number'].includes(typeof a) || String(a).length > 500 || String(a).includes('\0')))) errors.push(`${where}.args: a list of up to 50 short strings`);
    if (spec.env !== undefined && (!isMapping(spec.env) || Object.entries(spec.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 500))) errors.push(`${where}.env: a mapping of names to short values`);
    const timeout = spec.timeout_seconds ?? 120;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 900) errors.push(`${where}.timeout_seconds: a whole number from 1 to 900`);
    const tools = normalizeTools(spec.tools, where, errors);
    out.push({ name, command: spec.command, args: (spec.args || []).map(String), env: spec.env || {}, timeoutSeconds: timeout, tools });
  }
  return out;
}

function normalizeTools(value, where, errors) {
  if (!isMapping(value) || !Object.keys(value).length) { errors.push(`${where}.tools: must list at least one tool`); return []; }
  const entries = Object.entries(value);
  if (entries.length > MAX_TOOLS) errors.push(`${where}.tools: at most ${MAX_TOOLS} tools`);
  const out = [];
  for (const [name, spec] of entries.slice(0, MAX_TOOLS)) {
    const at = `${where}.tools.${name}`;
    if (!TOOL_NAME.test(name)) { errors.push(`${at}: tool names use letters, digits, "_" or "-"`); continue; }
    const options = spec ?? {};
    if (!isMapping(options)) { errors.push(`${at}: must be a mapping`); continue; }
    for (const key of Object.keys(options)) if (!['tool', 'fixed', 'description', 'read', 'classification'].includes(key)) errors.push(`${at}.${key}: unknown key`);
    if (options.tool !== undefined && (typeof options.tool !== 'string' || !TOOL_NAME.test(options.tool))) errors.push(`${at}.tool: the remote tool name`);
    let fixed = {};
    if (options.fixed !== undefined) {
      if (!isMapping(options.fixed) || Object.keys(options.fixed).length > 10 || Object.keys(options.fixed).some((k) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k))
        || JSON.stringify(options.fixed).length > MAX_FIXED_BYTES || Object.values(options.fixed).some((v) => v !== null && typeof v === 'object')) errors.push(`${at}.fixed: a small mapping of argument names to fixed scalar values`);
      else fixed = options.fixed;
    }
    if (options.description !== undefined && (typeof options.description !== 'string' || options.description.length > 500)) errors.push(`${at}.description: up to 500 characters`);
    if (options.read !== undefined && typeof options.read !== 'boolean') errors.push(`${at}.read: true or false`);
    if (options.classification !== undefined && !CLASSIFICATIONS.includes(options.classification)) errors.push(`${at}.classification: ${CLASSIFICATIONS.join(', ')}`);
    out.push({ name, remote: options.tool || name, fixed, description: options.description || '', suggestedRead: options.read === true, suggestedClassification: options.classification || 'private' });
  }
  return out;
}

function normalizeSettings(value, errors) {
  if (value === undefined) return {};
  if (!isMapping(value)) { errors.push('settings: must be a mapping'); return {}; }
  const out = {};
  for (const [key, spec] of Object.entries(value)) {
    const at = `settings.${key}`;
    if (!SETTING_KEY.test(key)) { errors.push(`${at}: invalid setting name`); continue; }
    if (!isMapping(spec) || !SETTING_TYPES.includes(spec.type)) { errors.push(`${at}.type: ${SETTING_TYPES.join(', ')}`); continue; }
    for (const k of Object.keys(spec)) if (!['type', 'default', 'description', 'enum'].includes(k)) errors.push(`${at}.${k}: unknown key`);
    if (spec.default !== undefined && typeof spec.default !== spec.type) errors.push(`${at}.default: must be a ${spec.type}`);
    if (spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > 500)) errors.push(`${at}.description: up to 500 characters`);
    if (spec.enum !== undefined && (!Array.isArray(spec.enum) || spec.enum.length > 50 || spec.enum.some((v) => typeof v !== spec.type))) errors.push(`${at}.enum: a list of ${spec.type} values`);
    out[key] = { type: spec.type, ...(spec.default !== undefined ? { default: spec.default } : {}), description: spec.description || '', ...(spec.enum ? { enum: spec.enum } : {}) };
  }
  return out;
}

function normalizePathList(value, where, extension, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) { errors.push(`${where}: a list of up to 50 add-on-relative file paths`); return []; }
  const out = [];
  for (const item of value) {
    if (!safeAddonPath(item) || !item.endsWith(extension)) errors.push(`${where}: "${String(item).slice(0, 60)}" must be a safe relative path ending in ${extension}`);
    else out.push(item);
  }
  return out;
}

function normalizeUi(value, errors) {
  if (value === undefined) return { nav: [] };
  if (!isMapping(value)) { errors.push('ui: must be a mapping'); return { nav: [] }; }
  for (const key of Object.keys(value)) if (key !== 'nav') errors.push(`ui.${key}: unknown key`);
  const nav = value.nav ?? [];
  if (!Array.isArray(nav) || nav.length > 5) { errors.push('ui.nav: a list of up to 5 entries'); return { nav: [] }; }
  const out = [];
  nav.forEach((entry, index) => {
    const at = `ui.nav[${index}]`;
    if (!isMapping(entry)) { errors.push(`${at}: must be a mapping`); return; }
    for (const key of Object.keys(entry)) if (!['id', 'title', 'icon', 'group'].includes(key)) errors.push(`${at}.${key}: unknown key`);
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.id)) errors.push(`${at}.id: lowercase letters, digits and "-"`);
    if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 40) errors.push(`${at}.title: 1-40 characters`);
    if (entry.icon !== undefined && (typeof entry.icon !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(entry.icon))) errors.push(`${at}.icon: a Font Awesome icon name such as "envelope"`);
    if (entry.group !== undefined && (typeof entry.group !== 'string' || entry.group.length > 40)) errors.push(`${at}.group: up to 40 characters`);
    out.push({ id: entry.id, title: String(entry.title || '').trim(), icon: entry.icon || null, group: entry.group || null });
  });
  return { nav: out };
}

function isMapping(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
