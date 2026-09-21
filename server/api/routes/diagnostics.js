import { sendJson } from '../router.js';
import { buildDiagnostics } from '../../diagnostics/diagnostics.js';

export function registerDiagnosticsRoutes(router, dependencies) {
  router.get('/api/diagnostics', async (_req, res) => {
    sendJson(res, 200, buildDiagnostics(dependencies));
  });
}
