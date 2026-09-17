// Generic Google OAuth2 client: auth URL construction, code exchange, token
// refresh, and a small per-service access-token cache backed by
// google.enc.json via server/security/vault.js. Per docs/connectors.md's
// "OAuth2 flow" section.
//
// Every network-hitting function accepts an injectable `fetchImpl` (default
// globalThis.fetch) so tests can verify request construction with a fake
// fetch instead of hitting real network.
import { readEncryptedFile, writeEncryptedFile } from '../../security/vault.js';

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
 * under google.enc.json's tokens.<service>, preserving the previously stored
 * refresh_token if this exchange/refresh didn't return a new one (Google
 * only returns refresh_token on first consent with prompt=consent).
 */
export function storeTokens(service, { access_token, refresh_token, expires_in }, dataDir) {
  const existing = readEncryptedFile('google', dataDir) || {};
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
  writeEncryptedFile('google', next, dataDir);
  return next.tokens[service];
}

export function clearTokens(service, dataDir) {
  const existing = readEncryptedFile('google', dataDir);
  if (!existing || !existing.tokens || !existing.tokens[service]) return;
  const tokens = { ...existing.tokens };
  delete tokens[service];
  writeEncryptedFile('google', { ...existing, tokens }, dataDir);
}

export function hasTokens(service, dataDir) {
  const existing = readEncryptedFile('google', dataDir);
  return !!(existing && existing.tokens && existing.tokens[service] && existing.tokens[service].refresh_token);
}

/**
 * Returns a usable bearer access token for `service` ('calendar' | 'gmail' |
 * 'contacts'), refreshing via the stored refresh_token if the cached access
 * token is within 60s of expiry (or already expired), and persisting the
 * refreshed access token back. Throws a clear "not connected" error (no
 * secret values) if this service has never been connected.
 */
export async function getValidAccessToken(service, { dataDir, fetchImpl = globalThis.fetch } = {}) {
  const stored = readEncryptedFile('google', dataDir);
  const token = stored?.tokens?.[service];
  if (!token || !token.refresh_token) {
    throw new Error(`google-oauth: ${service} is not connected`);
  }
  const REFRESH_SKEW_MS = 60 * 1000;
  if (token.expiry && token.access_token && Date.now() < token.expiry - REFRESH_SKEW_MS) {
    return token.access_token;
  }
  if (!stored.clientId || !stored.clientSecret) {
    throw new Error('google-oauth: missing stored Google OAuth client credentials');
  }
  const refreshed = await refreshAccessToken(
    { clientId: stored.clientId, clientSecret: stored.clientSecret, refreshToken: token.refresh_token },
    fetchImpl
  );
  const next = storeTokens(service, { ...refreshed, refresh_token: token.refresh_token }, dataDir);
  return next.access_token;
}
