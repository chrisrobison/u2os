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
export function createJobLlm({ dataDir, router = null } = {}) {
  let providers = [];
  try {
    const modelRouter = router ?? createModelRouter(dataDir);
    const chain = [modelRouter.resolve('planner'), ...modelRouter.resolveFallbacks('planner')];
    providers = chain.filter((provider) => typeof provider?.complete === 'function')
      .map((provider) => ({ id: provider.id, complete: (system, user) => provider.complete(system, user) }));
  } catch { providers = []; }
  return createLlm(providers);
}

/**
 * The local first-pass model from job-hunt/models.yaml, or null when none is
 * configured. Its availability is checked with probe() by the caller.
 */
export function createFastLlm({ vaultDir, dataDir, fetchImpl = globalThis.fetch } = {}) {
  const config = loadModelsConfig(vaultDir).fast;
  if (!config) return null;
  let apiKey = null;
  try { apiKey = readEncryptedFile(LMSTUDIO_SECRET, dataDir)?.apiKey ?? null; } catch { apiKey = null; }
  const provider = new LmStudioProvider({ baseUrl: config.base_url, model: config.model, apiKey, reasoning: config.reasoning, maxOutputTokens: config.max_output_tokens, timeoutMs: config.timeout_seconds * 1000, fetchImpl });
  const llm = createLlm([{ id: provider.id, complete: (system, user) => provider.complete(system, user) }]);
  llm.probe = () => provider.probe();
  return llm;
}

/** Both tiers. `fast` is null when no local model is configured; every step then uses `quality`, exactly as before. */
export function createTiers({ vaultDir, dataDir, router = null } = {}) {
  const config = loadModelsConfig(vaultDir);
  return { fast: createFastLlm({ vaultDir, dataDir }), quality: createJobLlm({ dataDir, router }), margin: config.confirm_margin, bias: config.local_bias };
}
