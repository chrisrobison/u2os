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

export async function search({ query }, { fetchImpl = globalThis.fetch, dataDir, instance } = {}) {
  const stored = readEncryptedFile(instance?.vault_key, dataDir);
  if (!stored?.apiKey) {
    throw new Error('brave-search: not connected');
  }
  const url = new URL(API_URL);
  url.searchParams.set('q', query);
  const res = await fetchImpl(url.toString(), {
    headers: { 'X-Subscription-Token': stored.apiKey, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`brave-search: search failed (status ${res.status})`);
  const json = await res.json();
  const results = (json.web?.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description || '',
  }));
  return { query, results };
}
