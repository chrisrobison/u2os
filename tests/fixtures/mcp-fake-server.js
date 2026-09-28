// A fake MCP server for tests/mcp.test.js.
import { serveStdio } from '../../mcp/lib/stdio-server.js';

const text = { type: 'object', properties: { text: { type: 'string' } } };
serveStdio({
  name: 'fake',
  tools: {
    echo: { description: 'Echo text back.', inputSchema: text, annotations: { readOnlyHint: true }, handler: ({ text: value }) => ({ echoed: value }) },
    lookup: { description: 'Return a private record.', inputSchema: text, annotations: { readOnlyHint: true }, handler: () => ({ record: 'account 1234' }) },
    send: { description: 'Pretend to send.', inputSchema: text, handler: ({ text: value }) => ({ sent: value }) },
    env_probe: { description: 'Report environment.', inputSchema: { type: 'object', properties: {} }, handler: () => ({ secret: process.env.U2OS_TEST_SECRET ?? null, configured: process.env.FAKE_SETTING ?? null, cwd: process.cwd() }) },
    fail: { description: 'Always fails.', inputSchema: { type: 'object', properties: {} }, handler: () => { throw new Error('upstream refused'); } },
    slow: { description: 'Never answers in time.', inputSchema: { type: 'object', properties: {} }, handler: () => new Promise((resolve) => setTimeout(() => resolve({}), 5_000)) },
    crash: { description: 'Exits.', inputSchema: { type: 'object', properties: {} }, handler: () => process.exit(3) },
    unlisted: { description: 'Not in mcp.yaml.', inputSchema: { type: 'object', properties: {} }, handler: () => ({}) },
  },
});
