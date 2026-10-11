import { createModelRouter } from '../agent/provider-config.js';
import { readEncryptedFile } from '../security/vault.js';
import { createLlm } from '../../mcp/jobs/hunt/llm/structured.js';
import { LMSTUDIO_SECRET, loadModelsConfig } from '../../mcp/jobs/hunt/llm/models.js';
import { LmStudioProvider } from '../agent/lmstudio-provider.js';

/**
 * The quality model: the owner's configured connections, in the owner's
 * order (so Claude first and Codex as the backup, say). Only connections that
 * can complete plain text are used (CLI tools); API connections that only
 * plan are skipped. Returns an `llm` with `available: false` when none can.
 */
export function createJobLlm({ dataDir, router = null, lastResort = [] } = {}) {
  let providers = [];
  try {
    const modelRouter = router ?? createModelRouter(dataDir);
    const chain = [modelRouter.resolve('planner'), ...modelRouter.resolveFallbacks('planner')];
    providers = chain.filter((provider) => typeof provider?.complete === 'function')
      .map((provider) => ({ id: provider.id, complete: (system, user) => provider.complete(system, user) }));
  } catch { providers = []; }
  return createLlm([...providers, ...lastResort]);
}

/**
 * The local first-pass model from job-hunt/models.yaml, or null when none is
 * configured. Its availability is checked with probe() by the caller.
 */
function localProvider({ vaultDir, dataDir, fetchImpl = globalThis.fetch }) {
  const config = loadModelsConfig(vaultDir).fast;
  if (!config) return null;
  let apiKey = null;
  try { apiKey = readEncryptedFile(LMSTUDIO_SECRET, dataDir)?.apiKey ?? null; } catch { apiKey = null; }
  return new LmStudioProvider({ baseUrl: config.base_url, model: config.model, apiKey, reasoning: config.reasoning, maxOutputTokens: config.max_output_tokens, timeoutMs: config.timeout_seconds * 1000, fetchImpl });
}

export function createFastLlm({ vaultDir, dataDir, fetchImpl = globalThis.fetch } = {}) {
  const provider = localProvider({ vaultDir, dataDir, fetchImpl });
  if (!provider) return null;
  const llm = createLlm([{ id: provider.id, complete: (system, user) => provider.complete(system, user) }]);
  llm.probe = () => provider.probe();
  return llm;
}

/**
 * Both tiers. `fast` is null when no local model is configured; every step then uses `quality`, exactly as before.
 * With `local_fallback: true` in models.yaml, `quality` (materials, form plans, revisions) ends with the local model
 * as a last resort when every cloud connection fails. `judge` (confirming borderline scores, the review that approves
 * an application for sending) never does: those steps pause until a cloud model answers.
 */
export function createTiers({ vaultDir, dataDir, router = null, fetchImpl = globalThis.fetch } = {}) {
  const config = loadModelsConfig(vaultDir);
  const local = config.local_fallback ? localProvider({ vaultDir, dataDir, fetchImpl }) : null;
  const lastResort = local ? [{ id: local.id, complete: (system, user) => local.complete(system, user) }] : [];
  const judge = createJobLlm({ dataDir, router });
  return { fast: createFastLlm({ vaultDir, dataDir, fetchImpl }), quality: lastResort.length ? createJobLlm({ dataDir, router, lastResort }) : judge, judge, margin: config.confirm_margin, bias: config.local_bias };
}
