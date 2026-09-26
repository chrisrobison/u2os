import { sendJson } from '../router.js';
import { loadModelConfig, saveModelConfig, saveMultiProviderConfig } from '../../agent/provider-config.js';
import { readEncryptedFile } from '../../security/vault.js';
import { readInstallationMode } from '../../seed/installation-mode.js';
import { createHash } from 'node:crypto';

const PROVIDERS_REQUIRING_MODEL = ['openai-compatible', 'anthropic'];

export function registerModelRoutes(router, { modelRouter } = {}) {
  const initialConfig = loadModelConfig();
  const initialRevision = configurationRevision(initialConfig);
  const demo = readInstallationMode() === 'demo';
  const runtimePlannerStatus = plannerStatus(modelRouter?.config || initialConfig, demo);
  let savedSinceStart = false;
  router.get('/api/model', async (_req, res) => {
    const config = loadModelConfig();
    const apiKeyConfigured = config.provider && config.provider !== 'mock' ? Boolean(readEncryptedFile(`model-${config.provider}`)?.apiKey) : false;
    const revision = configurationRevision(config);
    sendJson(res, 200, { ...redactSecrets(config), apiKeyConfigured, plannerStatus: plannerStatus(config, demo), runtimePlannerStatus,
      restartRequired: savedSinceStart || revision !== initialRevision, configurationRevision: revision });
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
        savedSinceStart = true;
        return sendJson(res, 200, { configured: true, restartRequired: true, mode: 'multi-provider' });
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
    savedSinceStart = true;
    sendJson(res, 200, { configured: true, restartRequired: true, provider });
  });
}

function plannerStatus(config, demo) {
  const name = config.roles?.planner || config.roles?.default || config.fallback || (!config.roles && Object.keys(config.providers || {})[0]);
  const planner = config.providers ? config.providers[name]?.type : config.provider;
  const mock = planner === 'mock' || planner === 'mock-embedding';
  return !planner || planner === 'embedding-openai-compatible' || mock && !demo ? 'configuration-required' : mock ? 'demo' : 'configured';
}

function configurationRevision(config) {
  return createHash('sha256').update(JSON.stringify(redactSecrets(config))).digest('hex');
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/api[-_]?key|secret|token/i.test(key)).map(([key, child]) => [key, redactSecrets(child)]));
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
