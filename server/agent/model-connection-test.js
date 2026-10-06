// "Test connection" for the model page. Never returns raw error text, response
// bodies or keys: failures are reduced to the fixed vocabulary of
// model-failure.js.
import { classifyModelFailure } from './model-failure.js';

const API_TIMEOUT_MS = 5000;

/**
 * @param {object} provider  an instantiated ModelProvider
 * @param {object} config    its stored connection config (with apiKey resolved)
 * @param {{ sendPrompt?: boolean, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, stage?: string, reason?: string, detail?: string, version?: string, modelFound?: boolean }>}
 */
export async function testConnection(provider, config, { sendPrompt = false, fetchImpl = fetch } = {}) {
  if (config.type === 'cli') {
    const probe = await provider.probe();
    if (!probe.available) return { ok: false, stage: 'install', reason: 'not_installed', detail: probe.reason };
    if (!sendPrompt) return { ok: true, stage: 'install', version: probe.version, detail: 'Installed. Send a test prompt to check you are signed in.' };
    try { await provider.ping(); return { ok: true, stage: 'prompt', version: probe.version, detail: 'The tool answered a test prompt.' }; }
    catch (error) { const failure = classifyModelFailure(error); return { ok: false, stage: 'prompt', reason: failure.code, detail: `${failure.text}. Run the tool once in a terminal as the account that runs U2OS to check its sign-in.`, version: probe.version }; }
  }
  const base = String(config.baseUrl || (config.type === 'anthropic' ? 'https://api.anthropic.com' : '')).replace(/\/$/, '');
  const headers = config.type === 'anthropic'
    ? { 'x-api-key': config.apiKey || '', 'anthropic-version': '2023-06-01' }
    : (config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {});
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${base}/v1/models`, { headers, signal: controller.signal });
    if (!response.ok) { const failure = classifyModelFailure(new Error(`HTTP ${response.status}`)); return { ok: false, stage: 'reach', reason: failure.code, detail: failure.text }; }
    let modelFound;
    try {
      const body = await response.json();
      const ids = (body?.data || []).map((m) => m?.id).filter((id) => typeof id === 'string');
      if (ids.length) modelFound = ids.includes(config.model);
    } catch { /* model listing is optional */ }
    return { ok: true, stage: 'reach', ...(modelFound === undefined ? {} : { modelFound }), detail: modelFound === false ? 'Reachable, but the endpoint does not list the configured model name.' : 'Reachable.' };
  } catch (error) {
    const failure = classifyModelFailure(error.name === 'AbortError' ? new Error('timed out') : error);
    return { ok: false, stage: 'reach', reason: failure.code, detail: failure.text };
  } finally { clearTimeout(timer); }
}
