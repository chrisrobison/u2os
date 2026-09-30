import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { getVaultDir } from '../vault/vault-dir.js';
import { PROVIDER_ID, MAX_TIMEOUT_MS } from './types.js';

// The owner's vault says which coding agents U2OS may launch and how
// (docs/coding-agents.md, ADR 0009: delegation lives in the vault).
//
//   default: codex
//   preference: [codex, claude-code]      # order tried for provider: auto
//   roots: [~/Projects]                   # optional: cwd must be inside one
//   timeout_seconds: 1800                 # optional default for every run
//   providers:
//     codex:       { enabled: true, executable: codex }
//     claude-code: { enabled: true, executable: /opt/tools/claude, model: sonnet }
//
// No file means defaults: every known provider enabled, found on PATH. An
// invalid file fails closed: no provider is enabled until it is fixed, and
// the error is reported rather than guessed around.

const MAX_BYTES = 64 * 1024;
const EXECUTABLE = /^[^\0\n\r]{1,512}$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;

export function codingAgentsConfigPath(vaultDir = getVaultDir()) {
  return path.join(vaultDir, 'coding-agents.yaml');
}

export function defaultCodingAgentConfig() {
  return { default: null, preference: [], roots: [], timeoutMs: null, providers: {}, path: null, error: null };
}

/** { default, preference, roots, timeoutMs, providers: {id: {enabled, executable, model}}, path, error } */
export function loadCodingAgentConfig(vaultDir = getVaultDir()) {
  const file = codingAgentsConfigPath(vaultDir);
  const base = { ...defaultCodingAgentConfig(), path: file };
  let stat;
  try { stat = fs.lstatSync(file); } catch { return base; }
  try {
    if (!stat.isFile()) throw new Error('coding-agents.yaml must be a regular file');
    if (stat.size > MAX_BYTES) throw new Error('coding-agents.yaml is larger than 64 KiB');
    const raw = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
    return { ...base, ...parseCodingAgentConfig(raw) };
  } catch (error) {
    // Fail closed: `disabled` makes the registry treat every provider as off.
    return { ...base, disabled: true, error: error.reason || error.message };
  }
}

export function parseCodingAgentConfig(raw) {
  if (!isMapping(raw)) throw new Error('coding-agents.yaml must be a mapping');
  const allowed = new Set(['default', 'preference', 'roots', 'timeout_seconds', 'providers']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`${key}: unknown setting`);

  const providers = {};
  if (raw.providers !== undefined) {
    if (!isMapping(raw.providers)) throw new Error('providers must be a mapping');
    for (const [id, spec] of Object.entries(raw.providers)) {
      if (!PROVIDER_ID.test(id)) throw new Error(`providers.${id}: ids use lowercase letters, digits and "-"`);
      const options = spec ?? {};
      if (!isMapping(options)) throw new Error(`providers.${id} must be a mapping`);
      for (const key of Object.keys(options)) if (!['enabled', 'executable', 'model'].includes(key)) throw new Error(`providers.${id}.${key}: unknown setting`);
      if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new Error(`providers.${id}.enabled must be true or false`);
      if (options.executable !== undefined && (typeof options.executable !== 'string' || !EXECUTABLE.test(options.executable))) throw new Error(`providers.${id}.executable must be a program name or path`);
      if (options.model !== undefined && (typeof options.model !== 'string' || !MODEL.test(options.model))) throw new Error(`providers.${id}.model must be a model name`);
      providers[id] = { enabled: options.enabled !== false, executable: options.executable || null, model: options.model || null };
    }
  }

  const preference = raw.preference === undefined ? [] : idList(raw.preference, 'preference');
  if (raw.default !== undefined && (typeof raw.default !== 'string' || !PROVIDER_ID.test(raw.default))) throw new Error('default must be a provider id');
  const roots = raw.roots === undefined ? [] : stringList(raw.roots, 'roots').map(expandHome);
  for (const root of roots) if (!path.isAbsolute(root)) throw new Error(`roots: "${root}" must be an absolute path (or start with ~/)`);

  let timeoutMs = null;
  if (raw.timeout_seconds !== undefined) {
    if (!Number.isInteger(raw.timeout_seconds) || raw.timeout_seconds < 1 || raw.timeout_seconds * 1000 > MAX_TIMEOUT_MS) throw new Error('timeout_seconds must be a whole number from 1 to 86400');
    timeoutMs = raw.timeout_seconds * 1000;
  }
  return { default: raw.default || null, preference, roots, timeoutMs, providers };
}

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function idList(value, label) {
  const list = stringList(value, label);
  for (const id of list) if (!PROVIDER_ID.test(id)) throw new Error(`${label}: "${id}" is not a provider id`);
  return list;
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be a list of strings`);
  return value.map((item) => item.trim());
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
