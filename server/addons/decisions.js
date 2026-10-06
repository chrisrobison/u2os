// The owner's decisions about add-ons: the vault's `addons.yaml` (docs/addons.md).
// This file is the authority. An add-on's manifest can only suggest; nothing a
// manifest says takes effect until it is recorded here. The file fails closed:
// if it cannot be read or is invalid, nothing is enabled, and we refuse to
// overwrite it (so a hand-edit mistake never gets clobbered).
//
//   addons:
//     apple:
//       enabled: true
//       settings: { limit: 20 }
//       tools:
//         mail_unread: { read: true, classification: personal }
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getVaultDir } from '../vault/vault-dir.js';
import { ADDON_ID } from './manifest.js';
import { TOOL_NAME } from '../mcp/config.js';

const MAX_BYTES = 64 * 1024;
const CLASSIFICATIONS = ['public', 'personal', 'private', 'sensitive'];
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HEADER = '# Your decisions about add-ons (docs/addons.md). An add-on only suggests; nothing\n# takes effect until it is recorded here. Comments are not preserved when U2OS rewrites this file.\n';

export function addonsDecisionsPath(vaultDir = getVaultDir()) { return path.join(vaultDir, 'addons.yaml'); }

/** { path, addons: { [id]: { enabled, settings, tools } }, error } — a missing file means nothing is enabled. */
export function loadAddonDecisions(vaultDir = getVaultDir()) {
  const file = addonsDecisionsPath(vaultDir);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { path: file, addons: {}, error: null, exists: false }; }
  try {
    if (!stat.isFile()) throw new Error('addons.yaml must be a regular file');
    if (stat.size > MAX_BYTES) throw new Error('addons.yaml is larger than 64 KiB');
    const raw = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
    return { path: file, addons: parseDecisions(raw), error: null, exists: true };
  } catch (error) {
    return { path: file, addons: {}, error: error.reason || error.message, exists: true };
  }
}

export function parseDecisions(raw) {
  if (!isMapping(raw)) throw new Error('addons.yaml must be a mapping');
  for (const key of Object.keys(raw)) if (key !== 'addons') throw new Error(`${key}: unknown top-level key`);
  if (raw.addons === undefined || raw.addons === null) return {};
  if (!isMapping(raw.addons)) throw new Error('addons: must be a mapping of add-on id to its decisions');
  const out = {};
  for (const [id, spec] of Object.entries(raw.addons)) {
    if (!ADDON_ID.test(id)) throw new Error(`addons.${id}: invalid add-on id`);
    const entry = spec ?? {};
    if (!isMapping(entry)) throw new Error(`addons.${id}: must be a mapping`);
    for (const key of Object.keys(entry)) if (!['enabled', 'settings', 'tools'].includes(key)) throw new Error(`addons.${id}.${key}: unknown key`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`addons.${id}.enabled must be true or false`);
    const settings = entry.settings ?? {};
    if (!isMapping(settings) || Object.entries(settings).some(([k, v]) => !SETTING_KEY.test(k) || !['string', 'number', 'boolean'].includes(typeof v))) throw new Error(`addons.${id}.settings must map setting names to text, numbers or true/false`);
    const tools = entry.tools ?? {};
    if (!isMapping(tools)) throw new Error(`addons.${id}.tools must be a mapping`);
    const parsedTools = {};
    for (const [name, decision] of Object.entries(tools)) {
      if (!TOOL_NAME.test(name)) throw new Error(`addons.${id}.tools.${name}: invalid tool name`);
      if (!isMapping(decision)) throw new Error(`addons.${id}.tools.${name} must be a mapping such as { read: true, classification: personal }`);
      for (const key of Object.keys(decision)) if (!['read', 'classification'].includes(key)) throw new Error(`addons.${id}.tools.${name}.${key}: unknown key`);
      if (decision.read !== undefined && typeof decision.read !== 'boolean') throw new Error(`addons.${id}.tools.${name}.read must be true or false`);
      if (!CLASSIFICATIONS.includes(decision.classification)) throw new Error(`addons.${id}.tools.${name}.classification must be ${CLASSIFICATIONS.join(', ')} (a confirmed tool needs one)`);
      parsedTools[name] = { read: decision.read === true, classification: decision.classification };
    }
    out[id] = { enabled: entry.enabled === true, settings: { ...settings }, tools: parsedTools };
  }
  return out;
}

/**
 * Applies `mutate(addons)` to the current decisions and writes the file
 * atomically. Refuses (throws code ADDONS_FILE_INVALID) if the existing file
 * is invalid, so it is never overwritten behind the owner's back.
 */
export function updateAddonDecisions(mutate, vaultDir = getVaultDir()) {
  const current = loadAddonDecisions(vaultDir);
  if (current.error) throw Object.assign(new Error(`addons.yaml is invalid (${current.error}); fix or remove it first`), { code: 'ADDONS_FILE_INVALID', status: 409 });
  const addons = structuredClone(current.addons);
  mutate(addons);
  parseDecisions({ addons }); // never write something the loader would refuse
  const serializable = Object.fromEntries(Object.entries(addons).map(([id, d]) => [id, { enabled: d.enabled, ...(Object.keys(d.settings).length ? { settings: d.settings } : {}), ...(Object.keys(d.tools).length ? { tools: d.tools } : {}) }]));
  const text = HEADER + yaml.dump({ addons: serializable }, { lineWidth: 100, noRefs: true });
  const file = addonsDecisionsPath(vaultDir);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o644 });
  fs.renameSync(temporary, file);
  return addons;
}

function isMapping(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
