import { sendJson } from '../router.js';
import { listEvents } from '../../events/log.js';

export function registerEventRoutes(router, { db, sseHub }) {
  router.get('/api/events', async (req, res) => {
    const { type, since, correlationId, limit } = req.query;
    const events = listEvents(db, { type, since, correlationId, limit: limit ? Number(limit) : undefined });
    sendJson(res, 200, { events });
  });

  router.get('/api/events/stream', async (req, res) => {
    sseHub.attach(req, res);
  });
}
