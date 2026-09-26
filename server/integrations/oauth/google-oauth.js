// Generic Google OAuth2 client: auth URL construction, code exchange, token
// refresh, and a small per-service access-token cache backed by a connection
// instance's `<vaultKey>.enc.json` via server/security/vault.js. Per
// docs/connectors.md's "OAuth2 flow" section.
//
// Instance-aware (issue #163 PR 3 of 5): every token-storage function below
// takes an explicit `vaultKey` identifying which `google` connection
// instance the tokens belong to, instead of hardcoding the legacy bare
// 'google' vault file -- see server/integrations/connection-instances.js for
// the `<connectorId>__<instanceId>` vault key convention.
//
// Every network-hitting function accepts an injectable `fetchImpl` (default
// globalThis.fetch) so tests can verify request construction with a fake
// fetch instead of hitting real network.
import { readEncryptedFile, writeEncryptedFile } from '../../security/vault.js';
import { isDeepStrictEqual } from 'node:util';

const AUTH_BASE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_SCOPES = {
  calendar: ['https://www.googleapis.com/auth/calendar'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly'],
};

export function buildAuthUrl({ clientId, redirectUri, scope, state }) {
  const url = new URL(AUTH_BASE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', Array.isArray(scope) ? scope.join(' ') : scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForTokens(
  { clientId, clientSecret, redirectUri, code },
  fetchImpl = globalThis.fetch
) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`google-oauth: code exchange failed (status ${res.status})`);
  }
  const json = await res.json();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
  };
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl = globalThis.fetch) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error('google-oauth: token refresh failed');
  }
  const json = await res.json();
  return {
    access_token: json.access_token,
    expires_in: json.expires_in,
  };
}

/**
 * Stores { access_token, refresh_token, expiry (absolute ms timestamp) }
 * under `<vaultKey>.enc.json`'s tokens.<service>, preserving the previously
 * stored refresh_token if this exchange/refresh didn't return a new one
 * (Google only returns refresh_token on first consent with prompt=consent).
 *
 * `vaultKey` is the connection instance's vault key (issue #163's
 * `<connectorId>__<instanceId>` convention, e.g. `google__conn_abc123` --
 * see server/integrations/connection-instances.js), NOT a service name.
 * Every call site must pass it explicitly -- there is deliberately no
 * default, so a caller can never silently write/read the wrong account's
 * tokens by forgetting to specify one.
 */
export function storeTokens(vaultKey, service, { access_token, refresh_token, expires_in }, dataDir) {
  const existing = readEncryptedFile(vaultKey, dataDir) || {};
  const existingTokens = existing.tokens || {};
  const previous = existingTokens[service] || {};
  const expiry = Date.now() + (expires_in ?? 0) * 1000;
  const next = {
    ...existing,
    tokens: {
      ...existingTokens,
      [service]: {
        access_token,
        refresh_token: refresh_token !== undefined ? refresh_token : previous.refresh_token,
        expiry,
      },
    },
  };
  writeEncryptedFile(vaultKey, next, dataDir);
  return next.tokens[service];
}

export function clearTokens(vaultKey, service, dataDir) {
  const existing = readEncryptedFile(vaultKey, dataDir);
  if (!existing || !existing.tokens || !existing.tokens[service]) return;
  const tokens = { ...existing.tokens };
  delete tokens[service];
  writeEncryptedFile(vaultKey, { ...existing, tokens }, dataDir);
}

export function hasTokens(vaultKey, service, dataDir) {
  const existing = readEncryptedFile(vaultKey, dataDir);
  return !!(existing && existing.tokens && existing.tokens[service] && existing.tokens[service].refresh_token);
}

/**
 * Returns a usable bearer access token for `service` ('calendar' | 'gmail' |
 * 'contacts') under the connection instance identified by `vaultKey`,
 * refreshing via the stored refresh_token if the cached access token is
 * within 60s of expiry (or already expired), and persisting the refreshed
 * access token back to that same vaultKey. Throws a clear "not connected"
 * error (no secret values) if this service has never been connected under
 * this vaultKey.
 */
export async function getValidAccessToken(vaultKey, service, { dataDir, fetchImpl = globalThis.fetch } = {}) {
  const stored = readEncryptedFile(vaultKey, dataDir);
  const token = stored?.tokens?.[service];
  if (!token || !token.refresh_token) {
    throw new Error(`google-oauth: ${service} is not connected`);
  }
  const REFRESH_SKEW_MS = 60 * 1000;
  if (token.expiry && token.access_token && Date.now() < token.expiry - REFRESH_SKEW_MS) {
    return token.access_token;
  }
  const sharedClient = readEncryptedFile('google', dataDir) || {};
  const clientId = sharedClient.clientId || stored.clientId;
  const clientSecret = sharedClient.clientSecret || stored.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error('google-oauth: missing stored Google OAuth client credentials');
  }
  const refreshed = await refreshAccessToken(
    { clientId, clientSecret, refreshToken: token.refresh_token },
    fetchImpl
  );
  // Refresh is an asynchronous read, not permission to restore removed or
  // superseded credentials. Check immediately before the synchronous write;
  // unrelated services may change and must remain intact.
  const current = readEncryptedFile(vaultKey, dataDir);
  const currentClient = readEncryptedFile('google', dataDir) || {};
  if (!isDeepStrictEqual(current?.tokens?.[service], token)
      || (currentClient.clientId || current?.clientId) !== clientId
      || (currentClient.clientSecret || current?.clientSecret) !== clientSecret) {
    throw new Error('google-oauth: credentials changed during refresh; retry with the selected connected account');
  }
  const next = storeTokens(vaultKey, service, { ...refreshed, refresh_token: token.refresh_token }, dataDir);
  return next.access_token;
}
