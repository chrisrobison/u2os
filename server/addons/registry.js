// Discovers add-ons and combines what they describe with what the owner decided.
// Reading a manifest never runs anything (docs/addons.md).
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';
import { getVaultDir } from '../vault/vault-dir.js';
import { U2OS_ROOT } from '../mcp/config.js';
import { satisfies } from '../packages/semver.js';
import { loadAddonDecisions } from './decisions.js';
import { ADDON_ID, AddonManifestError, MAX_MANIFEST_BYTES, parseAddonYaml, validateAddonManifest } from './manifest.js';

const MAX_README_BYTES = 64 * 1024;
const MAX_ADDONS = 200;
const U2OS_VERSION = JSON.parse(fs.readFileSync(path.join(U2OS_ROOT, 'package.json'), 'utf8')).version;

export const bundledAddonsDir = () => path.join(U2OS_ROOT, 'addons');
export const installedAddonsDir = (dataDir = getDataDir()) => path.join(dataDir, 'addons');

/** Every add-on folder found, with its manifest or the problems that stop it loading. Bundled wins over installed for the same id. */
export function discoverAddons({ bundledDir = bundledAddonsDir(), installedDir = installedAddonsDir(), env = process.env, platform = process.platform } = {}) {
  const found = [];
  const seen = new Map();
  for (const [tier, root] of [['bundled', bundledDir], ['installed', installedDir]]) {
    for (const folder of listFolders(root).slice(0, MAX_ADDONS)) {
      const dir = path.join(root, folder);
      const entry = inspectFolder({ dir, folder, tier, env, platform });
      if (seen.has(entry.id)) {
        entry.manifest = null;
        entry.problems = [`shadowed by the ${seen.get(entry.id)} add-on with the same id`];
        entry.state = 'invalid';
      } else seen.set(entry.id, tier);
      found.push(entry);
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function listFolders(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); }
  catch { return []; }
}

function inspectFolder({ dir, folder, tier, env, platform }) {
  const base = { id: folder, tier, dir, manifest: null, readme: '', problems: [], missingCommands: [], state: 'invalid' };
  const manifestFile = path.join(dir, 'addon.yaml');
  try {
    const stat = fs.lstatSync(manifestFile);
    if (!stat.isFile()) throw new AddonManifestError('addon.yaml must be a regular file');
    if (stat.size > MAX_MANIFEST_BYTES) throw new AddonManifestError('addon.yaml is too large');
    const manifest = validateAddonManifest(parseAddonYaml(fs.readFileSync(manifestFile, 'utf8')));
    if (manifest.id !== folder) throw new AddonManifestError(`the folder name "${folder}" must match metadata.id "${manifest.id}"`);
    base.manifest = manifest;
    base.id = manifest.id;
    base.readme = readReadme(dir);
    const unsupported = [];
    if (manifest.requires.platform.length && !manifest.requires.platform.includes(platform)) unsupported.push(`works on ${manifest.requires.platform.join(', ')} only`);
    if (manifest.requires.u2os && !satisfies(U2OS_VERSION, manifest.requires.u2os)) unsupported.push(`needs U2OS ${manifest.requires.u2os}`);
    base.missingCommands = manifest.requires.commands.filter((command) => !commandOnPath(command, env, platform));
    base.problems = unsupported;
    base.state = unsupported.length ? 'unsupported' : 'available';
  } catch (error) {
    base.problems = error instanceof AddonManifestError ? (error.errors.length ? error.errors : [error.message]) : [error.code === 'ENOENT' ? 'addon.yaml is missing' : 'addon.yaml could not be read'];
    // A folder whose name is not a valid id cannot be addressed by the API.
    if (!ADDON_ID.test(base.id)) base.id = `invalid:${folder.slice(0, 40)}`;
  }
  return base;
}

function readReadme(dir) {
  try {
    const file = path.join(dir, 'README.md');
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return '';
    const text = fs.readFileSync(file, 'utf8');
    return text.length > MAX_README_BYTES ? text.slice(0, MAX_README_BYTES) : text;
  } catch { return ''; }
}

function commandOnPath(command, env, platform) {
  const extensions = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      try { fs.accessSync(path.join(dir, command + ext), fs.constants.X_OK); return true; } catch { /* keep looking */ }
    }
  }
  return false;
}

/**
 * The owner-facing description: manifest facts plus the owner's decisions.
 * A tool the owner has not confirmed is a confirm-required action with private
 * results, whatever the manifest suggests.
 */
export function describeAddons({ discovered = discoverAddons(), decisions = loadAddonDecisions() } = {}) {
  const addons = discovered.map((entry) => {
    const decided = decisions.addons[entry.id] || { enabled: false, settings: {}, tools: {} };
    const m = entry.manifest;
    const enabled = Boolean(m) && decided.enabled && entry.state === 'available' && !decisions.error;
    return {
      id: entry.id, tier: entry.tier, state: entry.state, problems: entry.problems, missingCommands: entry.missingCommands,
      enabled, enabledInFile: decided.enabled,
      ...(m ? {
        name: m.name, version: m.version, description: m.description, author: m.author, license: m.license, homepage: m.homepage,
        requires: m.requires, readme: entry.readme, nav: m.ui.nav, skills: m.skills, routines: m.routines,
        servers: m.servers.map((server) => ({
          name: server.name,
          tools: server.tools.map((tool) => {
            const confirmed = decided.tools[tool.name] || null;
            return {
              name: tool.name, fullName: `${server.name}.${tool.name}`, remote: tool.remote, fixed: tool.fixed, description: tool.description,
              suggested: { read: tool.suggestedRead, classification: tool.suggestedClassification },
              confirmed: Boolean(confirmed),
              effective: confirmed ? { read: confirmed.read, classification: confirmed.classification } : { read: false, classification: 'private' },
            };
          }),
        })),
        settings: Object.entries(m.settings).map(([key, spec]) => ({ key, ...spec, value: decided.settings[key] ?? spec.default ?? null })),
      } : {}),
    };
  });
  return { addons, decisionsPath: decisions.path, decisionsError: decisions.error };
}

export { U2OS_VERSION };
