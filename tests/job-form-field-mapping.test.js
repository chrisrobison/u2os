import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplicationPlan } from '../mcp/jobs/hunt/applications/form/plan.js';
import { assembleLetter, letterToText } from '../mcp/jobs/hunt/applications/letters.js';
import { displayCompany } from '../mcp/jobs/hunt/jobs/normalize.js';
import { candidateDigest } from '../mcp/jobs/hunt/candidate/profile.js';
import { RESUME, PREFS } from './fixtures/job-hunt-candidate.js';

// #562: field mapping bugs that made the review agent reject otherwise good form plans.

const NOW = new Date('2026-10-08T12:00:00Z');
const ANSWERS = { work_authorization_us: true, requires_sponsorship: false, custom: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } };
const candidate = { resume: RESUME, preferences: PREFS, answers: ANSWERS, facts: { text: '' }, repos: [], digest: candidateDigest(RESUME, PREFS) };
const job = { id: 'job_1', company: 'X', role: 'Engineer', description: 'x' };
const files = { resume: { path: '/x', sha256: 'a'.repeat(64) } };

async function planFor(fields) {
  const schema = { hasForm: true, blockers: {}, submitLabel: 'Submit', fields: fields.map((field) => ({ type: 'text', required: true, options: [], filled: false, ...field })) };
  const plan = await buildApplicationPlan({ url: 'https://x.test/apply', schema, job, candidate, materials: files, now: NOW });
  return plan;
}
const valueOf = (plan, key) => plan.fields.find((field) => field.key === key)?.value;

test('"Legal First and Last Name" and other whole-name fields get the full name; first and last stay separate', async () => {
  const plan = await planFor([
    { key: 'legal', label: 'Legal First and Last Name' },
    { key: 'both', label: 'First and Last Name' },
    { key: 'full', label: 'Full name' },
    { key: 'legalname', label: 'Legal name' },
    { key: 'first', label: 'First Name' },
    { key: 'last', label: 'Last Name' },
  ]);
  const name = RESUME.basics.name;
  for (const key of ['legal', 'both', 'full', 'legalname']) assert.equal(valueOf(plan, key), name, key);
  assert.equal(valueOf(plan, 'first'), name.split(/\s+/)[0]);
  assert.equal(valueOf(plan, 'last'), name.split(/\s+/).slice(1).join(' '));
});

test('a question that only mentions "employer" is not answered with the current employer', async () => {
  const plan = await planFor([
    { key: 'auth', type: 'combobox', label: 'Are you legally authorized to work in the country where this role is located, for any employer?', options: ['Yes', 'No'] },
    { key: 'worked', type: 'combobox', label: 'Have you previously worked for this employer?', options: ['Yes', 'No'] },
    { key: 'current', label: 'Current employer' },
    { key: 'company', label: 'Company name' },
    { key: 'employer', label: 'Employer' },
  ]);
  assert.equal(valueOf(plan, 'auth'), 'Yes', 'the owner\'s work authorization answer is used');
  assert.equal(plan.fields.find((field) => field.key === 'auth').origin, 'owner-answer');
  const current = RESUME.work?.[0]?.company;
  assert.ok(current, 'the fixture resume has a current employer');
  assert.notEqual(valueOf(plan, 'worked'), current, 'not the current employer');
  assert.ok(plan.unresolved.some((item) => item.key === 'worked'), 'left for the owner rather than guessed');
  for (const key of ['current', 'company', 'employer']) assert.equal(valueOf(plan, key), current, key);
});

test('displayCompany restores the capitalization a posting uses, and falls back to a capital letter', () => {
  const text = 'OpenAI is hiring. At OpenAI we build. Join openai today. OPENAI';
  assert.equal(displayCompany('openai', text), 'OpenAI');
  assert.equal(displayCompany('harvey', 'Harvey builds legal AI. Harvey is growing.'), 'Harvey');
  assert.equal(displayCompany('shieldai', 'nothing relevant here'), 'Shieldai');
  assert.equal(displayCompany('openai', ''), 'Openai');
  assert.equal(displayCompany('Tahoma AI', 'tahoma ai'), 'Tahoma AI', 'a name that already has capitals is left alone');
  assert.equal(displayCompany('exe.dev', 'Try Exe.dev now'), 'Exe.dev');
  assert.equal(displayCompany('', 'x'), '');
  assert.equal(displayCompany('a+b', 'We love A+b.'), 'A+b', 'regex characters in a name are safe');
});

test('the letter greets the company by its proper name', () => {
  const letter = assembleLetter({ paragraphs: ['One.'], resume: RESUME, job: { company: 'openai', description: 'OpenAI builds things. OpenAI is hiring.' }, date: NOW });
  assert.equal(letter.greeting, 'Dear OpenAI team,');
  assert.match(letterToText(letter), /Dear OpenAI team,/);
  const fallback = assembleLetter({ paragraphs: ['One.'], resume: RESUME, job: { company: 'harvey', description: '' }, date: NOW });
  assert.equal(fallback.greeting, 'Dear Harvey team,');
});
