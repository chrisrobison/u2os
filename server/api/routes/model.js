import { sendJson } from '../router.js';
import { loadModelConfig, saveModelConfig, saveMultiProviderConfig } from '../../agent/provider-config.js';
import { readEncryptedFile } from '../../security/vault.js';

const PROVIDERS_REQUIRING_MODEL = ['openai-compatible', 'anthropic'];

export function registerModelRoutes(router) {
  router.get('/api/model', async (_req, res) => {
    const config = loadModelConfig();
    const apiKeyConfigured = config.provider && config.provider !== 'mock' ? Boolean(readEncryptedFile(`model-${config.provider}`)?.apiKey) : false;
    sendJson(res, 200, { ...redactSecrets(config), apiKeyConfigured });
  });
  router.post('/api/model', async (req, res) => {
    if (req.body?.providers || req.body?.roles) {
      try {
        const { config, secrets } = validateMultiProvider(req.body);
        saveMultiProviderConfig(config, secrets);
        return sendJson(res, 200, { configured: true, restartRequired: true, mode: 'multi-provider' });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const { provider, baseUrl, model, timeoutMs, apiKey } = req.body || {};
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
    sendJson(res, 200, { configured: true, restartRequired: true, provider });
  });
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
  if (body.fallback && !providers[body.fallback]) throw new Error('fallback references an unknown provider');
  return { config: { providers, roles, ...(body.fallback ? { fallback: body.fallback } : {}) }, secrets };
}
