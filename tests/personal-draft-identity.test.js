import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { ensureInstallationMode, installationModePath } from '../server/seed/installation-mode.js';
import { createEntity } from '../server/memory/entity-store.js';
import { createDraft, getDraftById } from '../server/integrations/mock-email-provider.js';
import { EmailDraftTool } from '../server/tools/email-tools.js';

const args = { to: 'fixture-recipient@example.test', subject: 'Fixture reply', body: 'Only a local draft', inReplyTo: 'fixture_source_message' };
async function fixture(mode, operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-personal-draft-')), previous = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try { if (mode) ensureInstallationMode(mode); await operation(home, getDb()); }
  finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); }
}

for (const mode of ['personal', null]) {
  test(`${mode || 'unmarked legacy'} draft store never invents a demo sender`, () => fixture(mode, async (home, db) => {
    const draft = createDraft(args, 'fixture_draft');
    assert.equal(draft.from_addr, ''); assert.equal(draft.folder, 'drafts');
    assert.deepEqual(draft.to_addr, [args.to]); assert.equal(draft.thread_id, args.inReplyTo);
    assert.equal(draft.correlation_id, 'fixture_draft'); assert.equal(draft.body, args.body);
    assert.deepEqual(getDraftById(draft.id), draft);
    assert.equal(db.prepare("SELECT count(*) n FROM emails WHERE folder='sent'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='email.sent'").get().n, 0);
    if (!mode) assert.equal(fs.existsSync(installationModePath(home)), false, 'local drafting cannot initialize or convert a legacy home');
  }));
}

test('personal draft tool works offline without resolving an active/provider account or sending', () => fixture('personal', async (_home, db) => {
  const native = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Fixture prohibits external calls'); };
  try {
    const result = await new EmailDraftTool().execute(args, { correlationId: 'fixture_tool' });
    assert.equal(result.from_addr, ''); assert.equal(result.correlation_id, 'fixture_tool'); assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM connection_instances').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM action_queue').get().n, 0);
  } finally { globalThis.fetch = native; }
}));

test('owner display name and rename cannot manufacture sender identity', () => fixture('personal', async (_home, db) => {
  const owner = createEntity({ type: 'Person', name: 'Chris', attributes: { role: 'owner' } });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO owners(id,entity_id,passphrase_hash,salt,scrypt_params,created_at) VALUES('fixture_owner',?,'fixture','fixture','{}',?)").run(owner.id, now);
  assert.equal(createDraft(args).from_addr, '');
  db.prepare("UPDATE entities SET name='Renamed fixture owner' WHERE id=?").run(owner.id);
  assert.equal(createDraft(args).from_addr, '');
  assert.equal(db.prepare("SELECT entity_id FROM owners WHERE id='fixture_owner'").get().entity_id, owner.id);
}));

test('explicit isolated demo keeps its reproducible sender without actual delivery', () => fixture('demo', async (_home, db) => {
  const result = await new EmailDraftTool().execute(args);
  assert.equal(result.from_addr, 'chris@u2os.local'); assert.equal(result.folder, 'drafts');
  assert.equal(db.prepare("SELECT count(*) n FROM emails WHERE folder='sent'").get().n, 0);
}));

test('existing ambiguous drafts and real records are preserved, never rewritten to infer sender', () => fixture('personal', async (_home, db) => {
  const entity = createEntity({ type: 'Person', name: 'Existing fixture contact' });
  db.prepare("INSERT INTO emails(id,from_addr,to_addr,subject,body,folder,is_read,created_at) VALUES('old_fixture_draft','chris@u2os.local','[]','Old fixture','Retain for review','drafts',1,'2020-01-01')").run();
  const before = db.prepare("SELECT * FROM emails WHERE id='old_fixture_draft'").get();
  closeAllForTests(); const draft = await new EmailDraftTool().execute(args);
  assert.equal(draft.from_addr, '');
  assert.deepEqual(getDb().prepare("SELECT * FROM emails WHERE id='old_fixture_draft'").get(), before);
  assert.equal(getDb().prepare('SELECT name FROM entities WHERE id=?').get(entity.id).name, entity.name);
}));

test('invalid persisted mode refuses drafting rather than borrowing demo identity', () => fixture('personal', async (home, db) => {
  fs.writeFileSync(installationModePath(home), JSON.stringify({ mode: 'invalid-fixture-mode' }));
  assert.throws(() => createDraft(args));
  assert.equal(db.prepare('SELECT count(*) n FROM emails').get().n, 0);
}));
