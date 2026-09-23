import crypto from 'node:crypto';
import { readInstallationMode } from '../../seed/installation-mode.js';
import { sendJson } from '../router.js';
import { getHealth, resolveConnectedRealProvider, resolveInstanceForDomain, getRealProviderModule } from '../../integrations/provider-registry.js';
import {
  setActiveProvider,
  validProviderIdsFor,
  loadConnectorsConfig,
  saveConnectorsConfig,
} from '../../integrations/connectors-config.js';
import { triggerSync, reconcile as reconcileSyncScheduler } from '../../integrations/sync-scheduler.js';
import { manifestsByDomain } from '../../integrations/skill-manifests.js';
import { readEncryptedFile, writeEncryptedFile } from '../../security/vault.js';
import { validateSettings as validateImapSettings } from '../../integrations/imap-provider.js';
import { validateSettings as validateSmtpSettings } from '../../integrations/smtp-transport.js';
import { getConnectorCatalog, providerIdsForConnector } from '../../integrations/connector-catalog.js';
import {
  listInstances,
  listInstanceRows,
  findInstance,
  createConnectionInstance,
  updateConnectionInstance,
  deleteConnectionInstance,
  associateSmtpInstance,
} from '../../integrations/connection-instances.js';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  storeTokens,
  clearTokens,
  GOOGLE_SCOPES,
} from '../../integrations/oauth/google-oauth.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_SERVICES = ['calendar', 'gmail', 'contacts'];
const GOOGLE_PROVIDER_TARGETS = {
  calendar: { domain: 'calendar', providerId: 'google-calendar' },
  gmail: { domain: 'email', providerId: 'gmail' },
  contacts: { domain: 'contacts', providerId: 'google-contacts' },
};

export function activateGoogleProvider(service, dataDir, instanceId) {
  const target = GOOGLE_PROVIDER_TARGETS[service];
  if (!target) throw new Error(`Unknown Google service: ${service}`);
  if (instanceId) {
    const config = loadConnectorsConfig(dataDir);
    config[target.domain] = { ...config[target.domain], active: target.providerId, activeInstanceId: instanceId };
    saveConnectorsConfig(config, dataDir);
  } else {
    setActiveProvider(target.domain, target.providerId, dataDir);
  }
  return target;
}

// In-memory, per-process state cache for CSRF protection on the OAuth
// callback -- per docs/connectors.md's OAuth2 flow step 2/3. Never persisted
// (a restart mid-flow simply invalidates any pending, unfinished connect
// attempt, which is fine).
//
// `instanceId` (issue #163 PR 3 of 5) binds this pending flow to the
// specific `google` connection instance it was started for -- see the
// callback route below for why this is a *distinct* protection from the
// state token's CSRF protection.
const pendingOauthStates = new Map(); // state -> { service, instanceId, expiresAt }

function pruneExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingOauthStates) {
    if (entry.expiresAt <= now) pendingOauthStates.delete(state);
  }
}

// -----------------------------------------------------------------------
// Multiple account instances per connector (issue #163 PR 2 of 5).
// -----------------------------------------------------------------------

// Per-connector credential validation/normalization for the instance CRUD
// routes below, reusing the exact same validators (and the exact same
// friendly error text) the old single-shot credential routes used --
// so multi-instance create/update accepts and rejects exactly what those
// routes always did. `google` is deliberately absent: a google instance is
// OAuth-driven (PR 3 attaches tokens to its vault_key), so it never takes
// credential fields through this CRUD surface.
const CREDENTIAL_VALIDATORS = {
  imap: (merged) => {
    try {
      return validateImapSettings(merged);
    } catch {
      throw new Error('Invalid IMAP settings; use a host, username, app password, and TLS port 993');
    }
  },
  smtp: (merged) => {
    try { return validateSmtpSettings(merged); }
    catch { throw new Error('Invalid SMTP settings; use a host, port 465 or 587, username, app password, and From address'); }
  },
  'brave-search': (merged) => {
    if (!merged.apiKey) throw new Error('apiKey is required');
    return { apiKey: merged.apiKey };
  },
  webhook: (merged) => {
    if (!merged.webhookUrl) throw new Error('webhookUrl is required');
    return { webhookUrl: merged.webhookUrl, format: merged.format === 'ntfy' ? 'ntfy' : 'json' };
  },
};

// The full set of connector ids the instance CRUD routes accept -- the
// credentialed types above, plus google (label-only; see CREDENTIAL_VALIDATORS'
// comment). Every other catalog id (including smtp, and every 'planned'
// connector) is
// rejected with a 400 rather than silently creating an unusable row.
const INSTANCE_CONNECTOR_IDS = new Set(['google', ...Object.keys(CREDENTIAL_VALIDATORS)]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function googleClientCredentials(db) {
  const shared = readEncryptedFile('google');
  if (shared?.clientId && shared?.clientSecret) return shared;
  // Upgraded installations may have moved the old combined file to the
  // migrated instance vault before shared client configuration existed.
  for (const instance of listInstanceRows(db, 'google')) {
    const migrated = readEncryptedFile(instance.vault_key);
    if (migrated?.clientId && migrated?.clientSecret) return migrated;
  }
  return shared || {};
}

/** Every request-body field except `label` is treated as a credential field
 * for create/update -- connector-specific validators above decide which of
 * them are actually meaningful. */
function credentialFieldsFromBody(body) {
  const { label, ...rest } = body || {};
  return rest;
}

/** If this instance was the activeInstanceId for any connectors.yaml domain,
 * resets that domain to { active: 'mock', activeInstanceId: null } --
 * deliberately never auto-switches to another remaining instance of the
 * same connector, so deleting one account never silently changes which
 * account's data the agent is reading from. Returns the list of domains
 * that were reset (empty if none), so the caller knows whether a
 * sync-scheduler reconcile is warranted. */
function resetActiveInstanceReferences(instanceId, dataDir) {
  const config = loadConnectorsConfig(dataDir);
  const domains = Object.keys(config).filter((domain) => config[domain]?.activeInstanceId === instanceId);
  if (domains.length) {
    for (const domain of domains) {
      config[domain] = { ...config[domain], active: 'mock', activeInstanceId: null };
    }
    saveConnectorsConfig(config, dataDir);
  }
  return domains;
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
    const smtpConfigured = listInstanceRows(db, 'smtp').some((row) => {
      try { return row.status === 'connected' && Boolean(validateSmtpSettings(readEncryptedFile(row.vault_key))); }
      catch { return false; }
    });
    sendJson(res, 200, { connectors: enriched, smtpConfigured, catalog: getConnectorCatalog() });
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
    // issue #163 PR 3: every OAuth flow must be bound to a specific `google`
    // connection instance up front -- required and validated BEFORE any
    // CSRF state token is minted, so a state token can never exist for a
    // missing or already-deleted instance.
    const { instanceId } = req.query;
    if (!isNonEmptyString(instanceId)) {
      return sendJson(res, 400, { error: 'instanceId is required' });
    }
    if (!findInstance(db, 'google', instanceId)) {
      return sendJson(res, 404, { error: 'Not Found' });
    }
    const stored = googleClientCredentials(db);
    if (!stored?.clientId) {
      return sendJson(res, 400, { error: 'Google OAuth client credentials are not configured yet' });
    }
    pruneExpiredStates();
    const state = crypto.randomBytes(24).toString('hex');
    pendingOauthStates.set(state, { service, instanceId, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });

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

    const { service, instanceId } = entry;
    // SECURITY (instance-confusion protection -- additional to, and
    // distinct from, the CSRF protection above): `state` being unguessable,
    // single-use, and TTL-bound already prevents a forged or replayed
    // callback from any origin. This additionally prevents a *valid,
    // non-forged* callback -- e.g. two legitimate concurrent OAuth flows for
    // two different google accounts -- from ever writing tokens to the
    // wrong instance: the callback has no way to attach tokens to any
    // instance other than the one this `state` token was minted for back in
    // /oauth/start, and it re-validates that instance still exists (it may
    // have been soft-deleted by a concurrent request mid-flow) before ever
    // exchanging the code or writing anything to the vault.
    try {
      const instance = findInstance(db, 'google', instanceId);
      if (!instance) {
        throw new Error(`connection instance "${instanceId}" no longer exists`);
      }
      const stored = googleClientCredentials(db);
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
      // issue #163 PR 4: gmail-provider.js/google-calendar-provider.js/
      // google-contacts-provider.js are now instance-aware -- tokens live
      // ONLY at instance.vault_key, resolved per domain by
      // provider-registry.js's getProvider()/resolveConnectedRealProvider().
      // The bare 'google' vault key is no longer read by any provider
      // module for tokens (it still stores the shared OAuth client id/
      // secret, which is not per-instance -- see the /google/credentials
      // route above), so the mirror write PR 3 left here as a stopgap is no
      // longer needed and has been removed.
      storeTokens(instance.vault_key, service, tokens);
      db.prepare('UPDATE connection_instances SET status = ?, credential_revision = credential_revision + 1, updated_at = ? WHERE id = ?').run('connected', new Date().toISOString(), instanceId);
      activateGoogleProvider(service, undefined, instanceId);
      reconcileSyncScheduler({ db, eventBus });
      res.writeHead(302, { Location: `/#/connectors?connected=${encodeURIComponent(service)}` });
      res.end();
    } catch (err) {
      // SECURITY: never include token/credential values in this message.
      console.error(`[connectors] google oauth callback failed for service "${service}"`, err.message);
      res.writeHead(302, { Location: `/#/connectors?error=${encodeURIComponent('connect_failed')}` });
      res.end();
    }
  }, { public: true });

  router.post('/api/connectors/google/disconnect', async (req, res) => {
    const service = req.query.service;
    if (!GOOGLE_SERVICES.includes(service)) {
      return sendJson(res, 400, { error: `service must be one of ${GOOGLE_SERVICES.join(', ')}` });
    }
    // Domain-level disconnect: clears whichever instance is currently
    // resolved as the domain's active instance for this service (falling
    // back to the connector's sole connected instance when no explicit
    // activeInstanceId is set -- see resolveInstanceForDomain()). Since PR 4,
    // provider modules read tokens from a resolved connection instance's own
    // vault_key, not the bare 'google' key -- so this route must resolve the
    // SAME instance provider-registry.js would resolve for this service's
    // domain and clear tokens there (a caught regression: clearing only the
    // legacy 'google' key silently disconnected nothing a provider actually
    // reads, while still reporting success). The legacy key is also cleared
    // for good measure (harmless if already empty).
    //
    // For disconnecting one SPECIFIC google account's service in a
    // multi-account world (the setup dialog's per-account-row action, which
    // may not be the domain's currently active instance), see the
    // instance-scoped route below instead.
    const target = GOOGLE_PROVIDER_TARGETS[service];
    const config = loadConnectorsConfig();
    const instance = resolveInstanceForDomain(target.providerId, config[target.domain]?.activeInstanceId);
    if (instance) {
      clearTokens(instance.vault_key, service);
      db.prepare('UPDATE connection_instances SET credential_revision = credential_revision + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), instance.id);
    }
    clearTokens('google', service);
    reconcileSyncScheduler({ db, eventBus });
    sendJson(res, 200, { disconnected: service });
  });

  // Instance-scoped counterpart to the route above (issue #163 PR 5): the
  // multi-account setup dialog shows every google account's per-service
  // connect/disconnect state independently, so disconnecting one account's
  // Gmail must never depend on -- or accidentally touch -- whichever
  // instance happens to be the email domain's current active one. Clears
  // tokens straight at this instance's own vault_key.
  router.post('/api/connectors/google/instances/:instanceId/disconnect', async (req, res) => {
    const { instanceId } = req.params;
    const service = req.query.service;
    if (!GOOGLE_SERVICES.includes(service)) {
      return sendJson(res, 400, { error: `service must be one of ${GOOGLE_SERVICES.join(', ')}` });
    }
    const instance = findInstance(db, 'google', instanceId);
    if (!instance) return sendJson(res, 404, { error: 'Not Found' });
    clearTokens(instance.vault_key, service);
    const stillConnected = GOOGLE_SERVICES.some((candidate) => {
      const mod = getRealProviderModule(GOOGLE_PROVIDER_TARGETS[candidate].providerId);
      return mod?.isConnected?.(instance.vault_key);
    });
    db.prepare('UPDATE connection_instances SET status = ?, credential_revision = credential_revision + 1, updated_at = ? WHERE id = ?')
      .run(stillConnected ? 'connected' : 'pending', new Date().toISOString(), instanceId);
    const target = GOOGLE_PROVIDER_TARGETS[service];
    const config = loadConnectorsConfig();
    if (config[target.domain]?.activeInstanceId === instanceId) {
      config[target.domain] = { ...config[target.domain], active: 'mock', activeInstanceId: null };
      saveConnectorsConfig(config);
    }
    reconcileSyncScheduler({ db, eventBus });
    sendJson(res, 200, { disconnected: service });
  });

  // The former global SMTP endpoint must not create a sender invisible to
  // instance pairing. Give old clients an actionable migration error.
  router.post('/api/connectors/smtp/settings', async (_req, res) => {
    sendJson(res, 410, { error: 'Create or update a named SMTP account in Connectors' });
  });
  router.post('/api/connectors/smtp/settings/clear', async (_req, res) => {
    sendJson(res, 410, { error: 'Remove the intended named SMTP account in Connectors' });
  });

  // --- Connection instances: multiple accounts per connector (#163 PR 2) --

  // GET never touches the vault -- listInstances() is a pure
  // connection_instances read, so it is structurally impossible for a
  // secret to leak from this route. For 'google' specifically, this also
  // enriches each instance with a `services` map ({calendar, gmail,
  // contacts} -> boolean) so the multi-account setup dialog (issue #163 PR 5)
  // can render each account's per-service connect/disconnect state
  // independently -- computed via each real provider module's isConnected()
  // (a boolean-only check against the instance's own vault_key), never by
  // reading or returning any decrypted token value.
  router.get('/api/connectors/:connectorId/instances', async (req, res) => {
    const { connectorId } = req.params;
    const instances = listInstances(db, connectorId);
    if (connectorId === 'google') {
      const rowsById = new Map(listInstanceRows(db, connectorId).map((row) => [row.id, row]));
      for (const instance of instances) {
        const row = rowsById.get(instance.id);
        instance.services = {};
        for (const service of GOOGLE_SERVICES) {
          const providerId = GOOGLE_PROVIDER_TARGETS[service].providerId;
          const mod = getRealProviderModule(providerId);
          instance.services[service] = Boolean(row && mod?.isConnected?.(row.vault_key));
        }
      }
    }
    sendJson(res, 200, { instances });
  });

  router.post('/api/connectors/:connectorId/instances', async (req, res) => {
    const { connectorId } = req.params;
    if (!INSTANCE_CONNECTOR_IDS.has(connectorId)) {
      return sendJson(res, 400, { error: `Unknown or unavailable connector "${connectorId}"` });
    }
    const { label } = req.body || {};
    if (!isNonEmptyString(label)) {
      return sendJson(res, 400, { error: 'label is required' });
    }
    const credentialFields = credentialFieldsFromBody(req.body);

    if (connectorId === 'google') {
      // OAuth-driven: no credentials at creation time -- a later OAuth
      // connect (issue #163 PR 3) attaches tokens to this instance's
      // vault_key. Reject credential-shaped fields outright rather than
      // silently ignoring them.
      if (Object.keys(credentialFields).length) {
        return sendJson(res, 400, { error: 'google instances are connected via OAuth; pass only a label here' });
      }
      const instance = createConnectionInstance(db, { connectorId, label: label.trim(), credentials: null, status: 'pending' });
      return sendJson(res, 201, instance);
    }

    try {
      const credentials = CREDENTIAL_VALIDATORS[connectorId](credentialFields);
      const instance = createConnectionInstance(db, { connectorId, label: label.trim(), credentials, status: 'connected' });
      sendJson(res, 201, instance);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.patch('/api/connectors/:connectorId/instances/:instanceId', async (req, res) => {
    const { connectorId, instanceId } = req.params;
    // findInstance scopes on id AND connector_id AND deleted_at IS NULL in
    // one query -- a mismatched connectorId/instanceId pair, or a
    // soft-deleted instance, both resolve to "not found" here rather than
    // silently operating on the wrong instance.
    const row = findInstance(db, connectorId, instanceId);
    if (!row) return sendJson(res, 404, { error: 'Not Found' });

    const { label, ...credentialFields } = req.body || {};
    if (label !== undefined && !isNonEmptyString(label)) {
      return sendJson(res, 400, { error: 'label must be a non-empty string' });
    }
    const hasCredentialFields = Object.keys(credentialFields).length > 0;
    if (hasCredentialFields && connectorId === 'google') {
      return sendJson(res, 400, { error: 'google instances are connected via OAuth; pass only a label here' });
    }

    try {
      let credentials;
      if (hasCredentialFields) {
        // Read-merge-validate: a PATCH may send only a subset of credential
        // fields (e.g. just a new password), so merge onto whatever is
        // already stored before re-validating the full shape.
        const current = readEncryptedFile(row.vault_key) || {};
        credentials = CREDENTIAL_VALIDATORS[connectorId]({ ...current, ...credentialFields });
      }
      const updated = updateConnectionInstance(db, {
        row,
        label: label !== undefined ? label.trim() : undefined,
        credentials,
      });
      sendJson(res, 200, updated);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.patch('/api/connectors/imap/instances/:instanceId/smtp', async (req, res) => {
    const imap = findInstance(db, 'imap', req.params.instanceId);
    if (!imap) return sendJson(res, 404, { error: 'IMAP account not found' });
    const smtpInstanceId = req.body?.smtpInstanceId;
    const smtp = typeof smtpInstanceId === 'string' ? findInstance(db, 'smtp', smtpInstanceId) : null;
    if (smtpInstanceId !== null && (!smtp || smtp.status !== 'connected')) {
      return sendJson(res, 400, { error: 'Select a connected SMTP account or clear the association' });
    }
    const updated = associateSmtpInstance(db, { imapRow: imap, smtpInstanceId });
    sendJson(res, 200, updated);
  });

  router.delete('/api/connectors/:connectorId/instances/:instanceId', async (req, res) => {
    const { connectorId, instanceId } = req.params;
    const row = findInstance(db, connectorId, instanceId);
    if (!row) return sendJson(res, 404, { error: 'Not Found' });

    const deleted = deleteConnectionInstance(db, { row });
    // Explicit design decision (issue #163): never silently switch to
    // another remaining instance of the same connector -- reset to mock
    // instead, so which account's data the agent reads from never changes
    // without an explicit owner action.
    const resetDomains = resetActiveInstanceReferences(instanceId);
    if (resetDomains.length) {
      reconcileSyncScheduler({ db, eventBus });
    }
    sendJson(res, 200, { deleted: true, ...deleted });
  });

  router.post('/api/connectors/:domain/active', async (req, res) => {
    const { domain } = req.params;
    const { providerId, connectorId, instanceId } = req.body || {};
    if (providerId === 'mock' && readInstallationMode() !== 'demo') {
      return sendJson(res, 400, { error: 'Mock providers are available only in an isolated demo home; connect a real account' });
    }

    if (connectorId !== undefined || instanceId !== undefined) {
      // Instance-aware path (#163 PR 2): sets `active` and
      // `activeInstanceId` atomically, only after providerId/connectorId/
      // instanceId are fully validated as mutually consistent -- the
      // parent issue's "provider routing atomicity" requirement. Any
      // inconsistent pair is rejected outright rather than resolved to
      // "closest guess".
      if (!connectorId || !instanceId || !providerId) {
        return sendJson(res, 400, { error: 'connectorId, instanceId, and providerId are all required together' });
      }
      const validIds = validProviderIdsFor(domain);
      if (!validIds.includes(providerId)) {
        return sendJson(res, 400, { error: `Unknown provider "${providerId}" for domain "${domain}"`, validProviders: validIds });
      }
      if (!providerIdsForConnector(connectorId).has(providerId)) {
        return sendJson(res, 400, { error: `Provider "${providerId}" does not belong to connector "${connectorId}"` });
      }
      const instance = findInstance(db, connectorId, instanceId);
      if (!instance) {
        return sendJson(res, 400, { error: `No connected instance "${instanceId}" for connector "${connectorId}"` });
      }
      const real = getRealProviderModule(providerId);
      if (!real?.isConnected?.(instance.vault_key)) {
        return sendJson(res, 400, { error: `Account "${instance.label}" is disconnected for "${providerId}"` });
      }
      const config = loadConnectorsConfig();
      config[domain] = { ...config[domain], active: providerId, activeInstanceId: instanceId };
      saveConnectorsConfig(config);
      reconcileSyncScheduler({ db, eventBus });
      return sendJson(res, 200, { domain, active: providerId, activeInstanceId: instanceId });
    }

    try {
      const validIds = validProviderIdsFor(domain);
      if (!validIds.includes(providerId)) throw new Error(`Unknown provider "${providerId}" for domain "${domain}"`);
      let activeInstanceId = null;
      if (providerId !== 'mock') {
        const instance = resolveInstanceForDomain(providerId, null);
        if (!instance) throw new Error(`Choose a connected account for "${providerId}" explicitly`);
        activeInstanceId = instance.id;
      }
      const config = loadConnectorsConfig();
      config[domain] = { ...config[domain], active: providerId, activeInstanceId };
      saveConnectorsConfig(config);
      reconcileSyncScheduler({ db, eventBus });
      sendJson(res, 200, { domain, active: providerId, activeInstanceId });
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
