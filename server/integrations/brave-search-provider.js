// Real web search provider (Brave Search API). Per docs/connectors.md's
// "Web search provider" section. Maps to the exact same
// { query, results:[{title,url,snippet}] } shape the mock returns (minus
// the mock's `mock: true` flag, since this path is real).
import { readEncryptedFile } from '../security/vault.js';

export const id = 'brave-search';

const API_URL = 'https://api.search.brave.com/res/v1/web/search';

/** `vaultKey` identifies which `brave-search` connection instance to check
 * (issue #163 PR 4) -- required, no default, so a caller can never silently
 * check the wrong account. */
export function isConnected(vaultKey, dataDir) {
  const stored = readEncryptedFile(vaultKey, dataDir);
  return !!stored?.apiKey;
}

const trustedFailures = new WeakSet();
function failure(kind, status) {
  const messages = {
    timeout: 'search timed out; retry later or check provider availability',
    authorization: 'authorization rejected; reconnect the selected search account',
    rate_limit: 'search rate limited; retry later',
    unavailable: 'search unavailable; check the selected account or retry later',
  };
  const error = new Error(`brave-search: ${messages[kind]}`);
  error.code = `SEARCH_${kind.toUpperCase()}`;
  trustedFailures.add(error);
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}

function discardBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); }
  catch { /* Locked/failed bodies are also stopped by the request signal. */ }
}

export async function search({ query }, { fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs = 10_000, timers = globalThis } = {}) {
  const stored = readEncryptedFile(instance?.vault_key, dataDir);
  if (!stored?.apiKey) {
    throw new Error('brave-search: not connected');
  }
  const url = new URL(API_URL);
  url.searchParams.set('q', query);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw failure('unavailable');
  const controller = new AbortController();
  let timedOut = false, response, timer;
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      timedOut = true;
      const error = failure('timeout');
      controller.abort(error);
      discardBody(response);
      reject(error);
    }, timeoutMs);
  });
  // The race bounds even an injected/non-cooperating transport. Late reads
  // have no cache writes or other effects, and never become observations.
  const read = async () => {
    response = await fetchImpl(url.toString(), {
      headers: { 'X-Subscription-Token': stored.apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (timedOut) { discardBody(response); throw failure('timeout'); }
    if (!response.ok) {
      const status = response.status;
      discardBody(response);
      throw failure([401, 403].includes(status) ? 'authorization' : status === 429 ? 'rate_limit' : 'unavailable', status);
    }
    const json = await response.json();
    if (timedOut) throw failure('timeout');
    const results = (json.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description || '' }));
    return { query, results };
  };
  try { return await Promise.race([read(), deadline]); }
  catch (error) {
    controller.abort();
    discardBody(response);
    if (timedOut) throw failure('timeout');
    if (trustedFailures.has(error)) throw error;
    throw failure('unavailable');
  } finally { timers.clearTimeout(timer); }
}
