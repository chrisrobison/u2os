import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';
import { readEncryptedFile, writeEncryptedFile } from '../security/vault.js';
import { MockModelProvider } from './mock-model-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { ModelRouter } from './model-router.js';
import { readInstallationMode } from '../seed/installation-mode.js';

const SINGLE_PROVIDER_TYPES = ['mock', 'openai-compatible', 'anthropic'];

export function loadModelConfig(dataDir = getDataDir()) {
  try { const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8')); return config.model || { provider: config.modelProvider || 'mock' }; }
  catch { return { provider: 'mock' }; }
}
export function saveModelConfig(model, apiKey, dataDir = getDataDir()) {
  const file = path.join(dataDir, 'config', 'config.json'); let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config.model = model; fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  if (apiKey && model?.provider) writeEncryptedFile(`model-${model.provider}`, { apiKey }, dataDir);
  return model;
}

export function saveMultiProviderConfig(model, secrets = {}, dataDir = getDataDir()) {
  const file = path.join(dataDir, 'config', 'config.json'); let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config.model = model;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  for (const [name, apiKey] of Object.entries(secrets)) {
    if (apiKey) writeEncryptedFile(`model-provider-${model.providers[name].apiKeyRef || name}`, { apiKey }, dataDir);
  }
  return model;
}
export function createModelProvider(dataDir = getDataDir()) {
  const config = loadModelConfig(dataDir);
  if (readInstallationMode(dataDir) !== 'demo' && config.provider === 'mock') throw modelUnavailable();
  return instantiateSingleProvider(config, dataDir);
}

function modelUnavailable() {
  const error = new Error('Planner unavailable: configure a local or remote model for personal mode, then restart U2OS');
  error.code = 'MODEL_UNAVAILABLE';
  error.status = 503;
  return error;
}

function instantiateSingleProvider(config, dataDir) {
  if (config.provider === 'mock') return new MockModelProvider();
  if (!SINGLE_PROVIDER_TYPES.includes(config.provider)) throw new Error(`Unknown model provider: ${config.provider}`);
  // SECURITY: vault key is derived from the provider TYPE, never from a
  // caller-supplied name -- this is server-side config, not model/user
  // input, so there's no injection concern, but it keeps one credential
  // file per provider type instead of silently overwriting a different
  // provider's secret (a real bug in the pre-router single-key version of
  // this function, which always read/wrote 'model-openai-compatible'
  // regardless of the configured provider).
  const secret = readEncryptedFile(`model-${config.provider}`, dataDir);
  if (config.provider === 'openai-compatible') {
    return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs, apiKey: secret?.apiKey });
  }
  return new AnthropicProvider({ model: config.model, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, apiKey: secret?.apiKey });
}

/**
 * Builds a ModelRouter for role-based provider selection (planner,
 * classifier, summarizer, extractor, response, embeddings -- see
 * model-router.js). This is the entry point server/index.js uses; it
 * subsumes createModelProvider() by normalizing the same legacy
 * single-provider config into a one-provider-for-every-role router when no
 * multi-provider `roles` config is present, so every existing installation
 * keeps working with zero config changes.
 *
 * A multi-provider role config is opt-in and may be written through
 * POST /api/model or directly in config.json (see docs/models.md):
 *
 *   {
 *     "model": {
 *       "providers": {
 *         "local-planner": { "type": "openai-compatible", "baseUrl": "...", "model": "..." },
 *         "hosted":        { "type": "anthropic", "model": "...", "apiKeyRef": "hosted" }
 *       },
 *       "roles": { "planner": "local-planner", "classifier": "local-planner" },
 *       "fallback": "hosted"
 *     }
 *   }
 *
 * Each non-mock provider's API key is read from the vault under
 * `model-provider-<apiKeyRef || providerName>`; the legacy single-provider
 * shape keeps using `model-<providerType>` for backward compatibility.
 */
export function createModelRouter(dataDir = getDataDir()) {
  const config = loadModelConfig(dataDir);
  const allowMock = readInstallationMode(dataDir) === 'demo';

  if (!config.providers) {
    const secret = config.provider && config.provider !== 'mock' ? readEncryptedFile(`model-${config.provider}`, dataDir) : null;
    return new ModelRouter({ ...config, apiKey: secret?.apiKey }, { allowMock });
  }

  const providers = {};
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.type === 'mock') {
      providers[name] = providerConfig;
      continue;
    }
    const secret = readEncryptedFile(`model-provider-${providerConfig.apiKeyRef || name}`, dataDir);
    providers[name] = { ...providerConfig, apiKey: secret?.apiKey };
  }
  return new ModelRouter({ providers, roles: config.roles, fallback: config.fallback }, { allowMock });
}
