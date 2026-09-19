import { sendJson } from '../router.js';
import { findEntities, getEntity } from '../../memory/entity-store.js';
import { getFacts } from '../../memory/fact-store.js';
import { getRelationships } from '../../memory/relationship-store.js';
import { getDb } from '../../db/connection.js';
import { listMemoryCandidates, acceptMemoryCandidate, rejectMemoryCandidate } from '../../memory/candidate-store.js';

export function registerMemoryRoutes(router, { eventBus } = {}) {
  router.get('/api/memory/candidates', async (req, res) => {
    sendJson(res, 200, { candidates: listMemoryCandidates({ status: req.query.status === 'all' ? null : (req.query.status || 'pending'), limit: req.query.limit }) });
  });

  router.post('/api/memory/candidates/:id/accept', async (req, res) => {
    const result = acceptMemoryCandidate(req.params.id, { ...req.body, resolvedBy: req.owner.id });
    if (!result) return sendJson(res, 404, { error: 'Not Found' });
    eventBus?.publish({ type: 'memory.fact_recorded', source: 'user', actor: { type: 'user', id: req.owner.id }, subject: { type: 'fact', id: result.fact.id }, data: { entityId: result.fact.entity_id, key: result.fact.key, memoryCandidateId: req.params.id }, metadata: { correlationId: result.candidate.correlation_id, provenance: 'user:memory-candidate-accept' } });
    sendJson(res, 200, result);
  });

  router.post('/api/memory/candidates/:id/reject', async (req, res) => {
    const candidate = rejectMemoryCandidate(req.params.id, req.owner.id);
    if (!candidate) return sendJson(res, 404, { error: 'Not Found' });
    eventBus?.publish({ type: 'agent.memory_candidate.rejected', source: 'user', actor: { type: 'user', id: req.owner.id }, subject: { type: 'memory_candidate', id: candidate.id }, metadata: { correlationId: candidate.correlation_id, provenance: 'user:memory-candidate-reject' } });
    sendJson(res, 200, { candidate });
  });
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
