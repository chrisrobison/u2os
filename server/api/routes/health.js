import { sendJson } from '../router.js';

export function registerHealthRoutes(router, { dataDir, dbPath, startTime }) {
  router.get('/api/health', async (_req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      dataDir,
      dbPath,
      uptimeSeconds: Math.round((Date.now() - startTime) / 1000),
    });
  });
}
