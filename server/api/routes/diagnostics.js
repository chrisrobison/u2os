import { sendJson } from '../router.js';
import { buildDiagnostics } from '../../diagnostics/diagnostics.js';
import { buildBugBundle } from '../../diagnostics/bug-bundle.js';

export function registerDiagnosticsRoutes(router, dependencies) {
  router.get('/api/diagnostics', async (_req, res) => {
    sendJson(res, 200, buildDiagnostics(dependencies));
  });
  router.post('/api/diagnostics/bug-bundle', async (_req, res) => {
    const stamp = new Date().toISOString().replaceAll(':', '-');
    sendJson(res, 200, buildBugBundle(dependencies), {
      'Content-Disposition': `attachment; filename="u2os-debug-${stamp}.json"`,
      'Cache-Control': 'no-store',
    });
  });
}
