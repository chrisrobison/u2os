import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { getVaultDir } from '../vault/vault-dir.js';

// The owner's vault declares the MCP servers U2OS may start (docs/mcp.md,
// ADR 0009):
//
//   servers:
//     jobs:
//       command: node
//       args: ["${U2OS_ROOT}/mcp/jobs/server.js", "--vault", "${VAULT}"]
//       tools:
//         search_jobs: { read: true, classification: public }
//         apply: {}
//
// Only listed tools are exposed. A tool is read-only only when the owner
// says so here (a server's own hints are not trusted), and every other tool
// is gated by policies.yaml as `<server>.<tool>`, confirm by default.

export const U2OS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CLASSIFICATIONS = ['public', 'personal', 'private', 'sensitive'];
// Names a server may not take: its tools would share a policy domain with
// built-in tools or U2OS internals.
export const RESERVED_SERVER_NAMES = new Set(['email', 'calendar', 'contacts', 'tasks', 'web', 'notifications', 'presentation', 'mcp', 'vault', 'routine', 'agent', 'memory', 'system', 'package', 'packages', 'owner']);
const MAX_BYTES = 64 * 1024;

export function mcpConfigPath(vaultDir = getVaultDir()) {
  return path.join(vaultDir, 'mcp.yaml');
}

/** { servers: [...], error } — a missing file is no servers, not an error. */
export function loadMcpConfig(vaultDir = getVaultDir()) {
  const file = mcpConfigPath(vaultDir);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { path: file, servers: [], error: null }; }
  try {
    if (!stat.isFile()) throw new Error('mcp.yaml must be a regular file');
    if (stat.size > MAX_BYTES) throw new Error('mcp.yaml is larger than 64 KiB');
    const raw = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
    return { path: file, servers: parseMcpConfig(raw, { vaultDir }), error: null };
  } catch (error) {
    return { path: file, servers: [], error: error.reason || error.message };
  }
}

export function parseMcpConfig(raw, { vaultDir }) {
  if (!isMapping(raw) || !isMapping(raw.servers)) throw new Error('mcp.yaml must contain a servers: mapping');
  const expand = (value) => value.replaceAll('${U2OS_ROOT}', U2OS_ROOT).replaceAll('${VAULT}', vaultDir);
  return Object.entries(raw.servers).map(([name, spec]) => {
    if (!SERVER_NAME.test(name)) throw new Error(`${name}: server names use lowercase letters, digits and "_"`);
    if (RESERVED_SERVER_NAMES.has(name)) throw new Error(`${name}: this name is reserved for built-in tools`);
    if (!isMapping(spec)) throw new Error(`${name}: must be a mapping`);
    if (typeof spec.command !== 'string' || !spec.command.trim()) throw new Error(`${name}.command must be a program to run`);
    if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string' && typeof arg !== 'number'))) throw new Error(`${name}.args must be a list of strings`);
    if (spec.env !== undefined && (!isMapping(spec.env) || Object.values(spec.env).some((value) => !['string', 'number', 'boolean'].includes(typeof value)))) throw new Error(`${name}.env must map names to values`);
    if (spec.enabled !== undefined && typeof spec.enabled !== 'boolean') throw new Error(`${name}.enabled must be true or false`);
    const timeout = spec.timeout_seconds ?? 120;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 900) throw new Error(`${name}.timeout_seconds must be a whole number from 1 to 900`);
    if (!isMapping(spec.tools) || !Object.keys(spec.tools).length) throw new Error(`${name}.tools must list the tools U2OS may use`);
    const tools = Object.entries(spec.tools).map(([toolName, toolSpec]) => {
      if (!TOOL_NAME.test(toolName)) throw new Error(`${name}.tools.${toolName}: tool names use letters, digits, "_" or "-"`);
      const options = toolSpec ?? {};
      if (!isMapping(options)) throw new Error(`${name}.tools.${toolName} must be a mapping such as { read: true }`);
      if (options.read !== undefined && typeof options.read !== 'boolean') throw new Error(`${name}.tools.${toolName}.read must be true or false`);
      if (options.classification !== undefined && !CLASSIFICATIONS.includes(options.classification)) throw new Error(`${name}.tools.${toolName}.classification must be public, personal, private or sensitive`);
      return { name: toolName, read: options.read === true, classification: options.classification || 'private' };
    });
    return {
      name,
      enabled: spec.enabled !== false,
      command: expand(spec.command),
      args: (spec.args || []).map((arg) => expand(String(arg))),
      env: Object.fromEntries(Object.entries(spec.env || {}).map(([key, value]) => [key, expand(String(value))])),
      timeoutMs: timeout * 1000,
      tools,
    };
  });
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
