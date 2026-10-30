import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { Router } from '../server/api/router.js';
import { registerJobHuntRoutes } from '../server/api/routes/job-hunt.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';
import { loadFacts } from '../mcp/jobs/hunt/candidate/facts.js';
import { ANSWERS, MAX_DETAIL, applyFactsLine, evidenceQuestions, evidenceRelativePath, evidenceView, readEvidence, rescoreJob, saveEvidenceAnswer } from '../mcp/jobs/hunt/evidence.js';
import { jobView } from '../mcp/jobs/hunt/view.js';
import { parseMarkdown } from '../server/vault/markdown.js';
import { RESUME, PREFS, fakeLlm, modelAnswer } from './fixtures/job-hunt-candidate.js';

// #636: evidence resolution. The owner states whether they can back up an unverified item; the answer is stored with
// provenance (job-hunt/evidence/<job>.md, plus a marked line in facts.md for Yes and Partly) and the job is scored again by
// the existing scorer. Module tests, then the routes.

const NOW = new Date('2026-10-30T12:00:00.000Z');
const SCORE = {
  score: 74, confidence: 0.62, label: 'plausible', recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'old-model',
  reasons: [], concerns: ['No Go experience listed', 'Scored by rules without a model; capped below the autonomous threshold', 'On-site in Austin, outside the Bay Area: relocation required'],
  dimensions: {
    experience: { points: 20, max: 25, reason: 'Ten years of backend work' }, technical: { points: 9, max: 15, reason: 'Partial overlap with the stack' },
    seniority: { points: 15, max: 20, reason: 'Level looks right' }, projects: { points: 5, max: 15, reason: 'One related project' },
    location: { points: 1, max: 10, reason: 'On-site away from home' }, compensation: { points: 3, max: 5, reason: 'Compensation not stated' },
  },
};
const dirs = [];
afterEach(() => { closeAllForTests(); while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT; });

function fixture({ withCandidate = true, status = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-evidence-'));
  dirs.push(dir);
  process.env.U2OS_HOME = path.join(dir, 'home');
  const vault = path.join(dir, 'vault');
  process.env.U2OS_VAULT = vault;
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  if (withCandidate) {
    fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
    fs.writeFileSync(path.join(vault, 'job-hunt', 'preferences.yaml'), `minimum_score: ${PREFS.minimum_score}\nminimum_salary: 170000\n`);
  }
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:9#0', company: 'Tahoma AI', role: 'Staff Engineer', locations: ['San Francisco, CA'], remote: false, technologies: ['Go'], description: 'Agents in Go.', rawText: 'Tahoma AI | Staff Engineer | Go', applicationUrls: [], contactEmails: [], author: 'f' });
  store.saveScore(job.id, SCORE, new Date('2026-10-01T00:00:00.000Z'));
  if (status) store.transition(job.id, status, {}, new Date('2026-10-02T00:00:00.000Z'));
  return { dir, vault, store, job: store.getJob(job.id) };
}
const questionsOf = (store, job) => evidenceQuestions({ score: store.getScore(job.id), review: store.listReviews(job.id)[0] ?? null });
const keyFor = (questions, fragment) => questions.find((question) => question.statement.includes(fragment)).key;
const save = (f, key, answer, detail = '', now = NOW) => saveEvidenceAnswer({ vaultDir: f.vault, job: f.job, questions: questionsOf(f.store, f.job), key, answer, detail, now });
const llmFor = (fake) => createLlm([fake.provider]);

// ---- questions ------------------------------------------------------------------------------

test('questions come from the stored score: judged dimensions and unconfirmed concerns, never rules or the caveat', () => {
  const f = fixture();
  const questions = questionsOf(f.store, f.job);
  assert.deepEqual(questions.map((question) => question.key).filter((key) => key.startsWith('dim:')), ['dim:experience', 'dim:seniority', 'dim:technical'], 'projects, location and compensation are not model-judged questions');
  assert.equal(questions.find((question) => question.key === 'dim:technical').statement, 'Technical: Partial overlap with the stack');
  const concerns = questions.filter((question) => question.kind === 'concern');
  assert.deepEqual(concerns.map((question) => question.statement), ['No Go experience listed'], 'the rules-only caveat and the relocation rule concern get no question');
  assert.match(concerns[0].key, /^concern:[0-9a-f]{12}$/);
  assert.equal(concerns[0].key, questionsOf(f.store, f.job).find((question) => question.kind === 'concern').key, 'the key is stable');
  assert.deepEqual(evidenceQuestions({ score: null }), []);
  const reviewed = evidenceQuestions({ score: SCORE, review: { concerns: [{ severity: 'minor', text: 'Resume gap year' }, { severity: 'blocking', text: 'Blocked' }, { text: ' ' }] } });
  assert.ok(reviewed.some((question) => question.statement === 'Resume gap year' && question.source === 'Review'));
  assert.ok(!reviewed.some((question) => question.statement === 'Blocked'));
  f.store.close();
});

// ---- saving, provenance, facts.md ---------------------------------------------------------------

test('a Yes is stored with provenance (owner, job, key, time) and mirrored into facts.md without touching the owner\'s text', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.vault, 'job-hunt', 'facts.md'), '# Facts\n\n- Built dispatch software\n\n## Project: U2OS\n\nAn agent OS.\n');
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  const { entry, changed } = save(f, key, 'yes', 'Shipped Go services for four years');
  assert.equal(changed, true);
  assert.deepEqual(entry, { key, answer: 'yes', detail: 'Shipped Go services for four years', label: 'Technical: Partial overlap with the stack', source: 'owner', job: f.job.id, at: NOW.toISOString() });

  const file = path.join(f.vault, evidenceRelativePath(f.job.id));
  const { frontmatter, body } = parseMarkdown(fs.readFileSync(file, 'utf8'));
  assert.equal(frontmatter.job, f.job.id);
  assert.equal(frontmatter.updated, NOW.toISOString());
  assert.deepEqual(frontmatter.answers, [entry]);
  assert.match(body, /Yes: Technical: Partial overlap with the stack \(Shipped Go services/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readEvidence(f.vault, f.job.id).answers, [entry]);

  const facts = fs.readFileSync(path.join(f.vault, 'job-hunt', 'facts.md'), 'utf8');
  assert.ok(facts.startsWith('# Facts\n\n- Built dispatch software\n\n## Project: U2OS\n\nAn agent OS.\n'), 'what the owner wrote is untouched');
  assert.match(facts, /## Owner-stated evidence\n\n- <!-- u2-evidence job_[0-9a-f]{16} dim:technical --> Stated by the owner on 2026-10-30 \(job job_[0-9a-f]{16}, dim:technical\): can back up "Technical: Partial overlap with the stack" - Shipped Go services for four years\n$/);
  assert.deepEqual(loadFacts(f.vault).projects, ['U2OS'], 'the project headings still parse');
  assert.deepEqual(fs.readdirSync(path.join(f.vault, 'job-hunt')).filter((name) => name.includes('.tmp')), [], 'no temporary file is left behind');
  f.store.close();
});

test('a No is a recorded gap only: it is never written to facts.md, and changing an answer replaces the old one everywhere', () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'No Go experience');
  save(f, key, 'yes', 'Two Go services');
  assert.match(fs.readFileSync(path.join(f.vault, 'job-hunt', 'facts.md'), 'utf8'), /can back up "No Go experience listed"/);
  const later = new Date('2026-10-31T09:00:00.000Z');
  save(f, key, 'no', '', later);
  assert.equal(fs.readFileSync(path.join(f.vault, 'job-hunt', 'facts.md'), 'utf8').trim(), '', 'the Yes line and its now-empty section are removed');
  const answers = readEvidence(f.vault, f.job.id).answers;
  assert.deepEqual(answers.map((entry) => [entry.key, entry.answer, entry.at]), [[key, 'no', later.toISOString()]]);
  const first = save(f, keyFor(questionsOf(f.store, f.job), 'Experience'), 'partly', 'Only prototypes');
  assert.match(fs.readFileSync(path.join(f.vault, 'job-hunt', 'facts.md'), 'utf8'), /can partly back up "Experience: Ten years of backend work" - Only prototypes/);
  assert.equal(first.entry.answer, 'partly');
  assert.equal(readEvidence(f.vault, f.job.id).answers.length, 2);
  f.store.close();
});

test('saving the same answer again changes nothing (idempotent) and repairs a missing facts.md line', () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Seniority');
  const first = save(f, key, 'yes', 'Led a team of six');
  const file = path.join(f.vault, evidenceRelativePath(f.job.id));
  const bytes = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  const again = save(f, key, 'yes', ' Led a team of six \n', new Date('2027-01-01T00:00:00.000Z'));
  assert.equal(again.changed, false);
  assert.deepEqual(again.entry, first.entry, 'the original timestamp is kept');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'the file is not rewritten');
  const factsFile = path.join(f.vault, 'job-hunt', 'facts.md');
  const facts = fs.readFileSync(factsFile, 'utf8');
  fs.writeFileSync(factsFile, '');
  save(f, key, 'yes', 'Led a team of six');
  assert.equal(fs.readFileSync(factsFile, 'utf8'), facts, 'the mirror is repaired by saving again');
  assert.equal(applyFactsLine(facts, { jobId: f.job.id, key: 'dim:nothing', line: null }), facts);
  f.store.close();
});

test('input is validated: unknown or invented questions, bad answers, oversized or control-character detail, bad ids', () => {
  const f = fixture();
  const questions = questionsOf(f.store, f.job);
  const key = keyFor(questions, 'Technical');
  const bad = (over, code) => assert.throws(() => saveEvidenceAnswer({ vaultDir: f.vault, job: f.job, questions, key, answer: 'yes', detail: '', now: NOW, ...over }), { code });
  bad({ key: 'dim:interest' }, 'BAD_INPUT'); // a real kind of key, but not a question on this job
  bad({ key: 'concern:000000000000' }, 'BAD_INPUT');
  bad({ key: '../../etc/passwd' }, 'BAD_INPUT');
  bad({ key: 42 }, 'BAD_INPUT');
  for (const answer of ['maybe', 'YES', '', null, true, undefined]) bad({ answer }, 'BAD_INPUT');
  bad({ detail: 'x'.repeat(MAX_DETAIL + 1) }, 'TOO_LARGE');
  bad({ detail: 'ok\u0000nul' }, 'BAD_INPUT');
  bad({ detail: 'bell\u0007' }, 'BAD_INPUT');
  bad({ detail: { not: 'text' } }, 'BAD_INPUT');
  bad({ job: { id: '../x' } }, 'BAD_INPUT');
  assert.deepEqual(ANSWERS, ['yes', 'no', 'partly']);
  assert.equal(fs.existsSync(path.join(f.vault, 'job-hunt', 'evidence')), false, 'a refused answer writes nothing');
  assert.equal(save(f, key, 'yes', 'x'.repeat(MAX_DETAIL)).changed, true, 'exactly the limit is fine');
  assert.equal(readEvidence(f.vault, f.job.id).answers[0].detail.length, MAX_DETAIL);
  f.store.close();
});

test('detail with markup, comment markers and newlines stays text, and the facts line stays one line', () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  save(f, key, 'yes', '<script>alert(1)</script> --> <!-- sneaky\nsecond line');
  const facts = fs.readFileSync(path.join(f.vault, 'job-hunt', 'facts.md'), 'utf8');
  const line = facts.split('\n').find((entry) => entry.startsWith('- <!-- u2-evidence'));
  assert.ok(line && !line.slice(line.indexOf('-->') + 3).includes('<!--') && !line.slice(line.indexOf('-->') + 3).includes('-->'), 'the detail cannot forge or close a marker');
  assert.equal(facts.trim().split('\n').filter((entry) => entry.includes('second line')).length, 1);
  assert.equal(readEvidence(f.vault, f.job.id).answers[0].detail, '<script>alert(1)</script> --> <!-- sneaky\nsecond line', 'the record keeps the owner\'s exact words');
  f.store.close();
});

test('links are refused: a symlinked evidence folder, evidence file or facts.md is never followed', () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  const outside = path.join(f.dir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.vault, 'job-hunt', 'evidence'));
  assert.throws(() => save(f, key, 'yes'), { code: 'UNSAFE_PATH' });
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the link');
  fs.rmSync(path.join(f.vault, 'job-hunt', 'evidence'));

  fs.writeFileSync(path.join(outside, 'target.md'), 'secret');
  fs.symlinkSync(path.join(outside, 'target.md'), path.join(f.vault, 'job-hunt', 'facts.md'));
  assert.throws(() => save(f, key, 'yes'), { code: 'UNSAFE_PATH' });
  assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), 'secret');
  f.store.close();
});

test('a hand-edited record is read tolerantly: entries for another job or with bad values are ignored', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.vault, 'job-hunt', 'evidence'), { recursive: true });
  const good = { key: 'dim:technical', answer: 'yes', detail: 'ok', label: 'L', source: 'owner', job: f.job.id, at: NOW.toISOString() };
  const text = `---\njob: ${f.job.id}\nanswers:\n${[good, { ...good, key: 'dim:experience', job: 'job_ffffffffffffffff' }, { ...good, key: 'dim:seniority', answer: 'sure' }, { ...good, key: '../x' }, { ...good, key: 'dim:company', source: 'model' }, 'junk'].map((entry) => `  - ${JSON.stringify(entry)}`).join('\n')}\n---\nhand written\n`;
  fs.writeFileSync(path.join(f.vault, evidenceRelativePath(f.job.id)), text);
  assert.deepEqual(readEvidence(f.vault, f.job.id).answers, [good]);
  fs.writeFileSync(path.join(f.vault, evidenceRelativePath(f.job.id)), '---\n: : bad\n---\n');
  assert.throws(() => readEvidence(f.vault, f.job.id), { code: 'EVIDENCE_INVALID' });
  const view = jobView(f.store, f.store.getJob(f.job.id), { detail: true, vaultDir: f.vault });
  assert.match(view.evidence.error, /invalid frontmatter/);
  assert.deepEqual(view.evidence.answers, [], 'a damaged file never breaks the job view');
  f.store.close();
});

test('the job view carries the questions, the answers and whether the score is out of date', async () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  let view = jobView(f.store, f.store.getJob(f.job.id), { detail: true, vaultDir: f.vault });
  assert.equal(view.evidence.questions.length, 4);
  assert.equal(view.evidence.rescorePending, false);
  assert.equal('evidence' in jobView(f.store, f.store.getJob(f.job.id), { vaultDir: f.vault }), false, 'the list view is unchanged');
  save(f, key, 'yes', 'Go');
  view = jobView(f.store, f.store.getJob(f.job.id), { detail: true, vaultDir: f.vault });
  assert.equal(view.evidence.rescorePending, true, 'the answer is newer than the score');
  assert.equal(view.evidence.lastAnsweredAt, NOW.toISOString());
  const done = await rescoreJob({ vaultDir: f.vault, store: f.store, job: f.job, llm: llmFor(fakeLlm(modelAnswer({ experience: 20, seniority: 15, technical: 12 }))), now: NOW });
  assert.equal(done.status, 'done');
  assert.equal(evidenceView({ vaultDir: f.vault, store: f.store, job: f.job }).rescorePending, false);
  f.store.close();
});

// ---- rescoring through the existing scorer ---------------------------------------------------------

test('rescoring runs the existing scorer with the owner\'s statements in the digest and reports previous and new honestly', async () => {
  const f = fixture();
  const questions = questionsOf(f.store, f.job);
  save(f, keyFor(questions, 'Technical'), 'yes', 'Four years of Go');
  save(f, keyFor(questions, 'No Go experience'), 'no');
  const fake = fakeLlm(modelAnswer({ experience: 22, seniority: 16, technical: 13, projects: 6, company: 3, interest: 3 }));
  const result = await rescoreJob({ vaultDir: f.vault, store: f.store, job: f.job, llm: llmFor(fake), now: NOW });
  assert.equal(result.status, 'done');
  assert.deepEqual([result.previous.score, result.previous.confidence, result.previous.model], [74, 0.62, 'old-model']);
  assert.equal(fake.calls.length, 1, 'one call to the model, through scoreJob');
  assert.match(fake.calls[0].system, /You score how well one job listing fits one candidate/, 'the existing scoring prompt');
  assert.match(fake.calls[0].user, /OWNER-STATED EVIDENCE FOR THIS JOB/);
  assert.match(fake.calls[0].user, /\* Technical: Partial overlap with the stack -> YES, can back this up: Four years of Go/);
  assert.match(fake.calls[0].user, /\* No Go experience listed -> NO \(the candidate says this is a real gap\)/);
  const stored = f.store.getScore(f.job.id);
  assert.equal(stored.model, 'fake-model');
  assert.equal(stored.degraded, false);
  assert.equal(result.current.score, stored.score);
  assert.equal(result.current.confidence, 0.85);
  assert.equal(stored.scoredAt, NOW.toISOString());
  // 22+16+13+6+3+3 from the model; location (on-site, away from the Bay Area? SF is home) and compensation come from the rules.
  assert.equal(stored.dimensions.technical.points, 13, 'the model\'s own number, clamped by code: nothing was added for the owner\'s Yes');
  assert.equal(f.store.listEvents(f.job.id).filter((event) => event.type === 'scored').length, 2);
  f.store.close();
});

test('the digest is unchanged when the owner stated nothing', () => {
  assert.equal(candidateDigest(RESUME, PREFS, { ownerEvidence: [] }), candidateDigest(RESUME, PREFS));
  assert.ok(!candidateDigest(RESUME, PREFS).includes('OWNER-STATED'));
});

test('no model, a failing model or a rule fallback never replaces the stored score: the answer stays and the status says why', async () => {
  const f = fixture();
  save(f, keyFor(questionsOf(f.store, f.job), 'Technical'), 'yes');
  const before = f.store.getScore(f.job.id);
  const offline = await rescoreJob({ vaultDir: f.vault, store: f.store, job: f.job, llm: null, now: NOW });
  assert.equal(offline.status, 'pending');
  assert.match(offline.reason, /No model is available/);
  assert.equal(offline.current, null);
  assert.equal(offline.previous.score, 74);
  const down = fakeLlm(new Error('model is down'));
  const fallback = await rescoreJob({ vaultDir: f.vault, store: f.store, job: f.job, llm: llmFor(down), now: NOW });
  assert.equal(fallback.status, 'failed', 'the scorer fell back to rules, which ignore the answer, so that estimate is not kept');
  assert.match(fallback.reason, /rule-based estimate/);
  const garbage = await rescoreJob({ vaultDir: f.vault, store: f.store, job: f.job, llm: llmFor(fakeLlm('not json')), now: NOW });
  assert.equal(garbage.status, 'failed');
  assert.deepEqual(f.store.getScore(f.job.id), before, 'the score is exactly as it was');
  assert.equal(readEvidence(f.vault, f.job.id).answers.length, 1, 'the answer is still saved');
  assert.equal(evidenceView({ vaultDir: f.vault, store: f.store, job: f.job }).rescorePending, true, 'so the panel can offer a retry');
  f.store.close();
});

test('a missing resume fails the rescore cleanly; settled jobs and unscored jobs are skipped', async () => {
  const noResume = fixture({ withCandidate: false });
  const failed = await rescoreJob({ vaultDir: noResume.vault, store: noResume.store, job: noResume.job, llm: llmFor(fakeLlm(modelAnswer())), now: NOW });
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /No resume/);
  noResume.store.close();

  const applied = fixture({ status: 'applied' });
  const skipped = await rescoreJob({ vaultDir: applied.vault, store: applied.store, job: applied.store.getJob(applied.job.id), llm: llmFor(fakeLlm(modelAnswer())), now: NOW });
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.reason, /applied/);
  assert.equal(applied.store.getScore(applied.job.id).score, 74);
  applied.store.close();
});

// ---- routes ------------------------------------------------------------------------------------------

function routes(options) {
  const router = new Router();
  registerJobHuntRoutes(router, { agent: null, toolRegistry: { get: () => null }, ...options });
  const call = async (method, p, { params = {}, body = {} } = {}) => {
    const route = router.routes.find((entry) => entry.method === method && entry.path === p);
    assert.ok(route, `${method} ${p} is registered`);
    const out = {};
    await route.handler({ params, body, query: {} }, { writeHead: (status) => { out.status = status; }, end: (text) => { out.body = JSON.parse(text); } });
    return out;
  };
  return { router, call };
}

test('POST /evidence saves, rescores with the existing scorer, returns previous vs new, and the job view shows the answer', async () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  f.store.close();
  const fake = fakeLlm(modelAnswer({ experience: 22, seniority: 16, technical: 13, projects: 6, company: 3, interest: 3 }));
  const { call } = routes({ jobLlm: llmFor(fake) });
  const response = await call('POST', '/api/job-hunt/jobs/:id/evidence', { params: { id: f.job.id }, body: { key, answer: 'yes', detail: 'Four years of Go' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.changed, true);
  assert.deepEqual([response.body.saved.source, response.body.saved.job, response.body.saved.key, response.body.saved.answer], ['owner', f.job.id, key, 'yes']);
  assert.equal(response.body.rescore.status, 'done');
  assert.equal(response.body.rescore.previous.score, 74);
  assert.equal(response.body.rescore.current.score, response.body.job.score.score);
  assert.equal(response.body.job.evidence.answers[0].key, key);
  assert.equal(response.body.job.evidence.rescorePending, false);
  assert.equal(fake.calls.length, 1);

  const again = await call('POST', '/api/job-hunt/jobs/:id/evidence', { params: { id: f.job.id }, body: { key, answer: 'yes', detail: 'Four years of Go' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.rescore, null, 'an identical answer is not rescored again');
  assert.equal(fake.calls.length, 1);
});

test('POST /evidence keeps the answer when the model is unavailable, and POST /rescore retries', async () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  f.store.close();
  const noModel = routes({ jobLlm: createLlm([]) });
  const saved = await noModel.call('POST', '/api/job-hunt/jobs/:id/evidence', { params: { id: f.job.id }, body: { key, answer: 'partly', detail: '' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rescore.status, 'pending');
  assert.equal(saved.body.job.score.score, 74, 'the score is untouched');
  assert.equal(saved.body.job.evidence.rescorePending, true);
  assert.equal(readEvidence(f.vault, f.job.id).answers[0].answer, 'partly');

  const fake = fakeLlm(modelAnswer({ experience: 20, seniority: 15, technical: 10 }));
  const retry = routes({ jobLlm: llmFor(fake) });
  const done = await retry.call('POST', '/api/job-hunt/jobs/:id/rescore', { params: { id: f.job.id } });
  assert.equal(done.body.rescore.status, 'done');
  assert.match(fake.calls[0].user, /-> PARTLY/);
  assert.equal(done.body.job.evidence.rescorePending, false);
});

test('POST /evidence rejects a client-invented question, a bad id and a bad answer, and writes nothing', async () => {
  const f = fixture();
  f.store.close();
  const { call } = routes({ jobLlm: createLlm([]) });
  const post = (body, id = f.job.id) => call('POST', '/api/job-hunt/jobs/:id/evidence', { params: { id }, body });
  assert.equal((await post({ key: 'dim:interest', answer: 'yes' })).status, 400);
  assert.equal((await post({ key: 'concern:abcabcabcabc', answer: 'yes', label: 'made up' })).status, 400);
  assert.equal((await post({ key: 'dim:technical', answer: 'definitely' })).status, 400);
  assert.equal((await post({ key: 'dim:technical', answer: 'yes', detail: 'x'.repeat(MAX_DETAIL + 1) })).status, 413);
  assert.equal((await post({ key: 'dim:technical', answer: 'yes' }, '../../etc')).status, 400);
  assert.equal((await post({ key: 'dim:technical', answer: 'yes' }, 'job_0000000000000000')).status, 404);
  assert.equal((await call('POST', '/api/job-hunt/jobs/:id/rescore', { params: { id: 'nope' } })).status, 400);
  assert.equal(fs.existsSync(path.join(f.vault, 'job-hunt', 'evidence')), false);
  assert.equal(fs.existsSync(path.join(f.vault, 'job-hunt', 'facts.md')), false);
});

test('a job being worked on elsewhere is not touched (409), and the lock is released afterwards', async () => {
  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  f.store.close();
  const lock = path.join(f.vault, 'job-hunt', 'state', 'locks', `${f.job.id}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  const { call } = routes({ jobLlm: createLlm([]) });
  const blocked = await call('POST', '/api/job-hunt/jobs/:id/evidence', { params: { id: f.job.id }, body: { key, answer: 'yes' } });
  assert.equal(blocked.status, 409);
  fs.rmSync(lock);
  assert.equal((await call('POST', '/api/job-hunt/jobs/:id/evidence', { params: { id: f.job.id }, body: { key, answer: 'yes' } })).status, 200);
  assert.equal(fs.existsSync(lock), false);
});

test('approval and submission are unchanged: evidence adds two routes, changes no application or status, and approve-and-submit still needs confirm and a plan hash', async () => {
  const before = new Router();
  registerJobHuntRoutes(before, { agent: null, toolRegistry: { get: () => null } });
  const signature = (router) => router.routes.map((route) => `${route.method} ${route.path}`).sort();
  const added = signature(before).filter((entry) => /evidence|rescore/.test(entry));
  assert.deepEqual(added, ['POST /api/job-hunt/jobs/:id/evidence', 'POST /api/job-hunt/jobs/:id/rescore'], 'the only new routes');
  assert.equal(signature(before).filter((entry) => /approve-and-submit|\/send$|\/email$/.test(entry)).length, 3, 'the existing submit paths are still the only ones');

  const f = fixture();
  const key = keyFor(questionsOf(f.store, f.job), 'Technical');
  const statusBefore = f.store.getJob(f.job.id).status;
  f.store.close();
  const { call } = routes({ jobLlm: llmFor(fakeLlm(modelAnswer({ experience: 25, seniority: 20, technical: 15, projects: 15, company: 5, interest: 5 }))) });
  const res = await call('POST', '/api/job-hunt/jobs/:id/evidence', { params: { id: f.job.id }, body: { key, answer: 'yes', detail: 'x' } });
  assert.equal(res.body.rescore.status, 'done');
  assert.ok(res.body.rescore.current.score >= 82, 'a high score after rescoring');
  const store = openStore(huntDbPath(f.vault));
  try {
    assert.equal(store.getJob(f.job.id).status, statusBefore, 'a better score moves nothing through the pipeline');
    assert.deepEqual(store.listApplications(f.job.id), []);
    assert.deepEqual(store.listEmails(f.job.id), []);
    assert.deepEqual(store.listReviews(f.job.id), [], 'no review or approval was created');
  } finally { store.close(); }
  assert.equal((await call('POST', '/api/job-hunt/jobs/:id/approve-and-submit', { params: { id: f.job.id }, body: { planHash: 'x' } })).status, 400, 'confirm: true is still required');
  assert.equal((await call('POST', '/api/job-hunt/jobs/:id/approve-and-submit', { params: { id: f.job.id }, body: { confirm: true } })).status, 400, 'and so is the plan hash');
});
