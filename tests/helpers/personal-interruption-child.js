// Forked personal acceptance runtime. Every provider request goes to an
// isolated parent fixture; native networking permits only these loopback URLs.
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';

const nativeFetch = globalThis.fetch;
const modelOrigin = new URL(process.env.U2OS_FIXTURE_MODEL_ORIGIN).origin;
const providerOrigin = new URL(process.env.U2OS_FIXTURE_PROVIDER_ORIGIN).origin;
for (const origin of [modelOrigin, providerOrigin]) {
  const url = new URL(origin); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url), method = init.method || 'GET';
  if (url.origin === modelOrigin && url.pathname === '/v1/chat/completions' && method === 'POST') return nativeFetch(input, init);
  const googleRead = ['https://gmail.googleapis.com', 'https://www.googleapis.com'].includes(url.origin) && method === 'GET';
  const simulatedSend = url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' && method === 'POST';
  if (!googleRead && !simulatedSend) throw new Error('Personal interruption fixture prohibits non-loopback network');
  return nativeFetch(`${providerOrigin}/fixture-provider`, { method: 'POST', signal: init.signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.href, method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body }) });
};
try {
  const handle = await startServer({ port: 0 });
  process.send({ kind: 'ready', port: handle.port });
} catch {
  process.send({ kind: 'failure' }, () => process.exit(1));
}
