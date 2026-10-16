import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { writeRecord, recordFile } from '../mcp/jobs/ledger.js';
import { startServer } from './helpers/authed-server.js';
import { tinyPng } from './helpers/png.js';

const PNG = tinyPng();

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-job-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  return { dir, vault: process.env.U2OS_VAULT, get: (url) => fetch(`${base}${url}`) };
}

test('the ledger is listed newest first with counts, filters and the owner\'s record', async (t) => {
  const { vault, get } = await fixture(t);
  assert.deepEqual((await (await get('/api/job-applications')).json()).applications, [], 'no ledger yet');
  const shot = path.relative(vault, recordFile(vault, 'lever:globex:abc-1').replace(/\.md$/, '-form.png')).split(path.sep).join('/');
  writeRecord(vault, { job_id: 'greenhouse:acme:101', company: 'Acme Corp', title: 'Senior Engineer', status: 'needs_answers', url: 'https://job-boards.greenhouse.io/acme/jobs/101', open_questions: [{ name: 'question_2', label: 'Why Acme?' }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  writeRecord(vault, { job_id: 'lever:globex:abc-1', company: 'globex', title: 'Staff Engineer', status: 'applied', applied_at: '2026-09-28T08:00:00Z', url: 'javascript:alert(1)', answered: { 'Best system?': 'A ledger.' }, screenshot: shot, result_screenshot: '../../etc/passwd' }, 'My cover letter.');
  const body = await (await get('/api/job-applications')).json();
  assert.equal(body.counts.applied, 1);
  assert.equal(body.counts.needs_answers, 1);
  assert.deepEqual(body.applications.map((item) => item.jobId), ['lever:globex:abc-1', 'greenhouse:acme:101']);
  const [applied, pending] = body.applications;
  assert.equal(applied.coverLetter, 'My cover letter.');
  assert.deepEqual(applied.answered, { 'Best system?': 'A ledger.' });
  assert.equal(applied.url, null, 'only http(s) links');
  assert.deepEqual(applied.screenshots, [shot], 'only ledger screenshots');
  assert.deepEqual(pending.openQuestions, [{ name: 'question_2', label: 'Why Acme?' }]);
  const filtered = await (await get('/api/job-applications?status=applied')).json();
  assert.deepEqual(filtered.applications.map((item) => item.jobId), ['lever:globex:abc-1']);
  assert.equal((await get('/api/job-applications?status=bogus')).status, 400);
});

test('screenshots are served only from the ledger folder', async (t) => {
  const { dir, vault, get } = await fixture(t);
  const ledger = path.join(vault, 'job-hunt', 'applications');
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(path.join(ledger, 'lever-globex-abc-1-form.png'), PNG);
  const ok = await get('/api/job-applications/screenshot?path=job-hunt/applications/lever-globex-abc-1-form.png');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);

  fs.writeFileSync(path.join(dir, 'secret.png'), 'secret');
  fs.symlinkSync(path.join(dir, 'secret.png'), path.join(ledger, 'link.png'));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'outside.png'), PNG);
  for (const [query, status] of [
    ['job-hunt/applications/link.png', 404],
    ['job-hunt/applications/missing.png', 404],
    ['job-hunt/outside.png', 400],
    ['job-hunt/applications/../../secret.png', 400],
    ['job-hunt/applications/notes.md', 400],
    ['/etc/passwd', 400],
  ]) assert.equal((await get(`/api/job-applications/screenshot?path=${encodeURIComponent(query)}`)).status, status, query);
});

test('applications the autopilot emailed or submitted are listed from the hunt store, and the ledger wins', async (t) => {
  const { vault, get } = await fixture(t);
  const { openStore, huntDbPath } = await import('../mcp/jobs/hunt/storage/store.js');
  const store = openStore(huntDbPath(vault));
  const sighting = (company, role) => ({ company, role, applicationUrls: [`https://example.com/${company}`], contactEmails: [], source: 'hackernews', sourceKey: `test:${company}`, rawText: 'x', author: null });
  const emailed = store.upsertSighting(sighting('Astoria AI', 'Founding AI Engineer')).job;
  const unsent = store.upsertSighting(sighting('Draftco', 'Engineer')).job;
  const submitted = store.upsertSighting(sighting('Formco', 'Engineer')).job;
  const both = store.upsertSighting(sighting('Bothco', 'Engineer')).job;
  const email = (job, status, kind = 'application') => store.addEmail(job.id, { kind, to: 'hire@example.com', subject: `HN ${job.company}`, body: 'Hi there', attachments: ['outbox/abc/Resume.pdf'], status, idempotencyKey: `${job.id}:${kind}:${status}` });
  email(emailed, 'sent');
  email(unsent, 'drafted');
  email(emailed, 'sent', 'draft');
  store.addApplication(submitted.id, { url: 'https://boards.greenhouse.io/formco/jobs/1', status: 'submitted', plan: { planHash: 'h1' }, idempotencyKey: 'form-1' });
  store.addApplication(unsent.id, { url: 'https://boards.greenhouse.io/draftco/jobs/1', status: 'planned', plan: { planHash: 'h2' }, idempotencyKey: 'form-2' });
  email(both, 'sent');
  store.close();
  writeRecord(vault, { job_id: both.id, company: 'Bothco', title: 'Engineer', status: 'skipped' });

  const body = await (await get('/api/job-applications')).json();
  const byCompany = Object.fromEntries(body.applications.map((item) => [item.company, item]));
  assert.deepEqual(Object.keys(byCompany).sort(), ['Astoria AI', 'Bothco', 'Formco']);
  assert.equal(byCompany['Astoria AI'].status, 'emailed');
  assert.equal(byCompany['Astoria AI'].emailedTo, 'hire@example.com');
  assert.equal(byCompany['Astoria AI'].subject, 'HN Astoria AI');
  assert.deepEqual(byCompany['Astoria AI'].attachments, ['Resume.pdf']);
  assert.equal(byCompany.Formco.status, 'applied');
  assert.equal(byCompany.Bothco.status, 'skipped', 'the ledger record wins');
  assert.equal(body.counts.emailed, 1);
  const filtered = await (await get('/api/job-applications?status=emailed')).json();
  assert.deepEqual(filtered.applications.map((item) => item.company), ['Astoria AI']);
});

test('a vault without a hunt database lists nothing and does not create one', async (t) => {
  const { vault, get } = await fixture(t);
  assert.deepEqual((await (await get('/api/job-applications')).json()).applications, []);
  assert.equal(fs.existsSync(path.join(vault, 'job-hunt', 'state', 'hunt.sqlite')), false);
});
