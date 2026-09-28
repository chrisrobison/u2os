import { spawn } from 'node:child_process';

// A Model Context Protocol client for one stdio server: newline-delimited
// JSON-RPC 2.0 over the child's stdin/stdout (https://modelcontextprotocol.io).
// Only what U2OS needs: initialize, tools/list and tools/call.

export const PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE = 4 * 1024 * 1024;
const MAX_STDERR = 4_000;

export class McpClient {
  constructor({ name, command, args = [], env = {}, cwd, timeoutMs = 120_000 }) {
    Object.assign(this, { name, command, args, env, cwd, timeoutMs });
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.closed = false;
    this.stderr = '';
  }

  async connect({ initTimeoutMs = 15_000 } = {}) {
    // The child gets a minimal environment: never U2OS's own secrets
    // (model API keys, connector credentials) that live in process.env.
    const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8', ...this.env };
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { this._fail(new Error(`MCP server ${this.name} sent an oversized message`)); this.close(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this._receive(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-MAX_STDERR); });
    this.child.on('error', (error) => this._fail(error));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this._fail(new Error(`MCP server ${this.name} exited (${signal || code})`));
    });
    this.child.stdin.on('error', () => {});

    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'u2os', version: '0.1.0' },
    }, initTimeoutMs);
    this.serverInfo = init?.serverInfo || null;
    this.notify('notifications/initialized');
    return init;
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed || !this.child) return Promise.reject(new Error(`MCP server ${this.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`MCP server ${this.name} did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`), { code: 'MCP_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });
  }

  notify(method, params) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  _receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    // Server-initiated requests (sampling, roots, elicitation) are not
    // supported: U2OS never lets a tool server drive the model.
    if (message.method && message.id !== undefined) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported by U2OS' } })}\n`);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(Object.assign(new Error(String(message.error.message || 'MCP error').slice(0, 500)), { code: 'MCP_ERROR' }));
    else entry.resolve(message.result);
  }

  _fail(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  close() {
    if (!this.child || this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch { /* already gone */ }
    const child = this.child;
    const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    kill.unref?.();
    child.once('exit', () => clearTimeout(kill));
    child.kill('SIGTERM');
  }
}
