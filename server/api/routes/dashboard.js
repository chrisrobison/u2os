import { sendJson } from '../router.js';
import { DashboardNotFoundError, InvalidDashboardContextError } from '../../agent/dashboard-planner.js';

export function registerDashboardRoutes(router, { agent }) {
  // Backwards-compatible route: still returns the same "Morning Briefing"
  // schema as before, but now delegates to agent.generateDashboard() --
  // one code path for every dashboard context, not a separate hardcoded
  // handler that bypasses the provider registry.
  router.get('/api/dashboard/morning', async (_req, res) => {
    try {
      const schema = agent.generateDashboard({ context: 'morning' });
      sendJson(res, 200, schema);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  // POST /api/dashboard/generate { context: 'morning'|'before-meeting'|'project', params?: {...} }
  // -> a dashboard schema composed from real context data, validated
  // against the same allowlist as every other dashboard schema.
  router.post('/api/dashboard/generate', async (req, res) => {
    const { context, params } = req.body || {};
    try {
      const schema = agent.generateDashboard({ context, params: params || {} });
      sendJson(res, 200, schema);
    } catch (err) {
      if (err instanceof DashboardNotFoundError) return sendJson(res, 404, { error: err.message });
      if (err instanceof InvalidDashboardContextError) return sendJson(res, 400, { error: err.message });
      sendJson(res, 500, { error: err.message });
    }
  });
}
