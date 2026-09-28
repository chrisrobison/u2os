import { Tool } from '../tools/tool.js';
import { log } from '../logging/logger.js';
import { getVaultDir } from '../vault/vault-dir.js';
import { setObservationFloor } from '../agent/observation-filter.js';
import { McpClient } from './client.js';
import { loadMcpConfig } from './config.js';

// MCP servers declared in the owner's vault (docs/mcp.md, ADR 0009) become
// ordinary planner-visible tools named `<server>.<tool>`. Nothing about the
// gate changes: calls go through Agent.evaluateAndMaybeExecute(), policy
// decides (confirm when unconfigured), the durable queue executes, and
// results are untrusted observations filtered by the data-processing policy
// at the classification the owner declared for that tool.

const MAX_RESULT_CHARS = 256 * 1024;
const RECONNECT_BACKOFF_MS = 30_000;

let state = { path: null, error: null, servers: [] };

export class McpTool extends Tool {
  constructor({ serverName, remote, options }) {
    super();
    this.serverName = serverName;
    this.remoteName = remote.name;
    this.options = options;
    this._description = typeof remote.description === 'string' ? remote.description.slice(0, 1_000) : '';
    this._schema = isMapping(remote.inputSchema) ? remote.inputSchema : { type: 'object', properties: {} };
  }
  get name() { return `${this.serverName}.${this.remoteName}`; }
  get removable() { return true; }
  get domain() { return this.serverName; }
  // Only the owner's mcp.yaml can make a tool read-only; a server's own
  // readOnlyHint is not trusted.
  get category() { return this.options.read ? 'read' : 'consequential'; }
  get description() { return `${this._description}${this._description ? ' ' : ''}(MCP server "${this.serverName}")`; }
  get schema() { return this._schema; }

  async execute(args) {
    // Looked up at call time, so a restart of the servers is picked up.
    const handle = state.servers.find((server) => server.name === this.serverName && server.spec.enabled);
    if (!handle) throw new Error(`MCP server ${this.serverName} is not configured`);
    const client = await handle.ensureConnected();
    const result = await client.callTool(this.remoteName, args || {});
    return toolResult(result);
  }
}

/** Turns an MCP tools/call result into a plain JSON value, or throws its error. */
export function toolResult(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
  if (result?.isError) throw Object.assign(new Error((text || 'MCP tool reported an error').slice(0, 1_000)), { code: 'MCP_TOOL_ERROR' });
  let value;
  if (isMapping(result?.structuredContent)) value = result.structuredContent;
  else {
    try { value = JSON.parse(text); } catch { value = { text }; }
  }
  if (JSON.stringify(value).length > MAX_RESULT_CHARS) return { truncated: true, text: JSON.stringify(value).slice(0, MAX_RESULT_CHARS) };
  return value;
}

class ServerHandle {
  constructor(spec, { cwd }) {
    Object.assign(this, { spec, name: spec.name, cwd });
    this.client = null;
    this.status = { name: spec.name, enabled: spec.enabled, state: spec.enabled ? 'starting' : 'disabled', error: null, tools: [], missingTools: [] };
    this.lastFailure = 0;
  }

  async connect() {
    this.client?.close();
    this.client = new McpClient({ name: this.name, command: this.spec.command, args: this.spec.args, env: this.spec.env, cwd: this.cwd, timeoutMs: this.spec.timeoutMs });
    try {
      await this.client.connect();
      this.status.state = 'running';
      this.status.error = null;
      this.client.child.on('exit', () => { if (this.status.state === 'running') this.status.state = 'exited'; });
      return this.client;
    } catch (error) {
      this.lastFailure = Date.now();
      this.status.state = 'failed';
      this.status.error = error.message;
      this.status.stderr = this.client.stderr.slice(-1_000) || undefined;
      this.client.close();
      throw error;
    }
  }

  /** A crashed server is restarted on the next call; a failed start is retried after 30 s. */
  async ensureConnected() {
    if (this.client && !this.client.closed && this.status.state === 'running') return this.client;
    if (Date.now() - this.lastFailure < RECONNECT_BACKOFF_MS) throw new Error(`MCP server ${this.name} is not running`);
    return this.connect();
  }

  close() {
    this.client?.close();
    if (this.status.state === 'running') this.status.state = 'stopped';
  }
}

/**
 * Starts the servers in the vault's mcp.yaml and registers their listed
 * tools. Failures are reported in the status and never stop U2OS starting.
 */
export async function startMcpServers({ toolRegistry, vaultDir = getVaultDir() } = {}) {
  await stopMcpServers();
  // A restart re-registers exactly what mcp.yaml lists now.
  for (const tool of toolRegistry.list()) if (tool instanceof McpTool) toolRegistry.unregister(tool.name);
  const config = loadMcpConfig(vaultDir);
  state = { path: config.path, error: config.error, servers: [] };
  if (config.error) log.warn('mcp', 'mcp.yaml is invalid; no MCP servers were started');
  const taken = new Set([...toolRegistry.list().map((tool) => tool.name), ...toolRegistry.hiddenNames()].map((name) => name.split('.')[0]));
  await Promise.all(config.servers.map(async (spec) => {
    const handle = new ServerHandle(spec, { cwd: vaultDir });
    state.servers.push(handle);
    if (!spec.enabled) return;
    if (taken.has(spec.name)) {
      handle.status.state = 'failed';
      handle.status.error = `The name "${spec.name}" is already used by another tool`;
      return;
    }
    try {
      await handle.connect();
      const offered = new Map((await handle.client.listTools()).filter((tool) => typeof tool?.name === 'string').map((tool) => [tool.name, tool]));
      for (const options of spec.tools) {
        const remote = offered.get(options.name);
        if (!remote) { handle.status.missingTools.push(options.name); continue; }
        const tool = new McpTool({ serverName: spec.name, remote, options });
        toolRegistry.register(tool);
        setObservationFloor(tool.name, options.classification);
        handle.status.tools.push(tool.name);
      }
    } catch (error) {
      log.warn('mcp', `MCP server ${spec.name} failed to start`);
      handle.status.state = 'failed';
      handle.status.error ||= error.message;
    }
  }));
  return getMcpStatus();
}

export async function stopMcpServers() {
  for (const handle of state.servers) handle.close();
}

/** Owner-only status: names, states and errors, never tool results. */
export function getMcpStatus() {
  return { path: state.path, error: state.error, servers: state.servers.map((handle) => ({ ...handle.status })) };
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
