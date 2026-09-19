import { sendJson } from '../router.js';
import { loadModelConfig, saveModelConfig } from '../../agent/provider-config.js';
import { readEncryptedFile } from '../../security/vault.js';

const PROVIDERS_REQUIRING_MODEL = ['openai-compatible', 'anthropic'];

export function registerModelRoutes(router) {
  router.get('/api/model', async (_req, res) => {
    const config = loadModelConfig();
    const apiKeyConfigured = config.provider && config.provider !== 'mock' ? Boolean(readEncryptedFile(`model-${config.provider}`)?.apiKey) : false;
    sendJson(res, 200, { ...config, apiKeyConfigured });
  });
  router.post('/api/model', async (req, res) => {
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
