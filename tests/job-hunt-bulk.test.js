import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractEmails } from '../mcp/jobs/hunt/jobs/parser.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { recordManualSend, proposeApplicationEmail, reconcileEmails } from '../mcp/jobs/hunt/applications/send.js';
import { proposeBulkDrafts } from '../mcp/jobs/hunt/applications/bulk.js';
import { main as jobCli } from '../server/jobhunt/cli.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const REF = `outbox/${'b'.repeat(64)}/Pat_Resume.pdf`;
const SCORE = { score: 72, confidence: 0.8, label: 'plausible', dimensions: {}, reasons: ['ok'], concerns: [], recommendedNarrative: 'staff-principal', projects: [], flags: [], degraded: false };

test('prose is not an address; real obfuscations and plain addresses still parse', () => {
  for (const prose of ['we would like you to be at home. We are remote', 'experience at scale.check', 'engineers at albert.we', 'looking at example dot', 'send it to me at home']) assert.deepEqual(extractEmails(prose), [], prose);
  assert.deepEqual(extractEmails('Email me directly: dylan [at] quill [dot] example'), ['dylan@quill.example']);
  assert.deepEqual(extractEmails('jobs at acme dot com'), ['jobs@acme.com']);
  assert.deepEqual(extractEmails('reach out: jane (at) foo.io'), ['jane@foo.io']);
  assert.deepEqual(extractEmails('email chris.zehner at fazeshift.com'), ['chris.zehner@fazeshift.com']);
  assert.deepEqual(extractEmails('Contact founder@acme.com or founder@acme.com.'), ['founder@acme.com']);
});

function world(n = 1, { to = 'hire@x.example', draft = {}, score = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-bulk-'));
  const store = openStore(':memory:');
  const jobs = [];
  for (let i = 0; i < n; i += 1) {
    const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${i}#0`, company: `Co${i}`, role: 'Staff Engineer', rawText: `Co${i}`, applicationUrls: [], contactEmails: [to.replace('x', `co${i}`)], author: 'a' });
    store.saveScore(job.id, { ...SCORE, ...score });
    const file = path.join(dir, `e${i}.json`);
    fs.writeFileSync(file, JSON.stringify({ to: to.replace('x', `co${i}`), subject: `S${i}`, text: 'T', attachments: [REF], needsInput: [], ...draft }));
    store.addArtifact(job.id, 'email_json', file);
    jobs.push(store.getJob(job.id));
  }
  return { store, jobs, dir };
}

test('a send made by hand is recorded: the job is contacted and can never be proposed again', async () => {
  const { store, jobs } = world();
  const email = recordManualSend({ store, job: jobs[0], candidateEmail: 'pat@example.com', now: NOW });
  assert.equal(email.status, 'sent');
  assert.equal(email.detail.manual, true);
  assert.equal(store.getJob(jobs[0].id).status, 'contacted');
  assert.equal(email.detail.followUpAfter, '2026-10-13T12:00:00.000Z');
  assert.throws(() => recordManualSend({ store, job: store.getJob(jobs[0].id), candidateEmail: 'pat@example.com' }), /already recorded as emailed/);
  await assert.rejects(proposeApplicationEmail({ store, job: store.getJob(jobs[0].id), candidateEmail: 'pat@example.com', minimumScore: 0, propose: async () => ({ id: 'x', status: 'pending' }) }), /already/);
  assert.throws(() => recordManualSend({ store: world().store, job: world().jobs[0], candidateEmail: 'p@e.com', to: '' }), /./);
});

test('a manual record after a draft was proposed or an earlier failed attempt reuses the key', async () => {
  const { store, jobs } = world();
  await proposeApplicationEmail({ store, job: jobs[0], candidateEmail: 'pat@example.com', minimumScore: 0, tool: 'apple_mail.draft', propose: async () => ({ id: 'act_1', status: 'pending' }), now: NOW });
  reconcileEmails({ store, lookup: () => ({ status: 'executed' }), now: NOW });
  assert.equal(store.listEmails(jobs[0].id)[0].status, 'drafted');
  assert.equal(store.getJob(jobs[0].id).status, 'scored', 'a draft does not mark the job contacted');
  recordManualSend({ store, job: store.getJob(jobs[0].id), candidateEmail: 'pat@example.com', now: NOW });
  assert.equal(store.getJob(jobs[0].id).status, 'contacted');
});

test('bulk drafts: only ready email-routable jobs, below-threshold allowed, idempotent, nothing sent', async () => {
  const { store, jobs } = world(3);
  // Co1 needs input; Co2 is already contacted.
  const needs = store.getArtifacts(jobs[1].id).email_json.path;
  fs.writeFileSync(needs, JSON.stringify({ to: 'hire@co1.example', subject: 'S', text: 'T', attachments: [REF], needsInput: ['a link'] }));
  recordManualSend({ store, job: jobs[2], candidateEmail: 'pat@example.com', now: NOW });
  const proposals = [];
  const propose = async (proposal) => { proposals.push(proposal); return { id: `act_${proposals.length}`, status: 'pending' }; };
  const first = await proposeBulkDrafts({ store, candidateEmail: 'pat@example.com', minimumScore: 82, propose });
  assert.deepEqual(first.proposed.map((entry) => entry.company), ['Co0']);
  assert.ok(first.skipped.some((entry) => entry.company === 'Co1' && /needs your input/.test(entry.reason)));
  assert.ok(first.skipped.some((entry) => entry.company === 'Co2'));
  assert.deepEqual(proposals.map((proposal) => proposal.tool), ['apple_mail.draft'], 'only drafts are ever proposed');
  const again = await proposeBulkDrafts({ store, candidateEmail: 'pat@example.com', minimumScore: 82, propose });
  assert.equal(again.proposed.length, 0);
  assert.equal(proposals.length, 1);
});

test('bulk drafts respect min score and jobs without an email route', async () => {
  const { store } = world(1, { score: { score: 65, label: 'weak' } });
  const none = await proposeBulkDrafts({ store, candidateEmail: 'p@e.com', minimumScore: 82, minScore: 70, propose: async () => ({ id: 'a', status: 'pending' }) });
  assert.deepEqual([none.proposed.length, none.skipped.length, none.failed.length], [0, 0, 0]);
});

test('CLI: mark sent and reparse', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-mark-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify({ basics: { name: 'Pat', email: 'pat@example.com' }, work: [] }));
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:1#0', company: 'Albert', role: 'Principal', rawText: 'Albert | Principal. engineers at albert.we or recruiting@albert.com', applicationUrls: [], contactEmails: ['engineers@albert.we', 'recruiting@albert.com'], author: 'a' });
  store.close();
  const lines = [];
  const out = { log: (line) => lines.push(line) };
  assert.equal(await jobCli(['reparse'], out, { vaultDir: vault, now: NOW }), 0);
  assert.match(lines.join('\n'), /engineers@albert\.we, recruiting@albert\.com -> recruiting@albert\.com/);
  lines.length = 0;
  assert.equal(await jobCli(['mark', job.id, 'sent'], out, { vaultDir: vault, now: NOW }), 0);
  assert.match(lines.join('\n'), /recorded as emailed to recruiting@albert\.com/);
  assert.equal(await jobCli(['mark', job.id, 'sent'], out, { vaultDir: vault, now: NOW }).catch(() => 1), 1);
});
