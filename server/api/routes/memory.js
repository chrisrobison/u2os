import { sendJson } from '../router.js';
import { findEntities, getEntity, getEntityDeletionPreview, deleteEntity } from '../../memory/entity-store.js';
import { getFacts, getFact, confirmFact, correctFact, reclassifyFact, deleteFact, getFactRevisions } from '../../memory/fact-store.js';
import { getRelationships, getRelationship, deleteRelationship } from '../../memory/relationship-store.js';
import { listMemoryCandidates, getMemoryCandidate, acceptMemoryCandidate, rejectMemoryCandidate } from '../../memory/candidate-store.js';
import { writeFactToVault, removeFactFromVault, reclassifyFactInVault, prepareVaultTrash } from '../../vault/writeback.js';
import { indexVault } from '../../vault/indexer.js';

// Owner edits to vault-backed records are written to the vault file first
// (docs/vault.md, "Editing from the UI"), then applied to the database for
// audit, then the vault is re-indexed so the file stays the authority.
function isVaultFact(fact) { return typeof fact?.source === 'string' && fact.source.startsWith('vault:'); }
function currentFact(entityId, key, fallback) {
  return getFacts(entityId).find((fact) => fact.key === key && isVaultFact(fact)) || fallback;
}
async function vaultRoute(res, handler) {
  try { return await handler(); }
  catch (error) {
    if (error.code === 'VAULT_WRITEBACK') return sendJson(res, error.status || 409, { error: error.message, code: error.code });
    throw error;
  }
}

export function registerMemoryRoutes(router, { eventBus } = {}) {
  router.get('/api/memory/candidates', async (req, res) => {
    sendJson(res, 200, { candidates: listMemoryCandidates({ status: req.query.status === 'all' ? null : (req.query.status || 'pending'), limit: req.query.limit }) });
  });

  router.post('/api/memory/candidates/:id/accept', async (req, res) => vaultRoute(res, () => {
    const candidate = getMemoryCandidate(req.params.id);
    if (!candidate) return sendJson(res, 404, { error: 'Not Found' });
    let vault = null;
    if (candidate.status === 'pending' && req.body?.entityId && req.body?.key) {
      vault = writeFactToVault(req.body.entityId, { key: req.body.key, value: req.body.value ?? candidate.content,
        classification: req.body.classification ?? 'personal', append: req.body.key === 'notes' });
    }
    const result = acceptMemoryCandidate(req.params.id, { ...req.body, resolvedBy: req.owner.id });
    if (!result) return sendJson(res, 404, { error: 'Not Found' });
    if (vault) { indexVault({ eventBus }); result.fact = currentFact(result.fact.entity_id, result.fact.key, result.fact); result.vault = vault; }
    eventBus?.publish({ type: 'memory.fact_recorded', source: 'user', actor: { type: 'user', id: req.owner.id }, subject: { type: 'fact', id: result.fact.id }, data: { entityId: result.fact.entity_id, key: result.fact.key, memoryCandidateId: req.params.id }, metadata: { correlationId: result.candidate.correlation_id, provenance: 'user:memory-candidate-accept' } });
    sendJson(res, 200, result);
  }));

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
      const trashVaultFile = prepareVaultTrash(req.params.id);
      const result = deleteEntity(req.params.id, req.body?.previewToken);
      if (!result) return sendJson(res, 404, { error: 'Not Found' });
      // The file would otherwise recreate the record; keep it recoverable.
      const trashed = trashVaultFile ? trashVaultFile() : null;
      if (trashed) { result.vault = trashed; indexVault({ eventBus }); }
      eventBus?.publish({ type: 'memory.entity_deleted', source: 'user', actor: { type: 'user', id: req.owner.id }, subject: { type: 'entity', id: result.entity.id }, data: { type: result.entity.type, impactCounts: result.preview.counts }, metadata: { provenance: 'user:memory-management' } });
      sendJson(res, 200, { deleted: true, id: result.entity.id, ...(result.vault ? { vault: result.vault } : {}) });
    } catch (error) {
      if (error.code === 'STALE_PREVIEW' || error.code === 'OWNER_ENTITY_PROTECTED') return sendJson(res, 409, { error: error.message });
      throw error;
    }
  });

  router.delete('/api/memory/relationships/:id', async (req, res) => {
    const existing = getRelationship(req.params.id);
    if (existing?.source?.startsWith('vault:')) return sendJson(res, 409, { error: `This relationship comes from ${existing.source.slice(6)}; edit that file instead (for a commitment, set status: done)`, code: 'VAULT_WRITEBACK' });
    const relationship = deleteRelationship(req.params.id);
    if (!relationship) return sendJson(res, 404, { error: 'Not Found' });
    eventBus?.publish({ type: 'memory.relationship_deleted', source: 'user', actor: { type: 'user', id: req.owner.id }, subject: { type: 'relationship', id: relationship.id }, data: { fromEntityId: relationship.from_entity_id, toEntityId: relationship.to_entity_id, relation: relationship.relation }, metadata: { provenance: 'user:memory-management' } });
    sendJson(res, 200, { deleted: true, id: relationship.id });
  });

  router.post('/api/memory/facts/:id/confirm', async (req, res) => {
    const fact = confirmFact(req.params.id, req.owner.id); if (!fact) return sendJson(res, 404, { error: 'Not Found' });
    publishFactChange(eventBus, 'memory.fact_confirmed', fact, req.owner.id); sendJson(res, 200, { fact });
  });

  router.patch('/api/memory/facts/:id', async (req, res) => vaultRoute(res, () => {
    const existing = getFact(req.params.id); if (!existing) return sendJson(res, 404, { error: 'Not Found' });
    let result;
    let eventType;
    let vault = null;
    if (req.body?.value !== undefined || req.body?.key !== undefined) {
      if (existing.status !== 'current') return sendJson(res, 409, { error: 'Only current facts can be corrected' });
      if (req.body.value === undefined) return sendJson(res, 400, { error: 'value is required' });
      vault = writeFactToVault(existing.entity_id, { key: req.body.key || existing.key, value: req.body.value, previousKey: existing.key, classification: req.body.classification });
      result = correctFact(req.params.id, { ...req.body, actor: req.owner.id }); eventType = 'memory.fact_corrected';
    } else if (req.body?.classification !== undefined) {
      if (isVaultFact(existing)) vault = reclassifyFactInVault(existing.entity_id, existing.key, req.body.classification);
      result = { fact: reclassifyFact(req.params.id, req.body.classification, req.owner.id) }; eventType = 'memory.fact_reclassified';
    } else return sendJson(res, 400, { error: 'value, key, or classification is required' });
    if (vault) { indexVault({ eventBus }); result = { ...result, fact: currentFact(result.fact.entity_id, result.fact.key, result.fact), vault }; }
    publishFactChange(eventBus, eventType, result.fact, req.owner.id, { previousFactId: req.params.id }); sendJson(res, 200, result);
  }));

  router.get('/api/memory/facts/:id/revisions', async (req, res) => {
    if (!getFact(req.params.id)) return sendJson(res, 404, { error: 'Not Found' }); sendJson(res, 200, { revisions: getFactRevisions(req.params.id) });
  });

  router.delete('/api/memory/facts/:id', async (req, res) => vaultRoute(res, () => {
    const existing = getFact(req.params.id); if (!existing) return sendJson(res, 404, { error: 'Not Found' });
    const vault = isVaultFact(existing) && existing.status !== 'deleted' ? removeFactFromVault(existing.entity_id, existing.key) : null;
    const fact = deleteFact(req.params.id, req.owner.id); if (!fact) return sendJson(res, 404, { error: 'Not Found' });
    if (vault) indexVault({ eventBus });
    publishFactChange(eventBus, 'memory.fact_deleted', fact, req.owner.id); sendJson(res, 200, { deleted: true, id: req.params.id, ...(vault ? { vault } : {}) });
  }));
}

function publishFactChange(eventBus, type, fact, ownerId, data = {}) {
  eventBus?.publish({ type, source: 'user', actor: { type: 'user', id: ownerId }, subject: { type: 'fact', id: fact.id }, data: { entityId: fact.entity_id, key: fact.key, ...data }, metadata: { provenance: 'user:memory-management' } });
}
