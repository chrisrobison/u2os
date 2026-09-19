import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';
import { readEncryptedFile, writeEncryptedFile } from '../security/vault.js';
import { MockModelProvider } from './mock-model-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';

export function loadModelConfig(dataDir = getDataDir()) {
  try { const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8')); return config.model || { provider: config.modelProvider || 'mock' }; }
  catch { return { provider: 'mock' }; }
}
export function saveModelConfig(model, apiKey, dataDir = getDataDir()) {
  const file = path.join(dataDir, 'config', 'config.json'); let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config.model = model; fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  if (apiKey) writeEncryptedFile('model-openai-compatible', { apiKey }, dataDir);
  return model;
}
export function createModelProvider(dataDir = getDataDir()) {
  const config = loadModelConfig(dataDir);
  if (config.provider === 'mock') return new MockModelProvider();
  if (config.provider !== 'openai-compatible') throw new Error(`Unknown model provider: ${config.provider}`);
  const secret = readEncryptedFile('model-openai-compatible', dataDir);
  return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs, apiKey: secret?.apiKey });
}
