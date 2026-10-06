import { sendJson } from '../router.js';
import { describeAddons, discoverAddons } from '../../addons/registry.js';
import { ADDON_ID } from '../../addons/manifest.js';
import { updateAddonDecisions } from '../../addons/decisions.js';

const CLASSIFICATIONS = ['public', 'personal', 'private', 'sensitive'];

// Owner-only API over the add-on registry and the owner's decisions in the
// vault's addons.yaml (docs/addons.md). `onChanged({ id, enabledChanged })`
// lets the runtime start or stop an add-on's tools after a decision changes.
export function registerAddonRoutes(router, { onChanged } = {}) {
  router.get('/api/addons', async (_req, res) => sendJson(res, 200, describeAddons()));

  router.put('/api/addons/:id', async (req, res) => {
    const id = req.params?.id;
    if (!ADDON_ID.test(id || '')) return sendJson(res, 400, { error: 'Invalid add-on id' });
    const entry = discoverAddons().find((candidate) => candidate.id === id);
    if (!entry?.manifest) return sendJson(res, 404, { error: 'No add-on with that id, or its manifest is invalid' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Expected an object' });
    for (const key of Object.keys(body)) if (!['enabled', 'settings', 'confirmTools', 'unconfirmTools'].includes(key)) return sendJson(res, 400, { error: `Unknown field: ${key}` });
    const manifest = entry.manifest;
    const toolNames = new Set(manifest.servers.flatMap((server) => server.tools.map((tool) => tool.name)));
    let settings;
    try {
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false');
      if (body.enabled === true && entry.state !== 'available') throw Object.assign(new Error(`This add-on cannot be enabled here: ${entry.problems.join('; ') || entry.state}`), { status: 409 });
      if (body.settings !== undefined) settings = checkSettings(body.settings, manifest.settings);
      if (body.confirmTools !== undefined) checkConfirmations(body.confirmTools, toolNames);
      if (body.unconfirmTools !== undefined && (!Array.isArray(body.unconfirmTools) || body.unconfirmTools.some((name) => !toolNames.has(name)))) throw new Error('unconfirmTools must list this add-on\'s tool names');
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message });
    }
    const before = describeAddons().addons.find((a) => a.id === id);
    try {
      updateAddonDecisions((addons) => {
        const current = addons[id] || { enabled: false, settings: {}, tools: {} };
        if (body.enabled !== undefined) current.enabled = body.enabled;
        if (settings) current.settings = { ...current.settings, ...settings };
        for (const [name, decision] of Object.entries(body.confirmTools || {})) current.tools[name] = { read: decision.read === true, classification: decision.classification };
        for (const name of body.unconfirmTools || []) delete current.tools[name];
        addons[id] = current;
      });
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.message });
    }
    const after = describeAddons().addons.find((a) => a.id === id);
    let applyError = null;
    try { await onChanged?.({ id, enabledChanged: before?.enabled !== after?.enabled, addon: after }); }
    catch (error) { applyError = 'The decision was saved, but the add-on could not be applied; see the server log.'; console.error(`[addons] applying ${id} failed: ${error?.message || error}`); }
    return sendJson(res, 200, { addon: after, ...(applyError ? { applyError } : {}) });
  });
}

function checkSettings(values, specs) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('settings must be an object');
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    const spec = specs[key];
    if (!spec) throw new Error(`Unknown setting: ${key}`);
    if (typeof value !== spec.type || (spec.type === 'number' && !Number.isFinite(value))) throw new Error(`${key} must be a ${spec.type}`);
    if (spec.enum && !spec.enum.includes(value)) throw new Error(`${key} must be one of: ${spec.enum.join(', ')}`);
    if (typeof value === 'string' && value.length > 500) throw new Error(`${key} is too long`);
    out[key] = value;
  }
  return out;
}

function checkConfirmations(value, toolNames) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('confirmTools must be an object of tool name to { read, classification }');
  for (const [name, decision] of Object.entries(value)) {
    if (!toolNames.has(name)) throw new Error(`Unknown tool: ${name}`);
    if (!decision || typeof decision !== 'object' || !CLASSIFICATIONS.includes(decision.classification) || (decision.read !== undefined && typeof decision.read !== 'boolean')) throw new Error(`${name}: needs { read: true|false, classification: ${CLASSIFICATIONS.join('|')} }`);
  }
}
