import { createModelRouter } from '../agent/provider-config.js';
import { createLlm } from '../../mcp/jobs/hunt/llm/structured.js';

/**
 * The job hunter's model: the owner's configured connections, in the owner's
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
