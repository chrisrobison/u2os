// Minimal Model Context Protocol server over stdio (newline-delimited
// JSON-RPC 2.0), enough for U2OS's first-party tool servers: initialize,
// tools/list and tools/call. Diagnostics go to stderr; stdout carries only
// protocol messages.

export const PROTOCOL_VERSION = '2025-06-18';

/**
 * serveStdio({ name, version, tools }) where tools maps a tool name to
 * { description, inputSchema, handler(args) -> result object }.
 * A handler's return value becomes structuredContent (and a JSON text
 * block); a thrown error becomes an isError result with its message.
 */
export function serveStdio({ name, version = '0.1.0', tools, input = process.stdin, output = process.stdout }) {
  let buffer = '';
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(message) {
    const { id, method, params } = message;
    if (id === undefined) return; // notifications (e.g. notifications/initialized)
    if (method === 'initialize') {
      return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name, version } });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      return reply(id, { tools: Object.entries(tools).map(([toolName, tool]) => ({ name: toolName, description: tool.description, inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}) })) });
    }
    if (method === 'tools/call') {
      const tool = tools[params?.name];
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.handler(params.arguments || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        return reply(id, { content: [{ type: 'text', text: String(error?.message || error).slice(0, 1_000) }], isError: true });
      }
    }
    return fail(id, -32601, `Method not found: ${method}`);
  }

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
      handle(message).catch((error) => process.stderr.write(`[${name}] ${error?.stack || error}\n`));
    }
  });
  input.on('end', () => process.exit(0));
}
