import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSupported, buildCorpus, unsupportedClaims } from '../mcp/jobs/hunt/applications/guard.js';
import { chooseStrategy, needsCoverLetter } from '../mcp/jobs/hunt/applications/strategy.js';
import { assembleEmail, generateCoverLetter, generateOutreachEmail, stripFraming } from '../mcp/jobs/hunt/applications/letters.js';
import { generateResume, resumeToText } from '../mcp/jobs/hunt/applications/resume-generator.js';
import { generateMaterials } from '../mcp/jobs/hunt/applications/materials.js';
import { resumeHtml, renderPdfs } from '../mcp/jobs/hunt/applications/render.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';
import { openStore } from '../mcp/jobs/hunt/storage/store.js';
import { scoreLabel } from '../mcp/jobs/hunt/jobs/scorer.js';
import { RESUME, REPOS, PREFS, fakeLlm } from './fixtures/job-hunt-candidate.js';

const FACTS = { text: '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles; daily revenue up approximately 30%.\n## Conversant\n- Owned the iOS and Android MRAID SDK.\n## Project: U2OS\nPersonal agent platform with deterministic orchestration, MCP, and approval.', projects: ['U2OS'], voice: 'Plain and direct.' };
const candidate = () => ({ resume: RESUME, preferences: PREFS, repos: REPOS, facts: FACTS, digest: candidateDigest(RESUME, PREFS) });
const JOB = { id: 'job_abcdef123456', company: 'Tahoma AI', role: 'Founding Engineer', locations: ['Remote (US)'], remote: true, salary: null, technologies: ['TypeScript'], description: 'We build deterministic orchestration around LLM agents for operators.', contactEmails: ['careers@tahoma.io'], applicationUrls: [], companyUrl: 'https://tahoma.ai', status: 'scored' };
const SOURCE = { author: 'founder1', rawText: 'Tahoma AI | Founding Engineer | Remote (US)\nWe build deterministic orchestration around LLM agents for operators. Email careers@tahoma.io' };
const SCORE = { score: 90, label: 'exceptional', degraded: false, recommendedNarrative: 'ai-agent-systems', reasons: ['Direct overlap with U2OS'], projects: [{ name: 'u2os', why: 'same architecture' }], concerns: [], flags: [] };

const goodResume = (over = {}) => ({
  headline: 'Founding Engineer | Agent Systems and Operations Software',
  summary: 'Hands-on engineering leader and architect who has run engineering as CTO and built U2OS, a personal agent platform with deterministic orchestration and approval steps. At D. Harris Tours the fleet grew from 2 to 14 vehicles on the platform I built.',
  highlights: [{ label: 'Agents', text: 'Built U2OS with deterministic orchestration and MCP tool use.' }],
  expertise: [{ label: 'Languages', items: 'Python, JavaScript, Go, Rust, Swift' }],
  experience: [{ index: 1, bullets: ['Owned the iOS and Android MRAID SDK.'] }, { index: 0, bullets: ['Grew the fleet from 2 to 14 vehicles.', 'Daily revenue up approximately 30%.'] }],
  projects: [{ name: 'u2os', bullets: ['Personal agent platform with deterministic orchestration, MCP, and approval.'] }, { name: 'Imaginary', bullets: ['Made up.'] }],
  ...over,
});
const llmFor = (...replies) => { let i = 0; const f = fakeLlm(() => replies[Math.min(i++, replies.length - 1)]); f.llm = createLlm([f.provider]); return f; };

const words = (n) => Array.from({ length: n }, (_, i) => (i % 9 === 8 ? 'fleet.' : 'platform')).join(' ');
const paragraphs = (total = 300) => [words(total / 3), words(total / 3), words(total / 3)].map((p) => `Tahoma ${p}`);

test('guard accepts supported text and rejects invented numbers, technologies, employers, links and addresses', () => {
  const corpus = buildCorpus('Grew the fleet from 2 to 14 vehicles at D. Harris Tours. Python and Rust. github.com/patexample https://github.com/patexample');
  assert.deepEqual(unsupportedClaims('Grew the fleet from 2 to 14 vehicles at D. Harris Tours using Python.', corpus), []);
  assert.deepEqual(unsupportedClaims('Grew the fleet to 40 vehicles.', corpus), ['40']);
  assert.ok(unsupportedClaims('Built it with Kubernetes and Kafka.', corpus).includes('Kubernetes'));
  assert.ok(unsupportedClaims('Previously at Google, I led the team.', corpus).includes('Google'));
  assert.ok(unsupportedClaims('See https://evil.example/x or mail bob@evil.example', corpus).length >= 2);
  assert.deepEqual(unsupportedClaims('See https://github.com/patexample', corpus), []);
  assert.throws(() => assertSupported('summary', 'Increased revenue by 300%.', corpus), (e) => e.code === 'INVALID_OUTPUT');
});

test('resume: identity, titles, companies and dates come from the canonical resume, not the model', async () => {
  const f = llmFor(goodResume({ headline: 'Founding Engineer', experience: [{ index: 0, bullets: ['Grew the fleet from 2 to 14 vehicles.'] }] }));
  const { document } = await generateResume({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: f.llm });
  assert.equal(document.basics.name, 'Pat Example');
  assert.equal(document.basics.email, 'pat@example.com');
  assert.equal(document.experience[0].position, 'CTO');
  assert.equal(document.experience[0].company, 'D. Harris Tours, Inc.');
  assert.equal(document.experience[0].period, 'March, 2020 - Present');
  assert.deepEqual(document.earlier.map((job) => job.company), ['Conversant, Inc.'], 'omitted positions are abbreviated, not dropped');
  assert.match(f.calls[0].user, /<<<LISTING/);
});

test('resume: positions are chronological, unknown projects are dropped, known ones keep their names', async () => {
  const { document } = await generateResume({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: llmFor(goodResume()).llm });
  assert.deepEqual(document.experience.map((entry) => entry.company), ['D. Harris Tours, Inc.', 'Conversant, Inc.']);
  assert.deepEqual(document.projects.map((project) => project.name), ['U2OS']);
  assert.ok(!JSON.stringify(document).includes('Imaginary'));
});

test('resume: an invented metric is rejected and the model is asked again', async () => {
  const f = llmFor(goodResume({ summary: `${goodResume().summary} I increased revenue by 400% and led 60 engineers.` }), goodResume());
  const { document } = await generateResume({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: f.llm });
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].user, /previous reply was rejected.*400%/);
  assert.doesNotMatch(document.basics.summary, /400%/);
});

test('resume: bad position indexes and duplicates are rejected', async () => {
  for (const experience of [[{ index: 9, bullets: ['x'] }], [{ index: 0, bullets: ['a'] }, { index: 0, bullets: ['b'] }], []]) {
    const f = llmFor(goodResume({ experience }));
    await assert.rejects(generateResume({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: f.llm }), /No model produced a valid answer/);
  }
});

test('resume text renders without HTML and the page is escaped', async () => {
  const { document } = await generateResume({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: llmFor(goodResume()).llm });
  assert.match(resumeToText(document), /^Pat Example\n/);
  document.basics.summary = '<script>alert(1)</script>';
  assert.doesNotMatch(resumeHtml(document), /<script>alert/);
});

test('cover letter: length, stock phrases, company mention and unsupported claims are enforced', async () => {
  const ok = llmFor({ paragraphs: paragraphs(300) });
  const result = await generateCoverLetter({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: ok.llm });
  assert.equal(result.paragraphs.length, 3);
  for (const [bad, pattern] of [
    [{ paragraphs: paragraphs(120) }, /must have 250 to 450/],
    [{ paragraphs: [`Tahoma I am excited to apply. ${words(100)}`, words(100), words(100)] }, /stock phrase/],
    [{ paragraphs: paragraphs(300).map((p) => p.replace('Tahoma', 'Acme')) }, /never mentions Tahoma AI/],
    [{ paragraphs: [`Tahoma ${words(100)} and I cut costs 77%.`, words(100), words(100)] }, /77%/],
  ]) {
    const f = llmFor(bad);
    await assert.rejects(generateCoverLetter({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: f.llm }), pattern.constructor === RegExp ? /No model produced a valid answer/ : pattern);
    assert.match(f.calls[0].system, /UNTRUSTED|untrusted/i);
  }
});

test('outreach email: short, framing stripped, greeting only with a name the listing contains', async () => {
  const body = 'I saw your post for the Founding Engineer role at Tahoma AI. Building deterministic orchestration around LLM agents is the problem I work on with U2OS, a personal agent platform with MCP, approval and audit trails, and I ran engineering as CTO of D. Harris Tours.\n\nMy tailored resume is attached.';
  const f = llmFor({ subject: 'Founding Engineer: agent orchestration', greetingName: 'Mallory', body: `Hi Mallory,\n\n${body}\n\nBest,\nPat` });
  const draft = await generateOutreachEmail({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: f.llm, recipient: 'careers@tahoma.io' });
  assert.equal(draft.greetingName, '', 'Mallory is not in the listing, so no name is used');
  const email = assembleEmail({ draft, resume: RESUME });
  assert.match(email.text, /^Hi,\n\nI saw your post/);
  assert.equal((email.text.match(/Best,/g) ?? []).length, 1);
  assert.equal(stripFraming('Hello Sam,\n\nText.\n\nThanks,\nPat'), 'Text.');
  const long = llmFor({ subject: 's', greetingName: '', body: words(300) });
  await assert.rejects(generateOutreachEmail({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: long.llm, recipient: 'x@y.example' }), /No model produced/);
});

test('strategy follows the listing: email, form, both, neither, below threshold', () => {
  const base = { contactEmails: [], applicationUrls: [] };
  assert.equal(chooseStrategy({ ...base, contactEmails: ['a@b.example'] }).strategy, 'DIRECT_EMAIL');
  assert.equal(chooseStrategy({ ...base, applicationUrls: ['https://jobs.lever.co/x/1'] }).strategy, 'FORM_APPLICATION');
  assert.equal(chooseStrategy({ contactEmails: ['a@b.example'], applicationUrls: ['https://x.example/apply'] }).strategy, 'FORM_AND_EMAIL');
  assert.equal(chooseStrategy(base).strategy, 'MANUAL_REQUIRED');
  assert.equal(chooseStrategy({ ...base, contactEmails: ['noreply@b.example'] }).strategy, 'MANUAL_REQUIRED');
  assert.equal(chooseStrategy({ contactEmails: ['a@b.example'] }, { score: { score: 78 }, minimumScore: 82 }).strategy, 'SKIP');
  assert.equal(needsCoverLetter({ strategy: 'DIRECT_EMAIL', score: { score: 70 } }), true);
  assert.equal(needsCoverLetter({ strategy: 'FORM_APPLICATION', score: { score: 70 } }), false);
  assert.equal(needsCoverLetter({ strategy: 'FORM_APPLICATION', score: { score: 85 } }), true);
  assert.equal(scoreLabel(85), 'strong');
});

function seededStore() {
  const store = openStore(':memory:');
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:1#0', company: JOB.company, role: JOB.role, locations: JOB.locations, remote: true, technologies: ['TypeScript'], description: JOB.description, rawText: SOURCE.rawText, applicationUrls: [], contactEmails: JOB.contactEmails, author: 'founder1', companyUrl: JOB.companyUrl });
  store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: ['Direct overlap with U2OS'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [{ name: 'u2os', url: 'x', why: 'same architecture' }], flags: [], degraded: false, model: 'm' });
  return { store, job: store.getJob(job.id) };
}

test('materials: written, recorded with hashes, status advanced, reused unless forced', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-mat-'));
  const { store, job } = seededStore();
  const email = { subject: 'Founding Engineer: agent orchestration', greetingName: '', body: 'I saw your post for the Founding Engineer role at Tahoma AI. Deterministic orchestration around LLM agents is what I build with U2OS, a personal agent platform with MCP, approval and audit trails, and I ran engineering as CTO of D. Harris Tours, growing the fleet from 2 to 14 vehicles.\n\nMy tailored resume is attached.' };
  const f = llmFor(goodResume(), { paragraphs: paragraphs(300) }, email);
  const result = await generateMaterials({ store, vaultDir: vault, job, candidate: candidate(), llm: f.llm, pdf: false });
  assert.equal(result.reused, false);
  assert.equal(result.strategy.strategy, 'DIRECT_EMAIL');
  assert.ok(['resume_json', 'resume_txt', 'cover_letter_txt', 'email_json'].every((kind) => result.artifacts[kind]?.sha256?.length === 64));
  assert.equal(store.getJob(job.id).status, 'materials_generated');
  const sent = JSON.parse(fs.readFileSync(result.artifacts.email_json.path, 'utf8'));
  assert.equal(sent.to, 'careers@tahoma.io');
  assert.match(fs.readFileSync(result.artifacts.resume_txt.path, 'utf8'), /D\. Harris Tours, Inc\./);
  const calls = f.calls.length;
  const again = await generateMaterials({ store, vaultDir: vault, job: store.getJob(job.id), candidate: candidate(), llm: f.llm, pdf: false });
  assert.equal(again.reused, true);
  assert.equal(f.calls.length, calls, 'no model call on reuse');
});

test('materials: refuses unscored jobs, degraded scores and a missing model', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-mat-'));
  const store = openStore(':memory:');
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:2#0', company: 'Z', role: 'Engineer', rawText: 'x', applicationUrls: [], contactEmails: [] });
  const llm = createLlm([fakeLlm(goodResume()).provider]);
  await assert.rejects(generateMaterials({ store, vaultDir: vault, job, candidate: candidate(), llm, pdf: false }), /has not been scored/);
  store.saveScore(job.id, { score: 70, confidence: 0.3, label: 'plausible', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'staff-principal', projects: [], flags: [], degraded: true });
  await assert.rejects(generateMaterials({ store, vaultDir: vault, job, candidate: candidate(), llm, pdf: false }), /degraded/);
  store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'staff-principal', projects: [], flags: [], degraded: false });
  await assert.rejects(generateMaterials({ store, vaultDir: vault, job, candidate: candidate(), llm: createLlm([]), pdf: false }), /model is required/);
});

test('PDF rendering produces a one-to-two page resume (skipped when Chromium is unavailable)', async (t) => {
  const { document } = await generateResume({ job: JOB, source: SOURCE, score: SCORE, candidate: candidate(), llm: llmFor(goodResume()).llm });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-pdf-')), 'resume.pdf');
  let results;
  try { results = await renderPdfs([{ file, html: (size) => resumeHtml(document, { fontSize: size }), sizes: [9.4], maxPages: 2 }]); } catch (error) { t.skip(`no browser: ${error.message.slice(0, 80)}`); return; }
  assert.ok(results[0].pages >= 1 && results[0].pages <= 2);
  assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), '%PDF');
});

const OPAXA_SOURCE = { author: 'colton', rawText: 'Opaxa | Founding Engineer | SF\nTo apply, email colton@opaxa.com with the subject "Forward Deployed: your name, your city" and include: a link to something real people use; a time a user\'s feedback changed what you shipped.' };
const EMAIL_BODY = 'I saw your post for the Founding Engineer role. Deterministic orchestration around agents is what I build with U2OS, a personal agent platform with MCP, approval and audit trails, and I ran engineering as CTO of D. Harris Tours, growing the fleet from 2 to 14 vehicles.\n\nMy tailored resume is attached.';

test('outreach email: a subject the listing prescribes is filled by code; asks the facts cannot meet are flagged, not invented', async () => {
  const f = llmFor({ subject: 'Hello', requiredSubject: 'Forward Deployed: {name}, {city}', greetingName: '', body: EMAIL_BODY, requirements: [{ ask: 'resume', met: true, note: 'attached' }, { ask: 'a time a user feedback changed what you shipped', met: false, note: 'no such story in the facts' }] });
  const draft = await generateOutreachEmail({ job: { ...JOB, company: 'Opaxa' }, source: OPAXA_SOURCE, score: SCORE, candidate: candidate(), llm: f.llm, recipient: 'colton@opaxa.com' });
  const email = assembleEmail({ draft, resume: RESUME });
  assert.equal(email.subject, 'Forward Deployed: Pat Example, San Francisco');
  assert.deepEqual(email.needsInput, ['a time a user feedback changed what you shipped']);
  assert.match(f.calls[0].system, /do NOT invent/);
});

test('outreach email: a made-up required subject and unverifiable career claims are rejected', async () => {
  const bad = (over) => llmFor({ subject: 's', requiredSubject: '', greetingName: '', body: EMAIL_BODY, requirements: [], ...over });
  await assert.rejects(generateOutreachEmail({ job: JOB, source: OPAXA_SOURCE, score: SCORE, candidate: candidate(), llm: bad({ requiredSubject: 'URGENT: hire {name}' }).llm, recipient: 'x@y.example' }), /No model produced/);
  const f = bad({ body: `${EMAIL_BODY} I started my career building platforms.` });
  await assert.rejects(generateOutreachEmail({ job: JOB, source: OPAXA_SOURCE, score: SCORE, candidate: candidate(), llm: f.llm, recipient: 'x@y.example' }), /No model produced/);
  assert.match(f.calls[1].user, /career order or superlatives/);
});

test('materials: unmet application asks move the job to needs_input and are remembered on reuse', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-mat-'));
  const { store, job } = seededStore();
  const email = { subject: 's', requiredSubject: '', greetingName: '', body: EMAIL_BODY, requirements: [{ ask: 'a link to something real people use', met: false, note: '' }] };
  const f = llmFor(goodResume(), { paragraphs: paragraphs(300) }, email);
  const result = await generateMaterials({ store, vaultDir: vault, job, candidate: candidate(), llm: f.llm, pdf: false });
  assert.deepEqual(result.needsInput, ['a link to something real people use']);
  assert.equal(store.getJob(job.id).status, 'needs_input');
  assert.deepEqual((await generateMaterials({ store, vaultDir: vault, job: store.getJob(job.id), candidate: candidate(), llm: f.llm, pdf: false })).needsInput, ['a link to something real people use']);
});
