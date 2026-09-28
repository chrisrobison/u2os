import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { writeRecord, recordFile } from '../mcp/jobs/ledger.js';
import { startServer } from './helpers/authed-server.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5c40000000049454e44ae426082', 'hex');

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
