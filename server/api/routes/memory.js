import { sendJson } from '../router.js';
import { findEntities, getEntity, getEntityDeletionPreview, deleteEntity } from '../../memory/entity-store.js';
import { getFacts, getFact, confirmFact, correctFact, reclassifyFact, deleteFact, getFactRevisions } from '../../memory/fact-store.js';
import { getRelationships, deleteRelationship } from '../../memory/relationship-store.js';
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
      facts: getFacts(entity.id, { includeInactive: true }),
      relationships: getRelationships(entity.id),
    });
  });

  router.get('/api/memory/entities/:id/deletion-preview', async (req, res) => {
    const preview = getEntityDeletionPreview(req.params.id);
    if (!preview) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, preview);
  });

  router.delete('/api/memory/entities/:id', async (req, res) => {
    try {
      const result = deleteEntity(req.params.id, req.body?.previewToken);
      if (!result) return sendJson(res, 404, { error: 'Not Found' });
      eventBus?.publish({ type: 'memory.entity_deleted', source: 'user', actor: { type: 'user', id: req.owner.id }, subject: { type: 'entity', id: result.entity.id }, data: { type: result.entity.type, impactCounts: result.preview.counts }, metadata: { provenance: 'user:memory-management' } });
      sendJson(res, 200, { deleted: true, id: result.entity.id });
    } catch (error) {
      if (error.code === 'STALE_PREVIEW' || error.code === 'OWNER_ENTITY_PROTECTED') return sendJson(res, 409, { error: error.message });
      throw error;
    }
  });

  router.delete('/api/memory/relationships/:id', async (req, res) => {
    const relationship = deleteRelationship(req.params.id);
    if (!relationship) return sendJson(res, 404, { error: 'Not Found' });
    eventBus?.publish({ type: 'memory.relationship_deleted', source: 'user', actor: { type: 'user', id: req.owner.id }, subject: { type: 'relationship', id: relationship.id }, data: { fromEntityId: relationship.from_entity_id, toEntityId: relationship.to_entity_id, relation: relationship.relation }, metadata: { provenance: 'user:memory-management' } });
    sendJson(res, 200, { deleted: true, id: relationship.id });
  });

  router.post('/api/memory/facts/:id/confirm', async (req, res) => {
    const fact = confirmFact(req.params.id, req.owner.id); if (!fact) return sendJson(res, 404, { error: 'Not Found' });
    publishFactChange(eventBus, 'memory.fact_confirmed', fact, req.owner.id); sendJson(res, 200, { fact });
  });

  router.patch('/api/memory/facts/:id', async (req, res) => {
    const existing = getFact(req.params.id); if (!existing) return sendJson(res, 404, { error: 'Not Found' });
    let result;
    let eventType;
    if (req.body?.value !== undefined || req.body?.key !== undefined) { result = correctFact(req.params.id, { ...req.body, actor: req.owner.id }); eventType = 'memory.fact_corrected'; }
    else if (req.body?.classification !== undefined) { result = { fact: reclassifyFact(req.params.id, req.body.classification, req.owner.id) }; eventType = 'memory.fact_reclassified'; }
    else return sendJson(res, 400, { error: 'value, key, or classification is required' });
    publishFactChange(eventBus, eventType, result.fact, req.owner.id, { previousFactId: req.params.id }); sendJson(res, 200, result);
  });

  router.get('/api/memory/facts/:id/revisions', async (req, res) => {
    if (!getFact(req.params.id)) return sendJson(res, 404, { error: 'Not Found' }); sendJson(res, 200, { revisions: getFactRevisions(req.params.id) });
  });

  router.delete('/api/memory/facts/:id', async (req, res) => {
    const fact = deleteFact(req.params.id, req.owner.id); if (!fact) return sendJson(res, 404, { error: 'Not Found' });
    publishFactChange(eventBus, 'memory.fact_deleted', fact, req.owner.id); sendJson(res, 200, { deleted: true, id: req.params.id });
  });
}

function publishFactChange(eventBus, type, fact, ownerId, data = {}) {
  eventBus?.publish({ type, source: 'user', actor: { type: 'user', id: ownerId }, subject: { type: 'fact', id: fact.id }, data: { entityId: fact.entity_id, key: fact.key, ...data }, metadata: { provenance: 'user:memory-management' } });
}
