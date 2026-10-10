import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { buildDashboard } from '../mcp/jobs/hunt/dashboard.js';
import { addContact, updateContact, deleteContact, markContacted, seedContacts, dashboardContacts, validEmail } from '../mcp/jobs/hunt/contacts.js';
import { startServer } from './helpers/authed-server.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const DAY = 86_400_000;
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const SCORE = { score: 88, confidence: 0.9, label: 'strong', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'x', projects: [], flags: [], degraded: false, model: 'm' };

function addJob(store, n, company, { status = null, contactEmails = [] } = {}) {
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${n}#0`, company, role: 'Engineer', rawText: company, applicationUrls: [], contactEmails, locations: [] }, new Date(NOW.getTime() - 60 * DAY));
  store.saveScore(job.id, SCORE, new Date(NOW.getTime() - 60 * DAY));
  if (status) store.transition(job.id, status, {}, new Date(NOW.getTime() - 5 * DAY));
  return job;
}

function sent(store, job, to, sentAt, n) {
  const email = store.addEmail(job.id, { to, subject: 's', body: 'b', status: 'sent', idempotencyKey: `k${n}` }, NOW);
  store.updateEmail(email.id, { status: 'sent', detail: { sentAt } }, NOW);
}

test('contacts are seeded from listing emails and sent mail, once, one per address in any case', () => {
  const store = openStore(':memory:');
  const job = addJob(store, 1, 'Alpha', { status: 'contacted', contactEmails: ['Jane.Doe@alpha.example', 'jane.doe@ALPHA.example', 'bad address@x', 'jobs@alpha.example\r\nBcc: x@y.z'] });
  sent(store, job, 'jane.doe@alpha.example', ago(9), 1);
  sent(store, job, 'JANE.DOE@alpha.example', ago(3), 2);
  sent(store, job, 'hr@alpha.example', ago(6), 3);
  store.addEmail(job.id, { kind: 'draft', to: 'draft@alpha.example', subject: 's', body: 'b', status: 'drafted', idempotencyKey: 'k4' }, NOW);
  seedContacts(store, NOW);
  seedContacts(store, NOW);
  const rows = store.listContacts();
  assert.deepEqual(rows.map((c) => [c.email.toLowerCase(), c.source, c.lastContactAt]), [['jane.doe@alpha.example', 'job_listing', ago(3)], ['hr@alpha.example', 'sent_email', ago(6)]]);
  assert.equal(rows[0].name, 'Jane Doe');
  assert.equal(rows[0].roleKind, 'other');
  assert.equal(store.listContacts().length, 2, 'repeated seeding adds nothing');
  store.close();
});

test('seeding never overwrites owner edits, moves last contact only forward and does not resurrect a removed contact', () => {
  const store = openStore(':memory:');
  const job = addJob(store, 1, 'Alpha', { contactEmails: ['jane@alpha.example', 'hr@alpha.example'] });
  seedContacts(store, NOW);
  const [jane, hr] = store.listContacts();
  updateContact(store, jane.id, { name: 'Jane Q. Doe', roleKind: 'hiring_manager', title: 'VP Eng' }, NOW);
  markContacted(store, jane.id, new Date(ago(1)));
  deleteContact(store, hr.id, NOW);
  sent(store, job, 'jane@alpha.example', ago(8), 1); // older than the owner's mark
  seedContacts(store, NOW);
  let now = store.getContact(jane.id);
  assert.deepEqual([now.name, now.roleKind, now.title, now.source, now.lastContactAt], ['Jane Q. Doe', 'hiring_manager', 'VP Eng', 'job_listing', ago(1)]);
  sent(store, job, 'jane@alpha.example', ago(0.5), 2); // newer: advances, still no other field changes
  seedContacts(store, NOW);
  now = store.getContact(jane.id);
  assert.deepEqual([now.name, now.roleKind, now.lastContactAt], ['Jane Q. Doe', 'hiring_manager', ago(0.5)]);
  assert.deepEqual(dashboardContacts(store, NOW).map((c) => c.email), ['jane@alpha.example'], 'the removed contact stays removed');
  // Adding the removed address back revives it with what the owner typed.
  const back = addContact(store, job.id, { name: 'Hannah R', email: 'HR@alpha.example', roleKind: 'recruiter' }, NOW).contact;
  assert.deepEqual([back.id, back.name, back.roleKind], [hr.id, 'Hannah R', 'recruiter']);
  assert.equal(dashboardContacts(store, NOW).length, 2);
  store.close();
});

test('owner add, edit, delete and mark contacted, with validation', () => {
  const store = openStore(':memory:');
  const job = addJob(store, 1, 'Alpha');
  const bad = (fn, code = 'BAD_INPUT') => assert.throws(fn, { code });
  const ok = { name: 'Sam', email: 'sam@alpha.example' };
  bad(() => addContact(store, job.id, {}, NOW));
  bad(() => addContact(store, job.id, { ...ok, name: ' ' }, NOW));
  bad(() => addContact(store, job.id, { ...ok, name: 'x'.repeat(121) }, NOW));
  bad(() => addContact(store, job.id, { ...ok, name: 'Sam\nBcc: evil@x.co' }, NOW));
  bad(() => addContact(store, job.id, { ...ok, title: 'x'.repeat(121) }, NOW));
  bad(() => addContact(store, job.id, { ...ok, title: 5 }, NOW));
  bad(() => addContact(store, job.id, { ...ok, roleKind: 'boss' }, NOW));
  for (const email of ['nope', 'a@b', 'a b@c.co', 'a@b.co, c@d.co', 'a@b.co\r\nBcc: c@d.co', '"A" <a@b.co>', 'a@b.co;c@d.co', `${'a'.repeat(65)}@b.co`, 5, '']) bad(() => addContact(store, job.id, { ...ok, email }, NOW));
  bad(() => addContact(store, 'job_0000000000000000', ok, NOW), 'UNKNOWN_JOB');
  assert.equal(store.listContacts().length, 0, 'nothing changed on failure');
  assert.equal(validEmail('first.last+tag@sub.example.co'), true);

  const sam = addContact(store, job.id, { ...ok, roleKind: 'referral', title: ' Staff eng ' }, NOW).contact;
  assert.deepEqual([sam.source, sam.roleKind, sam.title, sam.lastContactAt], ['manual', 'referral', 'Staff eng', null]);
  bad(() => addContact(store, job.id, { name: 'Other', email: 'SAM@alpha.example' }, NOW), 'CONFLICT');
  assert.equal(updateContact(store, sam.id, { title: null }, NOW).contact.title, null);
  assert.equal(updateContact(store, sam.id, { name: 'Samuel' }, NOW).contact.roleKind, 'referral', 'untouched fields stay');
  bad(() => updateContact(store, sam.id, { name: '' }, NOW));
  bad(() => updateContact(store, sam.id, { roleKind: 'x' }, NOW));
  bad(() => updateContact(store, sam.id, { email: 'new@alpha.example' }, NOW));
  bad(() => updateContact(store, sam.id, { lastContactAt: NOW.toISOString() }, NOW));
  bad(() => updateContact(store, 999, { name: 'x' }, NOW), 'UNKNOWN_CONTACT');
  assert.equal(markContacted(store, sam.id, NOW).contact.lastContactAt, NOW.toISOString());
  assert.equal(markContacted(store, sam.id, new Date(NOW.getTime() - DAY)).contact.lastContactAt, NOW.toISOString(), 'never moves backwards');
  bad(() => markContacted(store, 999, NOW), 'UNKNOWN_CONTACT');
  assert.equal(deleteContact(store, sam.id, NOW).removed, true);
  assert.equal(deleteContact(store, sam.id, NOW).removed, false);
  assert.equal(store.listContacts().length, 0, 'a manual contact is really gone');
  store.close();
});

test('dashboard contacts: payload shape, recent first, never contacted last, capped at 50, existing fields untouched', () => {
  const store = openStore(':memory:');
  const a = addJob(store, 1, 'Alpha');
  const b = addJob(store, 2, 'Beta');
  const c1 = addContact(store, a.id, { name: 'Old', email: 'old@a.example', roleKind: 'recruiter' }, NOW).contact;
  const c2 = addContact(store, b.id, { name: 'New', email: 'new@b.example' }, NOW).contact;
  addContact(store, a.id, { name: 'Never', email: 'never@a.example' }, NOW);
  markContacted(store, c1.id, new Date(ago(10)));
  markContacted(store, c2.id, new Date(ago(2)));
  const dash = buildDashboard(store, { now: NOW });
  assert.deepEqual(dash.contacts.map((c) => c.name), ['New', 'Old', 'Never']);
  assert.deepEqual(Object.keys(dash.contacts[0]).sort(), ['company', 'email', 'id', 'jobId', 'lastContactAt', 'name', 'role', 'roleKind', 'title']);
  assert.deepEqual(dash.contacts[1], { id: c1.id, jobId: a.id, company: 'Alpha', role: 'Engineer', name: 'Old', email: 'old@a.example', roleKind: 'recruiter', title: null, lastContactAt: ago(10) });
  for (let i = 0; i < 60; i += 1) addContact(store, b.id, { name: `P${i}`, email: `p${i}@b.example` }, NOW);
  assert.equal(buildDashboard(store, { now: NOW }).contacts.length, 50);
  store.close();
});

test('a hunt.sqlite from before contacts opens, keeps its rows and seeds contacts from old mail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-contacts-old-'));
  const file = path.join(dir, 'hunt.sqlite');
  let store = openStore(file);
  const job = addJob(store, 1, 'Alpha', { status: 'applied', contactEmails: ['jobs@alpha.example'] });
  sent(store, job, 'jobs@alpha.example', ago(4), 1);
  store.close();
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE job_contacts; PRAGMA user_version = 7');
  const before = raw.prepare('SELECT id, status, updated_at FROM jobs').all();
  const mail = raw.prepare('SELECT COUNT(*) AS n FROM emails').get().n;
  raw.close();
  store = openStore(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
  assert.deepEqual(store.db.prepare('SELECT id, status, updated_at FROM jobs').all(), before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, mail);
  const contacts = buildDashboard(store, { now: NOW }).contacts;
  assert.deepEqual(contacts.map((c) => [c.email, c.lastContactAt]), [['jobs@alpha.example', ago(4)]]);
  store.close();
  store = openStore(file);
  assert.equal(store.listContacts().length, 1);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('the owner API for contacts and the extended dashboard', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-contacts-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  fs.mkdirSync(path.join(process.env.U2OS_VAULT, 'job-hunt'), { recursive: true });
  const store = openStore(huntDbPath(process.env.U2OS_VAULT));
  const job = addJob(store, 1, 'Alpha', { status: 'applied', contactEmails: ['jobs@alpha.example'] });
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const send = async (method, url, body) => { const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };

  assert.equal((await send('POST', '/api/job-hunt/jobs/nope/contacts', { name: 'A', email: 'a@b.co' })).status, 400);
  assert.equal((await send('POST', '/api/job-hunt/jobs/job_0000000000000000/contacts', { name: 'A', email: 'a@b.co' })).status, 404);
  assert.equal((await send('POST', `/api/job-hunt/jobs/${job.id}/contacts`, { name: 'A', email: 'a@b.co, c@d.co' })).status, 400);
  const created = await send('POST', `/api/job-hunt/jobs/${job.id}/contacts`, { name: 'Pat', email: 'pat@alpha.example', roleKind: 'recruiter', title: 'Talent' });
  assert.equal(created.status, 201);
  assert.equal((await send('POST', `/api/job-hunt/jobs/${job.id}/contacts`, { name: 'Pat', email: 'PAT@alpha.example' })).status, 409);
  const id = created.body.contact.id;
  assert.equal((await send('PATCH', `/api/job-hunt/contacts/${id}`, { roleKind: 'referral' })).body.contact.roleKind, 'referral');
  assert.equal((await send('PATCH', `/api/job-hunt/contacts/${id}`, { roleKind: 'nope' })).status, 400);
  assert.equal((await send('PATCH', '/api/job-hunt/contacts/9999', { name: 'x' })).status, 404);
  assert.equal((await send('PATCH', '/api/job-hunt/contacts/abc', { name: 'x' })).status, 400);
  assert.ok((await send('POST', `/api/job-hunt/contacts/${id}/contacted`)).body.contact.lastContactAt);
  assert.equal((await send('POST', '/api/job-hunt/contacts/9999/contacted')).status, 404);

  const dash = await (await fetch(`${base}/api/job-hunt/dashboard`)).json();
  assert.deepEqual(dash.contacts.map((c) => c.name), ['Pat', 'Jobs']);
  assert.equal(dash.contacts[0].company, 'Alpha');

  assert.equal((await send('DELETE', `/api/job-hunt/contacts/${id}`)).body.removed, true);
  assert.equal((await send('DELETE', `/api/job-hunt/contacts/${id}`)).body.removed, false);
  const jobs = (await (await fetch(`${base}/api/job-hunt/dashboard`)).json()).contacts;
  assert.deepEqual(jobs.map((c) => c.name), ['Jobs']);
  assert.equal((await send('DELETE', `/api/job-hunt/contacts/${jobs[0].id}`)).body.removed, true);
  assert.deepEqual((await (await fetch(`${base}/api/job-hunt/dashboard`)).json()).contacts, [], 'a removed listing contact is not seeded back');
});
