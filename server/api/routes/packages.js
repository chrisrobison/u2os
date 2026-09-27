import { sendJson } from '../router.js';
import { listPackageAudit } from '../../packages/store.js';

// Owner-only (router default), CSRF-protected writes. The package platform
// (docs/plugin-architecture.md §12). Device capabilities keep /api/capabilities;
// package capability contracts are listed under /api/packages/capabilities.
export function registerPackageRoutes(router, { packages }) {
  const { manager, runtime } = packages;

  // Specific paths first: the router picks the first registered match.
  router.get('/api/packages/capabilities', async (_req, res) => {
    sendJson(res, 200, { capabilities: manager.capabilities() });
  });

  router.put('/api/packages/capabilities/:capability/provider', async (req, res) => {
    const provider = req.body?.provider ?? null;
    if (provider !== null && typeof provider !== 'string') return sendJson(res, 400, { error: 'provider must be a provider id or null' });
    sendJson(res, 200, { capability: manager.selectProvider(req.params.capability, provider) });
  });

  router.get('/api/packages/skills', async (_req, res) => {
    sendJson(res, 200, { skills: manager.skills() });
  });

  router.get('/api/packages/audit', async (req, res) => {
    sendJson(res, 200, { entries: listPackageAudit({ packageId: req.query.package || null, automationId: req.query.automation || null, runId: req.query.run || null, limit: req.query.limit }) });
  });

  router.post('/api/packages/review', async (req, res) => {
    if (typeof req.body?.source !== 'string') return sendJson(res, 400, { error: 'source is required' });
    sendJson(res, 200, { review: await manager.review(req.body.source) });
  });

  router.post('/api/packages/install', async (req, res) => {
    const { source, grant = null } = req.body || {};
    if (typeof source !== 'string') return sendJson(res, 400, { error: 'source is required' });
    if (grant !== null && grant !== 'all' && !Array.isArray(grant)) return sendJson(res, 400, { error: 'grant must be "all", a list of permissions, or null' });
    sendJson(res, 201, { package: await manager.install(source, { grant, grantedBy: req.owner?.id || 'owner' }) });
  });

  router.get('/api/packages', async (_req, res) => {
    sendJson(res, 200, { packages: manager.list() });
  });

  router.get('/api/packages/:id', async (req, res) => {
    sendJson(res, 200, { package: manager.get(req.params.id) });
  });

  router.delete('/api/packages/:id', async (req, res) => {
    sendJson(res, 200, { result: manager.uninstall(req.params.id, { force: req.query.force === '1' }) });
  });

  router.post('/api/packages/:id/enable', async (req, res) => {
    sendJson(res, 200, { package: manager.setEnabled(req.params.id, true) });
  });

  router.post('/api/packages/:id/disable', async (req, res) => {
    sendJson(res, 200, { package: manager.setEnabled(req.params.id, false) });
  });

  router.post('/api/packages/:id/grants', async (req, res) => {
    const { grant = null, revoke = null } = req.body || {};
    if (grant === null && revoke === null) return sendJson(res, 400, { error: 'grant or revoke is required' });
    let result = null;
    if (revoke !== null) result = manager.revoke(req.params.id, revoke);
    if (grant !== null) result = manager.grant(req.params.id, grant, req.owner?.id || 'owner');
    sendJson(res, 200, { package: result });
  });

  router.put('/api/packages/:id/settings', async (req, res) => {
    const { settings = null, policies = null } = req.body || {};
    sendJson(res, 200, { package: manager.configure(req.params.id, { settings, policies }) });
  });

  // Secret values are write-only: responses carry names and configured flags.
  router.put('/api/packages/:id/secrets/:name', async (req, res) => {
    sendJson(res, 200, { secrets: manager.setSecret(req.params.id, req.params.name, req.body?.value ?? null) });
  });

  router.get('/api/automations', async (_req, res) => {
    sendJson(res, 200, { automations: runtime.list() });
  });

  router.get('/api/automations/runs/:runId', async (req, res) => {
    sendJson(res, 200, { run: runtime.runDetail(req.params.runId) });
  });

  router.get('/api/automations/:id', async (req, res) => {
    sendJson(res, 200, { automation: runtime.inspect(req.params.id) });
  });

  const operations = {
    enable: (id) => runtime.enable(id),
    disable: (id) => runtime.disable(id),
    pause: (id) => runtime.pause(id),
    resume: (id) => runtime.resume(id),
    stop: (id) => ({ cancelled: runtime.stopRuns(id) }),
  };
  for (const [operation, handler] of Object.entries(operations)) {
    router.post(`/api/automations/:id/${operation}`, async (req, res) => {
      sendJson(res, 200, { automation: handler(req.params.id) });
    });
  }

  router.post('/api/automations/:id/run', async (req, res) => {
    const inputs = req.body?.inputs ?? {};
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return sendJson(res, 400, { error: 'inputs must be an object' });
    // Starts the run and returns immediately; progress is visible in run history.
    sendJson(res, 202, { run: await runtime.runNow(req.params.id, inputs, { wait: false }) });
  });
}
