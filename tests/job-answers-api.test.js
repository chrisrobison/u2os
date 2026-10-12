import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { planApplication } from '../mcp/jobs/hunt/applications/form/submit.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';
import { customFragment, loadAnswers } from '../mcp/jobs/hunt/candidate/answers.js';
import { readJournal } from '../server/vault/journal.js';
import { RESUME, PREFS } from './fixtures/job-hunt-candidate.js';
import { startApplyForms } from './fixtures/apply-forms.js';
import { startServer } from './helpers/authed-server.js';

// #568: answering unanswered questions from the Job details page.

let forms;
let browserOk = true;
before(async () => {
  forms = await startApplyForms();
  try {
    const { chromium } = await import('playwright');
    if (!fs.existsSync(chromium.executablePath())) browserOk = false;
  } catch { browserOk = false; }
});
after(() => forms.close());

const ANSWERS = { work_authorization_us: true, requires_sponsorship: false, custom: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-answers-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const vault = process.env.U2OS_VAULT;
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'preferences.yaml'), `minimum_score: ${PREFS.minimum_score}\n`);
  fs.writeFileSync(path.join(vault, 'job-hunt', 'answers.yaml'), '# mine\nwork_authorization_us: true\nrequires_sponsorship: false\n');
  const pdf = path.join(dir, 'resume.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\nresume\n%%EOF\n');
  const store = openStore(huntDbPath(vault));
  const url = `${forms.base}/simple/extra`;
  const { job } = store.upsertSighting({ source: 'greenhouse', sourceKey: 'greenhouse:1#0', company: 'Tahoma AI', role: 'Engineer', rawText: 'x', applicationUrls: [url], contactEmails: [], author: 'a', locations: ['San Francisco'], remote: false });
  store.addArtifact(job.id, 'resume_pdf', pdf);
  const candidate = { resume: RESUME, preferences: PREFS, answers: ANSWERS, facts: { text: '' }, repos: [], digest: candidateDigest(RESUME, PREFS) };
  const application = await planApplication({ store, job: store.getJob(job.id), candidate, llm: null, now: new Date('2026-10-08T12:00:00Z') });
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { vault, job, application, post, get: (p) => fetch(`${base}${p}`) };
}

test('answers saved from the page resolve the questions and re-plan the application', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const { vault, job, application, post, get } = await fixture(t);
  assert.equal(application.status, 'needs_input');
  const keys = application.plan.unresolved.map((item) => item.key).sort();
  assert.deepEqual(keys, ['salary_now', 'scaled'], 'an open question and a sensitive one are waiting');

  const shown = await (await get(`/api/job-hunt/jobs/${job.id}`)).json();
  assert.deepEqual(shown.applications[0].plan.unresolved.map((item) => item.key).sort(), keys);

  const response = await post(`/api/job-hunt/jobs/${job.id}/answers`, { answers: [{ key: 'scaled', value: 'I scaled a dispatch platform to 14 vehicles.' }, { key: 'salary_now', value: 'Prefer to discuss' }] });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.saved, 2);
  assert.equal(body.status, 'planned');
  assert.equal(body.unresolved, 0);
  assert.equal(body.job.applications[0].status, 'planned');

  const custom = loadAnswers(vault).custom;
  assert.equal(custom[customFragment(application.plan.unresolved.find((item) => item.key === 'scaled').label)], 'I scaled a dispatch platform to 14 vehicles.', Object.keys(custom).join(' | '));
  const text = fs.readFileSync(path.join(vault, 'job-hunt', 'answers.yaml'), 'utf8');
  assert.ok(text.startsWith('# mine\n'), 'the owner\'s file is kept');
  const entry = readJournal({ vaultDir: vault }).entries.find((item) => item.type === 'config.changed' && item.data.file === 'job-hunt/answers.yaml');
  assert.equal(entry.data.channel, 'api');
  assert.ok(!JSON.stringify(entry).includes('dispatch platform'));

  const again = await post(`/api/job-hunt/jobs/${job.id}/answers`, { answers: [{ key: 'scaled', value: 'x' }] });
  assert.equal(again.status, 409, 'nothing is waiting any more');
});

test('only questions that are waiting can be answered, and bad input changes nothing', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const { vault, job, post } = await fixture(t);
  const file = path.join(vault, 'job-hunt', 'answers.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const forged = await post(`/api/job-hunt/jobs/${job.id}/answers`, { answers: [{ key: 'email', value: 'x', label: 'anything' }] });
  assert.equal(forged.status, 400);
  assert.equal((await post(`/api/job-hunt/jobs/${job.id}/answers`, { answers: [] })).status, 400);
  assert.equal((await post(`/api/job-hunt/jobs/${job.id}/answers`, { answers: [{ key: 'scaled', value: '' }] })).status, 400);
  assert.equal((await post(`/api/job-hunt/jobs/${job.id}/answers`, { answers: [{ key: 'scaled', value: 'x'.repeat(2001) }] })).status, 400);
  assert.equal((await post('/api/job-hunt/jobs/nope/answers', { answers: [{ key: 'scaled', value: 'x' }] })).status, 400);
  assert.equal((await post('/api/job-hunt/jobs/job_0000000000000000/answers', { answers: [{ key: 'scaled', value: 'x' }] })).status, 404);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
