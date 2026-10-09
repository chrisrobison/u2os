import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../mcp/jobs/hunt/storage/store.js';
import { inspectApplication, executePlan } from '../mcp/jobs/hunt/applications/form/apply.js';
import { chooseApplyUrl, planApplication, recoverInterrupted, submitApplication, STALE_SUBMITTING_MS } from '../mcp/jobs/hunt/applications/form/submit.js';
import { buildApplicationPlan } from '../mcp/jobs/hunt/applications/form/plan.js';
import { schemaHash } from '../mcp/jobs/hunt/applications/form/schema.js';
import { loadAnswers } from '../mcp/jobs/hunt/candidate/answers.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { RESUME, PREFS, fakeLlm } from './fixtures/job-hunt-candidate.js';
import { startApplyForms } from './fixtures/apply-forms.js';

const NOW = new Date('2026-10-08T12:00:00Z');
let forms;
let env;
let browserOk = true;

async function browserEnv() {
  const { chromium } = await import('playwright');
  if (fs.existsSync(chromium.executablePath())) return {};
  for (const dir of fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers').filter((name) => /^chromium-\d+$/.test(name)) : []) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = path.join('/opt/pw-browsers', dir, sub);
      if (fs.existsSync(candidate)) return { JOBS_BROWSER_PATH: candidate };
    }
  }
  throw new Error('no Chromium');
}
before(async () => {
  forms = await startApplyForms();
  try { env = { ...process.env, ...(await browserEnv()), JOBS_SUBMIT_TIMEOUT_MS: '2500' }; Object.assign(process.env, env); } catch { browserOk = false; }
});
after(() => forms.close());

const FACTS = { text: '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles; AI-driven scheduling raised daily revenue by about 30%.\n## Project: U2OS\nPersonal agent platform with deterministic orchestration, MCP, and approval.', projects: ['U2OS'], voice: '' };
const ANSWERS = { work_authorization_us: true, requires_sponsorship: false, custom: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } };
const RESUME_WITH_LINKEDIN = { ...RESUME, basics: { ...RESUME.basics, profiles: [...RESUME.basics.profiles, { network: 'LinkedIn', username: 'pat', url: 'https://www.linkedin.com/in/pat' }] } };
const candidate = (answers = ANSWERS) => ({ resume: RESUME_WITH_LINKEDIN, preferences: PREFS, answers, facts: FACTS, repos: [], digest: candidateDigest(RESUME_WITH_LINKEDIN, PREFS) });

function world(url, { source = 'hackernews', applicationUrls = [url], letter = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-form-'));
  const store = openStore(':memory:');
  const { job } = store.upsertSighting({ source, sourceKey: `${source}:1#0`, company: 'Tahoma AI', role: 'Founding Engineer', locations: ['Remote (US)'], remote: true, technologies: [], description: 'We build deterministic orchestration around LLM agents for operators.', rawText: 'Tahoma AI | Founding Engineer | Remote (US). We build deterministic orchestration around LLM agents for operators.', applicationUrls, contactEmails: [], author: 'founder' });
  const resume = path.join(dir, 'resume.pdf');
  fs.writeFileSync(resume, '%PDF-1.4\nresume body\n%%EOF\n');
  store.addArtifact(job.id, 'resume_pdf', resume);
  const files = { resume: { path: resume } };
  if (letter) {
    const cover = path.join(dir, 'cover.pdf'); fs.writeFileSync(cover, '%PDF-1.4\ncover letter\n%%EOF\n');
    const combined = path.join(dir, 'combined.pdf'); fs.writeFileSync(combined, '%PDF-1.4\ncover letter then resume body\n%%EOF\n');
    store.addArtifact(job.id, 'cover_letter_pdf', cover);
    store.addArtifact(job.id, 'combined_pdf', combined);
    files.cover_letter = { path: cover }; files.resume_with_letter = { path: combined };
  }
  return { dir, store, job: store.getJob(job.id), resume, files };
}
const whyAnswer = 'Tahoma builds deterministic orchestration around LLM agents, which is the problem I work on with U2OS, a personal agent platform with MCP and approval. I also ran engineering as CTO of D. Harris Tours.';
const llmWith = (answers, unanswerable = []) => createLlm([fakeLlm({ answers, unanswerable }).provider]);

test('a form is read and planned: identity, owner answers, decline-to-identify, source and a supported open answer; nothing is guessed', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const w = world(`${forms.base}/ashby/application`);
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({ why: whyAnswer }), now: NOW });
  const { plan } = application;
  assert.equal(application.status, 'planned', JSON.stringify(plan.unresolved));
  assert.equal(plan.ready, true);
  const by = Object.fromEntries(plan.fields.map((field) => [field.key, field]));
  assert.equal(by._systemfield_name.value, 'Pat Example');
  assert.equal(by._systemfield_email.value, 'pat@example.com');
  assert.equal(by.linkedin.value, 'https://www.linkedin.com/in/pat');
  assert.equal(by._systemfield_resume.file, 'resume');
  assert.equal(by.auth.value, 'Yes');
  assert.equal(by.sponsor.value, 'No');
  assert.equal(by.heard.value, 'Hacker News', 'derived from where the job was found');
  assert.deepEqual([by.gender.value, by.gender.origin, by.veteran.value], ['Decline to self-identify', 'decline', 'I prefer not to answer']);
  assert.equal(by.privacy.value, 'yes');
  assert.equal(by.why.origin, 'model');
  assert.equal(plan.files.resume.sha256.length, 64);
  assert.equal(plan.planHash.length, 64);
});

test('without the owner\'s standard answers, authorization and sponsorship stay unresolved and the plan is not submittable', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const w = world(`${forms.base}/ashby/application`);
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate({ custom: {}, policy: ANSWERS.policy }), llm: llmWith({ why: whyAnswer }), now: NOW });
  assert.equal(application.status, 'needs_input');
  assert.deepEqual(application.plan.needs.sort(), ['needs_answer:requires_sponsorship', 'needs_answer:work_authorization_us']);
  assert.equal(application.plan.ready, false);
  await assert.rejects(submitApplication({ store: w.store, job: w.job, files: w.files, execute: async () => { throw new Error('must not run'); } }), /the plan is needs_input/);
});

test('never inferred: salary history and similar stay unresolved; an unsupported open answer stays unresolved; an invented one is rejected', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const url = `${forms.base}/simple/extra`;
  let w = world(url);
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({}, ['scaled']), now: NOW });
  assert.equal(application.status, 'needs_input');
  const reasons = Object.fromEntries(application.plan.unresolved.map((entry) => [entry.key, entry.reason]));
  assert.equal(reasons.salary_now, 'sensitive_never_inferred');
  assert.equal(reasons.scaled, 'not_supported_by_facts');
  w = world(url);
  const invented = llmWith({ scaled: 'I scaled a system to 90 million users at Google.' });
  const again = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: invented, now: NOW });
  assert.equal(again.plan.unresolved.find((entry) => entry.key === 'scaled').reason, 'not_supported_by_facts', 'the claim guard rejected the invented answer');
  assert.ok(!JSON.stringify(again.plan.fields).includes('Google'));
});

test('CAPTCHA and login walls are blockers, never worked around', async (t) => {
  if (!browserOk) return t.skip('no browser');
  for (const [path_, blocker] of [['/captcha/apply', 'captcha'], ['/login/apply', 'login_required'], ['/careers', 'no_form']]) {
    const w = world(`${forms.base}${path_}`);
    const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({}), now: NOW });
    assert.equal(application.status, 'manual_required', path_);
    assert.ok(application.plan.blockers.includes(blocker), `${path_}: ${application.plan.blockers}`);
    const attempt = await executePlan({ plan: { ...application.plan, fields: [], files: {} }, files: {}, submit: true, env });
    assert.equal(attempt.status, 'manual_required');
    assert.equal(forms.submissions.some((entry) => entry.path.includes('submit')), false);
  }
});

test('a dry run fills and verifies; a real run submits exactly what was planned and moves the job to applied', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const w = world(`${forms.base}/ashby/application`);
  await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({ why: whyAnswer }), now: NOW });
  const before = forms.submissions.length;
  const dry = await submitApplication({ store: w.store, job: w.job, files: w.files, submit: false, now: NOW });
  assert.equal(dry.result.status, 'dry_run');
  assert.equal(forms.submissions.length, before, 'a dry run sends nothing');
  assert.equal(w.store.getJob(w.job.id).status, 'discovered');

  const done = await submitApplication({ store: w.store, job: w.store.getJob(w.job.id), files: w.files, screenshotDir: path.join(w.dir, 'shots'), now: NOW });
  assert.equal(done.result.status, 'submitted');
  assert.equal(done.application.status, 'submitted');
  assert.equal(w.store.getJob(w.job.id).status, 'applied');
  const sent = forms.submissions.at(-1).fields;
  assert.equal(sent._systemfield_name, 'Pat Example');
  assert.equal(sent._systemfield_email, 'pat@example.com');
  assert.equal(sent.auth, 'yes');
  assert.equal(sent.sponsor, 'no');
  assert.equal(sent.gender, 'Decline to self-identify');
  assert.equal(sent.privacy, 'on');
  assert.match(sent.why, /deterministic orchestration/);
  assert.match(sent._systemfield_resume, /^file:Pat_Example_Resume\.pdf:\d+$/, 'uploaded under a proper name, not resume.pdf');
  assert.ok(done.result.screenshots.every((file) => fs.existsSync(file)));
  assert.ok(Array.isArray(done.result.evidence), 'the page\'s own network responses are kept as evidence');
  assert.ok(done.result.evidence.some((entry) => /submit/.test(entry.path)), JSON.stringify(done.result.evidence));
  assert.ok(w.store.listEvents(w.job.id).some((event) => event.type === 'application_submitting'));
  // Exactly once.
  await assert.rejects(submitApplication({ store: w.store, job: w.store.getJob(w.job.id), files: w.files, now: NOW }), /already submitted/);
  await assert.rejects(planApplication({ store: w.store, job: w.store.getJob(w.job.id), candidate: candidate(), llm: llmWith({}), now: NOW }), /already submitted/);
});

test('a changed form, changed files or an incomplete fill stops before anything is submitted', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const w = world(`${forms.base}/simple/apply`);
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({}), now: NOW });
  assert.equal(application.status, 'planned');
  const before = forms.submissions.length;
  assert.equal((await executePlan({ plan: { ...application.plan, schemaHash: 'x'.repeat(64) }, files: w.files, env })).status, 'schema_changed');
  fs.writeFileSync(w.resume, 'a different resume');
  assert.equal((await executePlan({ plan: application.plan, files: w.files, env })).status, 'files_changed');
  fs.writeFileSync(w.resume, '%PDF-1.4\nresume body\n%%EOF\n');
  const dropped = { ...application.plan, fields: application.plan.fields.filter((field) => field.key !== 'email') };
  const incomplete = await executePlan({ plan: dropped, files: w.files, env });
  assert.equal(incomplete.status, 'fill_incomplete');
  assert.ok(incomplete.missing.some((label) => /Email/i.test(label)));
  assert.equal(forms.submissions.length, before);
});

test('a submit with no confirmation is unconfirmed and never retried; an interrupted submit becomes uncertain', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const a = world(`${forms.base}/quiet/apply`);
  await planApplication({ store: a.store, job: a.job, candidate: candidate(), llm: llmWith({}), now: NOW });
  const result = await submitApplication({ store: a.store, job: a.job, files: a.files, now: NOW });
  assert.equal(result.result.status, 'unconfirmed');
  assert.equal(a.store.getJob(a.job.id).status, 'uncertain');
  await assert.rejects(submitApplication({ store: a.store, job: a.store.getJob(a.job.id), files: a.files, now: NOW }), /already unconfirmed/);

  const b = world(`${forms.base}/simple/apply`);
  await planApplication({ store: b.store, job: b.job, candidate: candidate(), llm: llmWith({}), now: NOW });
  const crashed = submitApplication({ store: b.store, job: b.job, files: b.files, now: NOW, execute: async ({ beforeSubmit }) => { await beforeSubmit(); throw new Error('Chrome crashed after the click'); } });
  await assert.rejects(crashed, /crashed/);
  assert.equal(b.store.listApplications(b.job.id)[0].status, 'submitting');
  await assert.rejects(submitApplication({ store: b.store, job: b.job, files: b.files, now: NOW }), /already submitting/);
  const recovered = recoverInterrupted({ store: b.store, now: new Date(Date.now() + STALE_SUBMITTING_MS + 1000) });
  assert.equal(recovered.length, 1);
  assert.equal(b.store.listApplications(b.job.id)[0].status, 'uncertain');
  assert.equal(b.store.getJob(b.job.id).status, 'uncertain');
  await assert.rejects(submitApplication({ store: b.store, job: b.store.getJob(b.job.id), files: b.files, now: NOW }), /already uncertain/);
});

test('the apply link chosen is the form, and answers.yaml loads strictly', () => {
  assert.equal(chooseApplyUrl({ applicationUrls: ['https://www.tahoma.io/careers', 'https://jobs.ashbyhq.com/tahoma/abc/application'] }), 'https://jobs.ashbyhq.com/tahoma/abc/application');
  assert.equal(chooseApplyUrl({ applicationUrls: ['https://example.com/'] }), 'https://example.com/');
  assert.equal(chooseApplyUrl({ applicationUrls: [] }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-answers-'));
  assert.deepEqual(loadAnswers(dir).policy, { accept_privacy_notices: true, accept_truthfulness_attestations: false });
  fs.mkdirSync(path.join(dir, 'job-hunt'));
  fs.writeFileSync(path.join(dir, 'job-hunt', 'answers.yaml'), 'work_authorization_us: true\nsalary_expectation: "$200k"\ncustom:\n  "years of python": "20+"\npolicy:\n  accept_truthfulness_attestations: true\n');
  const answers = loadAnswers(dir);
  assert.equal(answers.work_authorization_us, true);
  assert.equal(answers.custom['years of python'], '20+');
  assert.equal(answers.policy.accept_truthfulness_attestations, true);
  fs.writeFileSync(path.join(dir, 'job-hunt', 'answers.yaml'), 'work_authorization_us: "maybe"\n');
  assert.throws(() => loadAnswers(dir), /must be true or false/);
});

test('plan hashes follow the schema and values, and legal attestations are refused unless the owner allows them', async () => {
  const schema = { hasForm: true, blockers: {}, submitLabel: 'Submit', fields: [
    { key: 'certify', type: 'checkbox', label: 'I certify that the information above is true and complete', required: true, options: ['I certify that the information above is true and complete'], filled: false },
    { key: 'email', type: 'email', label: 'Email', required: true, options: [], filled: false },
  ] };
  const job = { id: 'job_1', company: 'X', role: 'Engineer', description: 'x' };
  const files = { resume: { path: '/x', sha256: 'a'.repeat(64) } };
  const strict = await buildApplicationPlan({ url: 'https://x.test/apply', schema, job, candidate: candidate(), materials: files, now: NOW });
  assert.equal(strict.unresolved[0].reason, 'legal_attestation');
  assert.equal(strict.ready, false);
  const allowed = await buildApplicationPlan({ url: 'https://x.test/apply', schema, job, candidate: candidate({ ...ANSWERS, policy: { ...ANSWERS.policy, accept_truthfulness_attestations: true } }), materials: files, now: NOW });
  assert.equal(allowed.fields.find((field) => field.key === 'certify').origin, 'attestation');
  assert.equal(allowed.ready, true);
  assert.notEqual(strict.planHash, allowed.planHash);
  assert.equal(schemaHash(schema.fields), schemaHash([...schema.fields].reverse()), 'field order does not matter');
});

test('real-world shapes: desired location, unflagged standard questions still block, and the autofill upload is left alone', async () => {
  const schema = { hasForm: true, blockers: {}, submitLabel: 'Submit Application', fields: [
    { key: 'field_0', type: 'file', label: '', required: false, options: [], filled: false, accept: '.pdf' },
    { key: '_systemfield_resume', type: 'file', label: 'Resume', required: true, options: [], filled: false, accept: '.pdf' },
    { key: 'loc', type: 'text', label: 'Desired work location', required: true, options: [], filled: false },
    { key: 'auth', type: 'buttons', label: 'Are you currently eligible to work in the United States of America?', required: false, options: ['Yes', 'No'], filled: false },
  ] };
  const job = { id: 'job_1', company: 'X', role: 'Engineer', description: 'x' };
  const files = { resume: { path: '/x', sha256: 'a'.repeat(64) } };
  const unanswered = await buildApplicationPlan({ url: 'https://x.test/application', schema, job, candidate: candidate({ custom: {}, policy: ANSWERS.policy }), materials: files, now: NOW });
  assert.equal(unanswered.fields.find((field) => field.key === 'loc').value, 'San Francisco, CA');
  assert.deepEqual(unanswered.fields.filter((field) => field.file).map((field) => field.key), ['_systemfield_resume'], 'only the real resume field is uploaded to');
  assert.equal(unanswered.ready, false, 'an unanswered work-authorization question blocks even though the board did not mark it required');
  assert.deepEqual(unanswered.needs, ['needs_answer:work_authorization_us']);
  const answered = await buildApplicationPlan({ url: 'https://x.test/application', schema, job, candidate: candidate(), materials: files, now: NOW });
  assert.equal(answered.fields.find((field) => field.key === 'auth').value, 'Yes');
  assert.equal(answered.ready, true);
});

test('no cover-letter upload on the form: one PDF, cover letter then resume, goes in the resume slot under a proper name', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const w = world(`${forms.base}/simple/apply`, { letter: true });
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({}), now: NOW });
  assert.equal(application.status, 'planned');
  const resumeField = application.plan.fields.find((field) => field.key === 'resume');
  assert.deepEqual([resumeField.file, resumeField.fileName], ['resume_with_letter', 'Pat_Example_Resume_and_Cover_Letter.pdf']);
  assert.deepEqual(Object.keys(application.plan.files), ['resume_with_letter'], 'only the file that is uploaded is pinned');
  const done = await submitApplication({ store: w.store, job: w.job, files: w.files, now: NOW });
  assert.equal(done.result.status, 'submitted');
  const sent = forms.submissions.at(-1).fields.resume;
  const combinedSize = fs.readFileSync(w.files.resume_with_letter.path).length;
  assert.equal(sent, `file:Pat_Example_Resume_and_Cover_Letter.pdf:${combinedSize}`, 'the combined file, under its proper name');
});

test('a form with a cover-letter upload keeps two separate files, each properly named', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const w = world(`${forms.base}/cover/apply`, { letter: true });
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({}), now: NOW });
  const by = Object.fromEntries(application.plan.fields.filter((field) => field.file).map((field) => [field.key, field]));
  assert.deepEqual([by.resume.file, by.resume.fileName, by.cover_letter.file, by.cover_letter.fileName], ['resume', 'Pat_Example_Resume.pdf', 'cover_letter', 'Pat_Example_Cover_Letter.pdf']);
  assert.deepEqual(Object.keys(application.plan.files).sort(), ['cover_letter', 'resume']);
  await submitApplication({ store: w.store, job: w.job, files: w.files, now: NOW });
  const fields = forms.submissions.at(-1).fields;
  assert.match(fields.resume, /^file:Pat_Example_Resume\.pdf:/);
  assert.match(fields.cover_letter, /^file:Pat_Example_Cover_Letter\.pdf:/);
});

test('no letter and no cover-letter upload: the plan says it wants a letter; with no combined file it uploads the plain resume', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const w = world(`${forms.base}/simple/apply`);
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({}), now: NOW });
  assert.deepEqual(application.plan.wants, ['cover_letter']);
  assert.equal(application.plan.fields.find((field) => field.key === 'resume').file, 'resume');
  const withUpload = world(`${forms.base}/cover/apply`);
  const second = await planApplication({ store: withUpload.store, job: withUpload.job, candidate: candidate(), llm: llmWith({}), now: NOW });
  assert.deepEqual(second.plan.wants, [], 'a form with its own cover-letter field does not "want" one from us');
});

test('the combined PDF is built for older materials from the stored resume and letter, only when needed, and only once', async (t) => {
  if (!browserOk) return t.skip('no browser');
  const { ensureCombinedPdf } = await import('../mcp/jobs/hunt/applications/materials.js');
  const { letterToText, assembleLetter } = await import('../mcp/jobs/hunt/applications/letters.js');
  const w = world(`${forms.base}/simple/apply`);
  const dir = path.join(w.dir, 'materials'); fs.mkdirSync(dir);
  const doc = { basics: { name: 'Pat Example', headline: 'CTO', summary: 'Hands-on engineering leader with deep experience.', location: 'SF', email: 'pat@example.com', phone: '1' }, highlights: [], expertise: [], experience: [{ position: 'CTO', company: 'D. Harris Tours, Inc.', period: '2020 - Present', bullets: ['Grew the fleet.'] }], projects: [], earlier: [], education: [] };
  fs.writeFileSync(path.join(dir, 'resume.json'), JSON.stringify(doc));
  const letter = assembleLetter({ paragraphs: ['First paragraph about the company.', 'Second paragraph about the work.', 'Third paragraph.'], resume: RESUME, job: { company: 'Tahoma AI' }, date: NOW });
  fs.writeFileSync(path.join(dir, 'cover-letter.txt'), letterToText(letter));
  w.store.addArtifact(w.job.id, 'resume_json', path.join(dir, 'resume.json'));
  assert.equal(await ensureCombinedPdf({ store: w.store, job: w.job, now: NOW }), null, 'no letter, nothing to combine');
  w.store.addArtifact(w.job.id, 'cover_letter_txt', path.join(dir, 'cover-letter.txt'));
  const built = await ensureCombinedPdf({ store: w.store, job: w.job, now: NOW });
  assert.ok(built && fs.existsSync(built.path));
  const pdf = fs.readFileSync(built.path);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length >= 2, 'the letter page and the resume page');
  const again = await ensureCombinedPdf({ store: w.store, job: w.job, now: NOW });
  assert.equal(again.sha256, built.sha256, 'not rebuilt while it is current');
  const application = await planApplication({ store: w.store, job: w.job, candidate: candidate(), llm: llmWith({}), ensureCombined: ensureCombinedPdf, now: NOW });
  assert.equal(application.plan.fields.find((field) => field.key === 'resume').file, 'resume_with_letter', 'planning picked the combined file up');
});

test('letters round-trip through their text form, and the combined document puts the letter before the resume', async () => {
  const { assembleLetter, letterToText, parseLetterText } = await import('../mcp/jobs/hunt/applications/letters.js');
  const { combinedHtml } = await import('../mcp/jobs/hunt/applications/render.js');
  const letter = assembleLetter({ paragraphs: ['Alpha.', 'Beta.', 'Gamma.'], resume: RESUME, job: { company: 'Tahoma AI' }, date: NOW });
  assert.deepEqual(parseLetterText(letterToText(letter)), letter);
  assert.equal(parseLetterText('too short'), null);
  const doc = { basics: { name: 'Pat Example', headline: 'CTO', summary: 'SUMMARY-TEXT', location: '', email: '', phone: '' }, highlights: [], expertise: [], experience: [], projects: [], earlier: [], education: [] };
  const html = combinedHtml(letter, doc);
  assert.ok(html.indexOf('Alpha.') < html.indexOf('SUMMARY-TEXT'), 'the cover letter comes first');
  assert.match(html, /part-resume/);
  assert.doesNotMatch(html, /<script/i);
});

test('the owner\'s file-name style reaches the planned uploads: playful by their choice, plain otherwise', async () => {
  const { attachmentName } = await import('../mcp/jobs/hunt/applications/names.js');
  const schema = { hasForm: true, blockers: {}, submitLabel: 'Submit', fields: [{ key: 'resume', type: 'file', label: 'Resume', required: true, options: [], filled: false, accept: '.pdf' }] };
  const job = { id: 'job_77', company: 'Tahoma AI', role: 'Engineer', description: 'x' };
  const materials = { resume: { path: '/x', sha256: 'a'.repeat(64) }, combined: { path: '/y', sha256: 'b'.repeat(64) } };
  const playful = await buildApplicationPlan({ url: 'https://x.test/apply', schema, job, candidate: candidate(), materials, nameStyle: 'playful', now: NOW });
  const field = playful.fields[0];
  assert.equal(field.fileName, attachmentName({ kind: 'resume_with_letter', person: 'Pat Example', company: 'Tahoma AI', seed: 'job_77', style: 'playful' }));
  assert.notEqual(field.fileName, 'Pat_Example_Resume_and_Cover_Letter.pdf');
  const plain = await buildApplicationPlan({ url: 'https://x.test/apply', schema, job, candidate: candidate(), materials, nameStyle: 'plain', now: NOW });
  assert.equal(plain.fields[0].fileName, 'Pat_Example_Resume_and_Cover_Letter.pdf');
  assert.notEqual(playful.planHash, plain.planHash, 'the name is part of what was reviewed');
});
