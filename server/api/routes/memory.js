import { sendJson } from '../router.js';
import { findEntities, getEntity } from '../../memory/entity-store.js';
import { getFacts } from '../../memory/fact-store.js';
import { getRelationships } from '../../memory/relationship-store.js';
import { getDb } from '../../db/connection.js';

export function registerMemoryRoutes(router) {
  router.get('/api/memory/entities', async (req, res) => {
    sendJson(res, 200, { entities: findEntities({ type: req.query.type, query: req.query.query }) });
  });

  router.get('/api/memory/entities/:id', async (req, res) => {
    const entity = getEntity(req.params.id);
    if (!entity) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, {
      entity,
      facts: getFacts(entity.id),
      relationships: getRelationships(entity.id),
    });
  });

  // Correction/deletion support per PROMPT.md ("inspect/correct/delete").
  router.delete('/api/memory/facts/:id', async (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM facts WHERE id = ?').get(req.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Not Found' });
    db.prepare('DELETE FROM facts WHERE id = ?').run(req.params.id);
    sendJson(res, 200, { deleted: true, id: req.params.id });
  });
}
