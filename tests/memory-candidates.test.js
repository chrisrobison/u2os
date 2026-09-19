import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createEntity } from '../server/memory/entity-store.js';
import { proposeMemoryCandidate, acceptMemoryCandidate, rejectMemoryCandidate } from '../server/memory/candidate-store.js';

function setup() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-candidates-')); process.env.U2OS_HOME = dir; getDb(); return dir; }
function cleanup(dir) { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }

test('memory candidates require explicit acceptance before becoming facts', () => {
  const dir = setup();
  try {
    const person = createEntity({ type: 'Person', name: 'Dana' });
    const candidate = proposeMemoryCandidate({ content: 'Prefers afternoons', confidence: 'high', proposedBy: 'owner' });
    assert.equal(getDb().prepare('SELECT count(*) n FROM facts').get().n, 0);
    const result = acceptMemoryCandidate(candidate.id, { entityId: person.id, key: 'meeting_preference', resolvedBy: 'owner' });
    assert.equal(result.candidate.status, 'accepted');
    assert.equal(result.fact.value, 'Prefers afternoons');
    assert.throws(() => acceptMemoryCandidate(candidate.id, { entityId: person.id, key: 'duplicate', resolvedBy: 'owner' }), /already accepted/);
  } finally { cleanup(dir); }
});

test('rejected memory candidates cannot be promoted', () => {
  const dir = setup();
  try {
    const candidate = proposeMemoryCandidate({ content: 'Uncertain', confidence: 'low' });
    assert.equal(rejectMemoryCandidate(candidate.id, 'owner').status, 'rejected');
    assert.throws(() => acceptMemoryCandidate(candidate.id, { entityId: 'x', key: 'x', resolvedBy: 'owner' }), /already rejected/);
  } finally { cleanup(dir); }
});
