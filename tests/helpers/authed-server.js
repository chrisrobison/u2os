import { startServer as startRealServer } from '../../server/index.js';

const credentials = new Map();
const nativeFetch = globalThis.fetch;
let installed = false;

export async function startServer(options = {}) {
  const handle = await startRealServer({ mode: 'demo', ...options });
  const origin = `http://127.0.0.1:${handle.port}`;
  const setup = await nativeFetch(`${origin}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'test-only owner passphrase' }),
  });
  if (!setup.ok) throw new Error(`Test owner setup failed: ${setup.status}`);
  const body = await setup.json();
  credentials.set(origin, {
    cookie: setup.headers.get('set-cookie').split(';')[0],
    csrf: body.csrfToken,
  });
  installFetchWrapper();
  handle.server.on('close', () => credentials.delete(origin));
  // A test home must outlive delayed delivery/continuation work. Preserve
  // normal Server.close semantics while draining the queue before callback.
  const close = handle.server.close.bind(handle.server);
  handle.server.close = (callback) => close((...args) => {
    handle.stopActionQueue().then(() => callback?.(...args));
  });
  return handle;
}

function installFetchWrapper() {
  if (installed) return;
  installed = true;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const auth = credentials.get(url.origin);
    if (!auth) return nativeFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('cookie', auth.cookie);
    headers.set('origin', url.origin);
    headers.set('x-u2os-csrf', auth.csrf);
    return nativeFetch(input, { ...init, headers });
  };
}
