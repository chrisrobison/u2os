import { sendJson } from '../router.js';
import { loadModelConfig, saveModelConfig } from '../../agent/provider-config.js';
import { readEncryptedFile } from '../../security/vault.js';
export function registerModelRoutes(router) {
  router.get('/api/model', async (_req, res) => sendJson(res, 200, { ...loadModelConfig(), apiKeyConfigured: Boolean(readEncryptedFile('model-openai-compatible')?.apiKey) }));
  router.post('/api/model', async (req, res) => {
    const { provider, baseUrl, model, timeoutMs, apiKey } = req.body || {};
    if (!['mock', 'openai-compatible'].includes(provider)) return sendJson(res, 400, { error: 'provider must be mock or openai-compatible' });
    if (provider === 'openai-compatible') {
      if (!baseUrl || !model) return sendJson(res, 400, { error: 'baseUrl and model are required' });
      let url; try { url = new URL(baseUrl); } catch { return sendJson(res, 400, { error: 'baseUrl must be a valid URL' }); }
      if (!['http:', 'https:'].includes(url.protocol)) return sendJson(res, 400, { error: 'baseUrl must use http or https' });
    }
    saveModelConfig({ provider, ...(provider === 'openai-compatible' ? { baseUrl, model, timeoutMs: Number(timeoutMs) || 30000 } : {}) }, apiKey);
    sendJson(res, 200, { configured: true, restartRequired: true, provider });
  });
}
