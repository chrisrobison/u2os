import { sendJson } from '../router.js';
import { loadModelConfig, saveModelConfig, saveMultiProviderConfig, reloadModelRouter, loadConnectionProvider } from '../../agent/provider-config.js';
import { describeConnections, buildConfigFromConnections } from '../../agent/model-connections.js';
import { testConnection } from '../../agent/model-connection-test.js';
import { CLI_PRESETS } from '../../agent/cli-model-provider.js';
import { readEncryptedFile } from '../../security/vault.js';
import { readInstallationMode } from '../../seed/installation-mode.js';
import { createHash } from 'node:crypto';

const PROVIDERS_REQUIRING_MODEL = ['openai-compatible', 'anthropic'];

export function registerModelRoutes(router, { modelRouter } = {}) {
  const initialConfig = loadModelConfig();
  // Revision of the config the running router is using. A save hot-reloads the
  // router and advances it; only a save the router could not adopt leaves the
  // server needing a restart. (Without a router, e.g. a bare test harness,
  // every save still requires one.)
  let runningRevision = configurationRevision(initialConfig);
  let pendingRestart = false;
  const demo = readInstallationMode() === 'demo';
  // Adopts what was just saved. Returns true when the running planner now uses
  // it. On failure the previous router keeps serving and the owner is told the
  // truth via restartRequired.
  const adoptSaved = () => {
    if (!modelRouter?.reload) { pendingRestart = true; return false; }
    try {
      reloadModelRouter(modelRouter);
      runningRevision = configurationRevision(loadModelConfig());
      pendingRestart = false;
      return true;
    } catch (error) {
      console.error(`[model] saved configuration could not be hot-reloaded: ${error?.message || error}`);
      pendingRestart = true;
      return false;
    }
  };
  router.get('/api/model', async (_req, res) => {
    const config = loadModelConfig();
    const apiKeyConfigured = config.provider && config.provider !== 'mock' ? Boolean(readEncryptedFile(`model-${config.provider}`)?.apiKey) : false;
    const revision = configurationRevision(config);
    sendJson(res, 200, { ...redactSecrets(config), apiKeyConfigured, connections: describeConnections(config), cliPresets: Object.fromEntries(Object.entries(CLI_PRESETS).map(([id, p]) => [id, { label: p.label, executable: p.executable }])), plannerStatus: plannerStatus(config, demo),
      runtimePlannerStatus: plannerStatus(modelRouter?.config || initialConfig, demo),
      restartRequired: pendingRestart || revision !== runningRevision, configurationRevision: revision });
  });
  // Ordered list of API and CLI connections (see docs/models.md). The first
  // working entry plans; later ones are tried in turn when it fails.
  router.put('/api/model/connections', async (req, res) => {
    if (req.body?.configurationRevision !== undefined && req.body.configurationRevision !== configurationRevision(loadModelConfig())) {
      return sendJson(res, 409, { error: 'Model configuration changed. Reload its current configuration before saving.' });
    }
    try {
      const existing = loadModelConfig();
      const { config, secrets } = buildConfigFromConnections(req.body?.connections, existing.providers ? existing : {});
      // A legacy single-provider config keeps its key under model-<type>; carry it over to the connection that replaces it.
      if (!existing.providers && existing.provider && config.providers.default?.type === existing.provider && !secrets.default) {
        const legacy = readEncryptedFile(`model-${existing.provider}`)?.apiKey;
        if (legacy) secrets.default = legacy;
      }
      saveMultiProviderConfig(config, secrets);
      const reloaded = adoptSaved();
      sendJson(res, 200, { configured: true, reloaded, restartRequired: !reloaded, connections: describeConnections(config) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
  const testing = new Set();
  router.post('/api/model/connections/test', async (req, res) => {
    const id = req.body?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return sendJson(res, 400, { error: 'id is required' });
    if (testing.has(id)) return sendJson(res, 409, { error: 'A test of this connection is already running' });
    testing.add(id);
    try {
      let loaded;
      try { loaded = loadConnectionProvider(id); } catch { loaded = null; }
      if (!loaded) return sendJson(res, 404, { error: 'No saved connection with that name. Save it first, then test.' });
      const result = await testConnection(loaded.provider, loaded.providerConfig, { sendPrompt: req.body?.sendPrompt === true });
      sendJson(res, 200, result);
    } finally { testing.delete(id); }
  });
  router.post('/api/model', async (req, res) => {
    // Optional optimistic concurrency for owner setup forms. No model or vault
    // mutation occurs before this synchronous comparison; legacy callers retain
    // their existing unconditional API contract. Revision excludes secret values.
    if (req.body?.configurationRevision !== undefined && req.body.configurationRevision !== configurationRevision(loadModelConfig())) {
      return sendJson(res, 409, { error: 'Model configuration changed. Reload its current configuration before saving.' });
    }
    if (req.body?.providers || req.body?.roles) {
      try {
        const { config, secrets } = validateMultiProvider(req.body);
        saveMultiProviderConfig(config, secrets);
        const reloaded = adoptSaved();
        return sendJson(res, 200, { configured: true, reloaded, restartRequired: !reloaded, mode: 'multi-provider' });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const { provider, baseUrl, model, timeoutMs, apiKey } = req.body || {};
    if (provider === 'mock' && readInstallationMode() !== 'demo') {
      return sendJson(res, 400, { error: 'Mock models are available only in an isolated demo home; configure a local or remote model' });
    }
    if (!['mock', ...PROVIDERS_REQUIRING_MODEL].includes(provider)) {
      return sendJson(res, 400, { error: `provider must be one of: mock, ${PROVIDERS_REQUIRING_MODEL.join(', ')}` });
    }
    if (PROVIDERS_REQUIRING_MODEL.includes(provider)) {
      if (!model) return sendJson(res, 400, { error: 'model is required' });
      // Anthropic's hosted API has a fixed default base URL; only the
      // OpenAI-compatible provider requires the caller to supply one
      // (there's no single default that would make sense across Ollama,
      // llama.cpp, LM Studio, and hosted OpenAI-compatible endpoints).
      if (provider === 'openai-compatible') {
        if (!baseUrl) return sendJson(res, 400, { error: 'baseUrl is required' });
      }
      if (baseUrl) {
        let url;
        try { url = new URL(baseUrl); } catch { return sendJson(res, 400, { error: 'baseUrl must be a valid URL' }); }
        if (!['http:', 'https:'].includes(url.protocol)) return sendJson(res, 400, { error: 'baseUrl must use http or https' });
      }
    }
    saveModelConfig(
      { provider, ...(PROVIDERS_REQUIRING_MODEL.includes(provider) ? { baseUrl, model, timeoutMs: Number(timeoutMs) || 30000 } : {}) },
      apiKey
    );
    const reloaded = adoptSaved();
    sendJson(res, 200, { configured: true, reloaded, restartRequired: !reloaded, provider });
  });
}

function plannerStatus(config, demo) {
  const name = config.roles?.planner || config.roles?.default || config.fallback || (!config.roles && Object.keys(config.providers || {})[0]);
  const planner = config.providers ? config.providers[name]?.type : config.provider;
  const mock = planner === 'mock' || planner === 'mock-embedding';
  return !planner || planner === 'embedding-openai-compatible' || mock && !demo ? 'configuration-required' : mock ? 'demo' : 'configured';
}

function configurationRevision(config) {
  return createHash('sha256').update(JSON.stringify(redactSecrets(config, true))).digest('hex');
}

function redactSecrets(value, forRevision = false) {
  if (Array.isArray(value)) return value.map((child) => redactSecrets(child, forRevision));
  if (!value || typeof value !== 'object') return value;
  // apiKeyRef selects an existing vault entry, rather than containing a key.
  // Keep it in the opaque revision, but preserve its omission from API output.
  return Object.fromEntries(Object.entries(value).filter(([key]) => forRevision && key === 'apiKeyRef' || !/api[-_]?key|secret|token/i.test(key))
    .map(([key, child]) => [key, redactSecrets(child, forRevision)]));
}

function validateMultiProvider(body) {
  if (!body.providers || typeof body.providers !== 'object' || Array.isArray(body.providers)) throw new Error('providers must be an object');
  if (!body.roles || typeof body.roles !== 'object' || Array.isArray(body.roles)) throw new Error('roles must be an object');
  const providers = {}; const secrets = {};
  const allowedTypes = new Set(['mock', 'openai-compatible', 'anthropic', 'embedding-openai-compatible']);
  for (const [name, raw] of Object.entries(body.providers)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid provider name: ${name}`);
    if (!raw || !allowedTypes.has(raw.type)) throw new Error(`Invalid provider type for ${name}`);
    if (raw.type === 'mock' && readInstallationMode() !== 'demo') throw new Error('Mock models are available only in an isolated demo home');
    if (raw.type !== 'mock' && !raw.model) throw new Error(`model is required for provider ${name}`);
    if (['openai-compatible', 'embedding-openai-compatible'].includes(raw.type) && !raw.baseUrl) throw new Error(`baseUrl is required for provider ${name}`);
    if (raw.baseUrl) {
      let url; try { url = new URL(raw.baseUrl); } catch { throw new Error(`Invalid baseUrl for provider ${name}`); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid baseUrl protocol for provider ${name}`);
    }
    const { apiKey, ...safe } = raw;
    providers[name] = safe;
    if (apiKey) secrets[name] = apiKey;
  }
  const roles = {};
  for (const [role, providerName] of Object.entries(body.roles)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(role) || !providers[providerName]) throw new Error(`Role ${role} references an unknown provider`);
    roles[role] = providerName;
  }
  if (!roles.planner) throw new Error('roles.planner is required');
  if (providers[roles.planner].type === 'embedding-openai-compatible') throw new Error('roles.planner must reference a planning model');
  if (body.fallback && !providers[body.fallback]) throw new Error('fallback references an unknown provider');
  return { config: { providers, roles, ...(body.fallback ? { fallback: body.fallback } : {}) }, secrets };
}
