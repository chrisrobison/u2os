// Internal JSON-only read transport. The operation includes authorization,
// headers and body parsing; it must await its reads before mutating caches.
import { googleTokenFailureMetadata } from './oauth/google-oauth.js';
const trustedFailures = new WeakMap();
function failure(kind, status) {
  const messages = {
    timeout: 'read timed out; check provider availability and retry later',
    authorization: 'authorization rejected; reconnect the selected account',
    rate_limit: 'read rate limited; retry later',
    unavailable: 'read unavailable; check the selected connected account and provider availability',
  };
  const error = new Error(`google-provider: ${messages[kind]}${Number.isInteger(status) && status >= 100 && status <= 599 ? ` (status ${status})` : ''}`);
  error.code = `GOOGLE_READ_${kind.toUpperCase()}`;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  trustedFailures.set(error, { kind, status: error.status }); return error;
}
function discard(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); }
  catch { /* Abort interrupts locked native bodies. */ }
}

export async function withGoogleRead({ fetchImpl = globalThis.fetch, timeoutMs = 30_000, timers = globalThis } = {}, operation) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw failure('unavailable');
  const controller = new AbortController(), responses = new Set();
  let timer, timedOut = false, finished = false, failedStatus;
  const check = () => { if (timedOut) throw failure('timeout'); if (finished) throw failure('unavailable'); };
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      timedOut = true; const error = failure('timeout');
      controller.abort(error); for (const response of responses) discard(response); reject(error);
    }, timeoutMs);
  });
  const boundedFetch = async (input, init = {}) => {
    check();
    const method = (init.method || 'GET').toUpperCase();
    // OAuth token acquisition is the only permitted POST inside a read.
    // Never use this boundary to time out/retry a consequential write.
    if (method !== 'GET' && !(method === 'POST' && String(input) === 'https://oauth2.googleapis.com/token')) throw failure('unavailable');
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const transport = Promise.resolve().then(() => { check(); return fetchImpl(input, { ...init, signal }); }).then((response) => {
      if (timedOut || finished) { discard(response); check(); }
      responses.add(response);
      failedStatus = response.ok ? undefined : response.status;
      if (!response.ok) {
        discard(response);
        // Existing get-404 and sync skip semantics can inspect metadata,
        // but an error body is never read or forwarded.
        if (response.status !== 404) throw failure([401, 403].includes(response.status) || (method === 'POST' && response.status === 400) ? 'authorization' : response.status === 429 ? 'rate_limit' : 'unavailable', response.status);
      }
      // A deliberately narrow facade: providers/OAuth consume only these
      // fields. Racing JSON here prevents late token *and* cache writes.
      return { ok: response.ok, status: response.status, body: response.body,
        json: async () => {
          check();
          if (!response.ok) throw failure('unavailable', response.status);
          const read = Promise.resolve().then(() => { check(); return response.json(); }).then((json) => { check(); return json; });
          return Promise.race([read, deadline]);
        } };
    });
    return Promise.race([transport, deadline]);
  };
  try { return await Promise.race([Promise.resolve().then(() => { check(); return operation({ fetchImpl: boundedFetch, check }); }), deadline]); }
  catch (error) {
    if (timedOut) throw failure('timeout');
    const known = trustedFailures.get(error);
    if (known) throw failure(known.kind, known.status);
    const tokenFailure = googleTokenFailureMetadata(error);
    if (tokenFailure?.kind === 'timeout') throw failure('timeout');
    const status = failedStatus ?? tokenFailure?.status;
    throw failure([400, 401, 403].includes(status) ? 'authorization' : status === 429 ? 'rate_limit' : tokenFailure?.kind || 'unavailable', status);
  } finally {
    finished = true; timers.clearTimeout(timer); controller.abort();
    for (const response of responses) discard(response);
  }
}
