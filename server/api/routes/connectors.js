import crypto from 'node:crypto';
import { sendJson } from '../router.js';
import { getHealth, resolveConnectedRealProvider } from '../../integrations/provider-registry.js';
import { setActiveProvider, validProviderIdsFor } from '../../integrations/connectors-config.js';
import { triggerSync } from '../../integrations/sync-scheduler.js';
import { manifestsByDomain } from '../../integrations/skill-manifests.js';
import { readEncryptedFile, writeEncryptedFile } from '../../security/vault.js';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  storeTokens,
  clearTokens,
  GOOGLE_SCOPES,
} from '../../integrations/oauth/google-oauth.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_SERVICES = ['calendar', 'gmail', 'contacts'];

// In-memory, per-process state cache for CSRF protection on the OAuth
// callback -- per docs/connectors.md's OAuth2 flow step 2/3. Never persisted
// (a restart mid-flow simply invalidates any pending, unfinished connect
// attempt, which is fine).
const pendingOauthStates = new Map(); // state -> { service, expiresAt }

function pruneExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingOauthStates) {
    if (entry.expiresAt <= now) pendingOauthStates.delete(state);
  }
}

export function registerConnectorRoutes(router, { db, eventBus } = {}) {
  // GET /api/connectors -- health/status for all 5 domains, plus which
  // providers exist for each domain (for the UI to render toggles). NEVER
  // includes decrypted secrets -- only booleans and non-secret metadata.
  router.get('/api/connectors', async (_req, res) => {
    const health = getHealth();
    const byDomain = manifestsByDomain();
    const enriched = health.map((entry) => ({
      ...entry,
      manifests: (byDomain[entry.domain] || []).map((m) => ({
        id: m.id,
        name: m.name,
        auth: { type: m.auth?.type, scopes: m.auth?.scopes || [] },
        permissions: m.permissions || [],
        status: m.status || 'available',
      })),
    }));
    sendJson(res, 200, { connectors: enriched });
  });

  router.post('/api/connectors/google/credentials', async (req, res) => {
    const { clientId, clientSecret } = req.body || {};
    if (!clientId || !clientSecret) {
      return sendJson(res, 400, { error: 'clientId and clientSecret are required' });
    }
    const existing = readEncryptedFile('google') || {};
    writeEncryptedFile('google', { ...existing, clientId, clientSecret, tokens: existing.tokens || {} });
    sendJson(res, 200, { configured: true });
  });

  router.get('/api/connectors/google/oauth/start', async (req, res) => {
    const service = req.query.service;
    if (!GOOGLE_SERVICES.includes(service)) {
      return sendJson(res, 400, { error: `service must be one of ${GOOGLE_SERVICES.join(', ')}` });
    }
    const stored = readEncryptedFile('google');
    if (!stored?.clientId) {
      return sendJson(res, 400, { error: 'Google OAuth client credentials are not configured yet' });
    }
    pruneExpiredStates();
    const state = crypto.randomBytes(24).toString('hex');
    pendingOauthStates.set(state, { service, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });

    const redirectUri = redirectUriFor(req);
    const url = buildAuthUrl({
      clientId: stored.clientId,
      redirectUri,
      scope: GOOGLE_SCOPES[service],
      state,
    });
    res.writeHead(302, { Location: url });
    res.end();
  });

  router.get('/api/connectors/google/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    pruneExpiredStates();
    const entry = state ? pendingOauthStates.get(state) : null;

    // SECURITY: an unknown or replayed state must be rejected outright, not
    // silently accepted -- this is the CSRF protection for the whole flow.
    if (!entry) {
      return sendJson(res, 400, { error: 'Invalid or expired OAuth state' });
    }
    pendingOauthStates.delete(state); // single-use

    const { service } = entry;
    try {
      const stored = readEncryptedFile('google');
      if (!stored?.clientId || !stored?.clientSecret) {
        throw new Error('Google OAuth client credentials are not configured');
      }
      const redirectUri = redirectUriFor(req);
      const tokens = await exchangeCodeForTokens({
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        redirectUri,
        code,
      });
      storeTokens(service, tokens);
      res.writeHead(302, { Location: `/#/connectors?connected=${encodeURIComponent(service)}` });
      res.end();
    } catch (err) {
      // SECURITY: never include token/credential values in this message.
      console.error(`[connectors] google oauth callback failed for service "${service}"`, err.message);
      res.writeHead(302, { Location: `/#/connectors?error=${encodeURIComponent('connect_failed')}` });
      res.end();
    }
  });

  router.post('/api/connectors/google/disconnect', async (req, res) => {
    const service = req.query.service;
    if (!GOOGLE_SERVICES.includes(service)) {
      return sendJson(res, 400, { error: `service must be one of ${GOOGLE_SERVICES.join(', ')}` });
    }
    clearTokens(service);
    sendJson(res, 200, { disconnected: service });
  });

  router.post('/api/connectors/web-search/credentials', async (req, res) => {
    const { apiKey } = req.body || {};
    if (!apiKey) return sendJson(res, 400, { error: 'apiKey is required' });
    writeEncryptedFile('web-search', { apiKey });
    sendJson(res, 200, { configured: true });
  });

  router.post('/api/connectors/notify-webhook/credentials', async (req, res) => {
    const { webhookUrl, format } = req.body || {};
    if (!webhookUrl) return sendJson(res, 400, { error: 'webhookUrl is required' });
    writeEncryptedFile('notify-webhook', { webhookUrl, format: format === 'ntfy' ? 'ntfy' : 'json' });
    sendJson(res, 200, { configured: true });
  });

  router.post('/api/connectors/:domain/active', async (req, res) => {
    const { domain } = req.params;
    const { providerId } = req.body || {};
    try {
      setActiveProvider(domain, providerId);
      sendJson(res, 200, { domain, active: providerId });
    } catch (err) {
      sendJson(res, 400, { error: err.message, validProviders: validProviderIdsFor(domain) });
    }
  });

  router.post('/api/connectors/:domain/sync', async (req, res) => {
    const { domain } = req.params;
    const provider = resolveConnectedRealProvider(domain);
    if (!provider || typeof provider.syncChanges !== 'function') {
      return sendJson(res, 400, { error: `Domain "${domain}" has no real connected provider with syncChanges` });
    }
    try {
      const result = await triggerSync(domain, { db, eventBus });
      sendJson(res, 200, { domain, ...result });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
}

function redirectUriFor(req) {
  const host = req.headers.host || 'localhost:4000';
  return `http://${host}/api/connectors/google/oauth/callback`;
}
