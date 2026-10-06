// The owner-facing view of model configuration: an ordered list of
// "connections", each an API endpoint or a CLI tool. The router's native shape
// stays { providers, roles, fallback, order }; this module translates both ways
// so the model page and API never need to know the stored layout, and legacy
// single-provider configs appear as a one-item list.
import { CLI_PRESETS } from './cli-model-provider.js';
import { readEncryptedFile } from '../security/vault.js';

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CONNECTIONS = 12;
const PLANNING_TYPES = ['openai-compatible', 'anthropic', 'cli'];
const DESTINATIONS = ['local_model', 'configured_remote_model'];
const EXECUTABLE = /^(?:[A-Za-z0-9._+-]{1,100}|\/[^\0\n\r]{1,300})$/;

/** Connections as shown to the owner: never carries a key value. */
export function describeConnections(config, dataDir) {
  if (!config.providers) {
    if (!config.provider || config.provider === 'mock' || !PLANNING_TYPES.includes(config.provider)) return [];
    const { provider, baseUrl, model, timeoutMs } = config;
    return [{ id: 'default', type: provider, model, ...(baseUrl ? { baseUrl } : {}), timeoutMs, keyConfigured: Boolean(readEncryptedFile(`model-${provider}`, dataDir)?.apiKey) }];
  }
  const names = orderedPlannerNames(config);
  return names.map((id) => {
    const p = config.providers[id];
    const out = { id, type: p.type };
    for (const key of ['preset', 'model', 'baseUrl', 'timeoutMs', 'executable', 'args', 'input', 'destination']) if (p[key] !== undefined) out[key] = p[key];
    if (p.type !== 'cli') out.keyConfigured = Boolean(readEncryptedFile(`model-provider-${p.apiKeyRef || id}`, dataDir)?.apiKey);
    return out;
  });
}

function orderedPlannerNames(config) {
  const providers = config.providers || {};
  const planning = (name) => PLANNING_TYPES.includes(providers[name]?.type);
  const names = [];
  const add = (name) => { if (name && planning(name) && !names.includes(name)) names.push(name); };
  for (const name of config.order || []) add(name);
  add(config.roles?.planner); add(config.roles?.default); add(config.fallback);
  for (const name of Object.keys(providers)) add(name);
  return names;
}

/**
 * Validates an owner-submitted connection list and builds the stored router
 * config around it. `existing` is the current saved config: embedding providers
 * and non-planner roles survive. Returns { config, secrets } where secrets maps
 * a connection id to a submitted API key. Throws Error with an owner-readable
 * message.
 */
export function buildConfigFromConnections(connections, existing = {}) {
  if (!Array.isArray(connections) || connections.length === 0) throw new Error('Add at least one model connection');
  if (connections.length > MAX_CONNECTIONS) throw new Error(`At most ${MAX_CONNECTIONS} connections are supported`);
  const providers = {}; const secrets = {}; const order = [];
  for (const raw of connections) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each connection must be an object');
    const id = raw.id;
    if (typeof id !== 'string' || !NAME.test(id)) throw new Error(`Invalid connection name: ${String(id).slice(0, 40)} (use letters, digits, - and _)`);
    if (providers[id]) throw new Error(`Duplicate connection name: ${id}`);
    if (!PLANNING_TYPES.includes(raw.type)) throw new Error(`Connection ${id}: type must be one of ${PLANNING_TYPES.join(', ')}`);
    const entry = { type: raw.type };
    if (raw.destination !== undefined && raw.destination !== '') {
      if (!DESTINATIONS.includes(raw.destination)) throw new Error(`Connection ${id}: destination must be local_model or configured_remote_model`);
      entry.destination = raw.destination;
    }
    if (raw.timeoutMs !== undefined) {
      const timeout = Number(raw.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw new Error(`Connection ${id}: timeout must be 1000-600000 ms`);
      entry.timeoutMs = timeout;
    }
    if (raw.type === 'cli') {
      if (!CLI_PRESETS[raw.preset]) throw new Error(`Connection ${id}: preset must be one of ${Object.keys(CLI_PRESETS).join(', ')}`);
      entry.preset = raw.preset;
      if (typeof raw.model === 'string' && raw.model.trim()) entry.model = raw.model.trim().slice(0, 200);
      const executable = typeof raw.executable === 'string' ? raw.executable.trim() : '';
      if (executable) {
        if (!EXECUTABLE.test(executable)) throw new Error(`Connection ${id}: executable must be a command name or an absolute path`);
        entry.executable = executable;
      } else if (raw.preset === 'custom') throw new Error(`Connection ${id}: a custom command needs an executable`);
      if (raw.preset === 'custom') {
        const args = raw.args ?? [];
        if (!Array.isArray(args) || args.length > 40 || args.some((a) => typeof a !== 'string' || a.length > 500 || a.includes('\0'))) throw new Error(`Connection ${id}: args must be a list of up to 40 short strings`);
        entry.args = args;
        entry.input = raw.input === 'file' ? 'file' : 'stdin';
      }
    } else {
      if (typeof raw.model !== 'string' || !raw.model.trim()) throw new Error(`Connection ${id}: model is required`);
      entry.model = raw.model.trim();
      const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
      if (raw.type === 'openai-compatible' && !baseUrl) throw new Error(`Connection ${id}: endpoint URL is required`);
      if (baseUrl) {
        let url; try { url = new URL(baseUrl); } catch { throw new Error(`Connection ${id}: endpoint must be a valid URL`); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Connection ${id}: endpoint must use http or https`);
        if (url.username || url.password || url.search || url.hash) throw new Error(`Connection ${id}: endpoint must not contain credentials, a query or a fragment`);
        entry.baseUrl = baseUrl;
      }
      if (typeof raw.apiKey === 'string' && raw.apiKey) secrets[id] = raw.apiKey;
      else if (existing.providers?.[id]?.apiKeyRef) entry.apiKeyRef = existing.providers[id].apiKeyRef;
    }
    providers[id] = entry;
    order.push(id);
  }
  // Keep what this list does not manage: embedding providers and the roles that point at them.
  const keptProviders = Object.entries(existing.providers || {}).filter(([name, p]) => !providers[name] && String(p?.type).includes('embedding'));
  for (const [name, p] of keptProviders) providers[name] = p;
  const roles = {};
  for (const [role, name] of Object.entries(existing.roles || {})) if (role !== 'planner' && role !== 'default' && providers[name]) roles[role] = name;
  roles.planner = order[0]; roles.default = order[0];
  const config = { providers, roles, order };
  if (existing.fallback && providers[existing.fallback] && !order.includes(existing.fallback)) config.fallback = existing.fallback;
  return { config, secrets };
}
