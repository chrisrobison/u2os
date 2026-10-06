// A fake MCP server shaped like apple-mcp: one `mail` tool whose `operation`
// argument mixes reading and sending. For tests/addon-runtime.test.js.
import { serveStdio } from '../../mcp/lib/stdio-server.js';

const schema = { type: 'object', properties: { operation: { type: 'string', enum: ['unread', 'send'] }, to: { type: 'string' } }, required: ['operation'] };
serveStdio({
  name: 'fakemail',
  tools: {
    mail: { description: 'Read or send mail.', inputSchema: schema, handler: (args) => ({ ran: args.operation, to: args.to ?? null, argv: process.argv.slice(2), setting: process.env.FAKE_LIMIT ?? null }) },
    other: { description: 'Another tool.', inputSchema: { type: 'object', properties: {} }, handler: () => ({}) },
  },
});
