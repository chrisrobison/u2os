import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { stageAttachment } from '../server/tools/email-attachments.js';
import { startServer } from './helpers/authed-server.js';

const SCORE = { score: 90, confidence: 0.9, label: 'exceptional', dimensions: { experience: { points: 24, max: 25, reason: 'x' } }, reasons: ['Direct overlap with U2OS'], concerns: ['On-site'], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-hunt-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const vault = process.env.U2OS_VAULT;
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify({ basics: { name: 'Pat Example', email: 'pat@example.com' }, work: [] }));
  const pdf = path.join(dir, 'resume.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
  const staged = stageAttachment(vault, pdf, { name: 'Pat_Resume.pdf' });
  const store = openStore(huntDbPath(vault));
  const add = (n, company, over = {}) => {
    const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${n}#0`, company, role: 'Head of Engineering', rawText: `${company} | Head of Engineering`, applicationUrls: [], contactEmails: [`hire@${company.toLowerCase()}.example`], author: 'a', locations: ['San Francisco'], remote: false });
    store.saveScore(job.id, { ...SCORE, ...over });
    const file = path.join(dir, `email-${n}.json`);
    fs.writeFileSync(file, JSON.stringify({ to: `hire@${company.toLowerCase()}.example`, subject: `Hello ${company}`, text: 'Hi,\n\nBody', attachments: [staged.ref], needsInput: [] }));
    store.addArtifact(job.id, 'email_json', file);
    return job;
  };
  const ready = add(1, 'Pond');
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { vault, ready, get: (url) => fetch(`${base}${url}`), post };
}

test('the page lists ranked jobs with the draft, why and the routes that are actually available', async (t) => {
  const { get, ready } = await fixture(t);
  const body = await (await get('/api/job-hunt/jobs')).json();
  assert.equal(body.minimumScore, 82);
  assert.equal(body.jobs[0].id, ready.id);
  assert.equal(body.jobs[0].score.score, 90);
  assert.equal(body.jobs[0].strategy.name, 'DIRECT_EMAIL');
  assert.deepEqual(body.jobs[0].draft.attachments, ['Pat_Resume.pdf']);
  assert.equal(body.sendRoutes.gmail, true);
  assert.equal(body.sendRoutes.apple_mail, false, 'the Apple add-on is not running in this test');
  const detail = await (await get(`/api/job-hunt/jobs/${ready.id}`)).json();
  assert.equal(detail.sources[0].author, 'a');
  assert.ok(detail.events.length >= 2);
  assert.equal((await get('/api/job-hunt/jobs/nope')).status, 400);
  assert.equal((await get('/api/job-hunt/jobs/job_0000000000000000')).status, 404);
});

test('send proposes through the gate, a second send is refused on any route, and approval marks the job contacted without stopping the server', async (t) => {
  const { get, post, ready } = await fixture(t);
  assert.equal((await post(`/api/job-hunt/jobs/${ready.id}/send`, { via: 'bogus' })).status, 400);
  const unavailable = await post(`/api/job-hunt/jobs/${ready.id}/send`, { via: 'apple_mail' });
  assert.equal(unavailable.status, 409);
  assert.match((await unavailable.json()).error, /Enable the Apple add-on/);
  assert.equal((await (await get('/api/job-hunt/jobs')).json()).jobs[0].emails.length, 0, 'an unavailable route records nothing');

  const sentCount = () => getDb().prepare("SELECT COUNT(*) AS n FROM emails WHERE folder = 'sent'").get().n;
  const baseline = sentCount();
  const sent = await post(`/api/job-hunt/jobs/${ready.id}/send`, { via: 'gmail' });
  assert.equal(sent.status, 200);
  const proposal = await sent.json();
  assert.equal(proposal.status, 'pending', 'email.send needs the owner\'s approval by default');
  assert.equal(sentCount(), baseline, 'nothing sent before approval');
  const again = await post(`/api/job-hunt/jobs/${ready.id}/send`, { via: 'gmail' });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already proposed/);

  const approved = await post(`/api/actions/${proposal.actionId}/approve`);
  assert.equal(approved.status, 200);
  const body = await (await get('/api/job-hunt/jobs')).json();
  assert.equal(body.jobs[0].status, 'contacted');
  assert.equal(body.jobs[0].emails[0].status, 'sent');
  assert.ok(body.jobs[0].emails[0].followUpAfter);
  assert.equal(sentCount(), baseline + 1);
  const mail = getDb().prepare("SELECT to_addr FROM emails WHERE folder = 'sent' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
  assert.equal(JSON.parse(mail.to_addr)[0], 'hire@pond.example');
  assert.equal((await post(`/api/job-hunt/jobs/${ready.id}/send`, { via: 'gmail' })).status, 409);
});

test('a rejected approval frees the job; a below-threshold job needs force; a missing resume is explained', async (t) => {
  const { vault, get, post } = await fixture(t);
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:7#0', company: 'Fig', role: 'Founding Engineer', rawText: 'Fig', applicationUrls: [], contactEmails: ['b@fig.example'], author: 'b' });
  store.saveScore(job.id, { ...SCORE, score: 80, label: 'strong' });
  const file = path.join(vault, 'fig.json');
  const ref = fs.readdirSync(path.join(vault, 'outbox')).map((hash) => `outbox/${hash}/Pat_Resume.pdf`)[0];
  fs.writeFileSync(file, JSON.stringify({ to: 'b@fig.example', subject: 'Fig', text: 'T', attachments: [ref], needsInput: [] }));
  store.addArtifact(job.id, 'email_json', file);
  store.close();
  const refused = await post(`/api/job-hunt/jobs/${job.id}/send`, { via: 'gmail' });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /below the threshold 82/);
  const forced = await (await post(`/api/job-hunt/jobs/${job.id}/send`, { via: 'gmail', force: true })).json();
  assert.equal(forced.status, 'pending');
  await post(`/api/actions/${forced.actionId}/reject`);
  const view = (await (await get('/api/job-hunt/jobs')).json()).jobs.find((entry) => entry.id === job.id);
  assert.equal(view.emails[0].status, 'rejected');
  assert.equal(view.status, 'scored', 'a rejected send leaves the job open');
  fs.rmSync(path.join(vault, 'job-hunt', 'resume.json'));
  assert.equal((await post(`/api/job-hunt/jobs/${job.id}/send`, { via: 'gmail', force: true })).status, 409);
});

test('mark-sent records a send made by hand and blocks any further send; bulk drafts need the Apple add-on', async (t) => {
  const { get, post, ready } = await fixture(t);
  const draftAll = await post('/api/job-hunt/drafts', {});
  assert.equal(draftAll.status, 409);
  assert.match((await draftAll.json()).error, /Enable the Apple add-on/);
  const marked = await post(`/api/job-hunt/jobs/${ready.id}/mark-sent`, {});
  assert.equal(marked.status, 200);
  assert.equal((await marked.json()).email.status, 'sent');
  const view = (await (await get('/api/job-hunt/jobs')).json()).jobs[0];
  assert.equal(view.status, 'contacted');
  assert.ok(view.emails[0].followUpAfter);
  assert.equal((await post(`/api/job-hunt/jobs/${ready.id}/mark-sent`, {})).status, 400, 'not recorded twice');
  assert.equal((await post(`/api/job-hunt/jobs/${ready.id}/send`, { via: 'gmail' })).status, 409, 'and never proposed again');
  assert.equal((await post('/api/job-hunt/jobs/bad/mark-sent', {})).status, 400);
});
