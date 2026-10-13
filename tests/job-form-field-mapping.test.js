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
    { key: 'recent', label: 'Current or Most Recent Employer' },
    { key: 'recentco', label: 'Most recent company' },
    { key: 'currently', label: 'Do you currently work for a competitor of this employer?', type: 'combobox', options: ['Yes', 'No'] },
  ]);
  assert.equal(valueOf(plan, 'auth'), 'Yes', 'the owner\'s work authorization answer is used');
  assert.equal(plan.fields.find((field) => field.key === 'auth').origin, 'owner-answer');
  const current = RESUME.work?.[0]?.company;
  assert.ok(current, 'the fixture resume has a current employer');
  assert.notEqual(valueOf(plan, 'worked'), current, 'not the current employer');
  assert.ok(plan.unresolved.some((item) => item.key === 'worked'), 'left for the owner rather than guessed');
  for (const key of ['current', 'company', 'employer', 'recent', 'recentco']) assert.equal(valueOf(plan, key), current, key);
  assert.notEqual(valueOf(plan, 'currently'), current);
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

test('the owner\'s own answer to the exact question settles a sensitive one; a short fragment never does', async () => {
  const sensitive = [{ key: 'clearance', label: 'Do you have a security clearance?', type: 'combobox', options: ['Yes', 'No'] }, { key: 'sanctions', label: 'What is your citizenship and country of residence?', type: 'combobox', options: ['Yes', 'No'] }];
  const withAnswers = async (custom) => {
    const answered = { ...candidate, answers: { ...ANSWERS, custom } };
    const schema = { hasForm: true, blockers: {}, submitLabel: 'Submit', fields: sensitive.map((field) => ({ required: true, filled: false, ...field })) };
    return buildApplicationPlan({ url: 'https://x.test/apply', schema, job, candidate: answered, materials: files, now: NOW });
  };
  const exact = await withAnswers({ 'do you have a security clearance?': 'No', country: 'Yes' });
  assert.equal(valueOf(exact, 'clearance'), 'No');
  assert.equal(exact.fields.find((field) => field.key === 'clearance').origin, 'owner-answer');
  assert.ok(exact.unresolved.some((item) => item.key === 'sanctions'), 'the short fragment "country" does not answer a sensitive question');
  assert.deepEqual(exact.unresolved.find((item) => item.key === 'sanctions').options, ['Yes', 'No'], 'choices are kept so the app can offer them');
  const none = await withAnswers({});
  assert.equal(none.unresolved.length, 2);
});

// #583: the owner's demographics answers are used when the form offers a matching option, and never invented.
async function eeoPlan(fields, demographics) {
  const schema = { hasForm: true, blockers: {}, submitLabel: 'Submit', fields: fields.map((field) => ({ type: 'select', required: true, filled: false, ...field })) };
  return buildApplicationPlan({ url: 'https://x.test/apply', schema, job, candidate: { ...candidate, answers: { ...ANSWERS, demographics } }, materials: files, now: NOW });
}
const DEMO = { gender: 'Male', race: 'White', pronouns: 'He/him', veteran: false, disability: false, sexual_orientation: 'Straight', hispanic: false };
const DECLINE_OPT = 'I do not wish to answer';

test('demographic questions use the owner\'s answers when an option matches', async () => {
  const plan = await eeoPlan([
    { key: 'g', label: 'Gender', options: ['Male', 'Female', 'Non-binary', DECLINE_OPT] },
    { key: 'r', label: 'Race', options: ['Asian', 'Black or African American', 'White', 'Two or More Races', DECLINE_OPT] },
    { key: 'r2', label: 'Race/Ethnicity', options: ['White (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)', DECLINE_OPT] },
    { key: 'p', label: 'What are your pronouns?', options: ['She/her', 'He/him', 'They/them', DECLINE_OPT] },
    { key: 'v', label: 'Veteran Status', options: ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', DECLINE_OPT] },
    { key: 'd', label: 'Do you have a disability?', options: ['Yes, I have a disability', 'No, I do not have a disability', DECLINE_OPT] },
    { key: 'free', label: 'Gender', type: 'text', options: [] },
    { key: 'o', label: 'Sexual orientation', options: ['Heterosexual', 'Gay', DECLINE_OPT] },
    { key: 'o2', label: 'Sexual Orientation', options: ['Straight', 'Gay or Lesbian', DECLINE_OPT] },
    { key: 'h', label: 'Are you Hispanic or Latino?', options: ['Yes', 'No', DECLINE_OPT] },
  ], DEMO);
  assert.equal(valueOf(plan, 'o'), 'Heterosexual');
  assert.equal(valueOf(plan, 'o2'), 'Straight');
  assert.equal(valueOf(plan, 'h'), 'No');
  assert.equal(valueOf(plan, 'g'), 'Male');
  assert.equal(valueOf(plan, 'r'), 'White');
  assert.equal(valueOf(plan, 'r2'), 'White (Not Hispanic or Latino)');
  assert.equal(valueOf(plan, 'p'), 'He/him');
  assert.equal(valueOf(plan, 'v'), 'I am not a protected veteran');
  assert.equal(valueOf(plan, 'd'), 'No, I do not have a disability');
  assert.equal(valueOf(plan, 'free'), 'Male');
});

test('with no answer, or no matching option, or other EEO questions, the decline option is used as before', async () => {
  const none = await eeoPlan([{ key: 'g', label: 'Gender', options: ['Male', 'Female', DECLINE_OPT] }], {});
  assert.equal(valueOf(none, 'g'), DECLINE_OPT);
  const nomatch = await eeoPlan([{ key: 'r', label: 'Race', options: ['Asian', 'Black', DECLINE_OPT] }], DEMO);
  assert.equal(valueOf(nomatch, 'r'), DECLINE_OPT);
  const other = await eeoPlan([
    { key: 't', label: 'Do you identify as transgender?', options: ['Yes', 'No', DECLINE_OPT] },
  ], DEMO);
  for (const key of ['t']) assert.equal(valueOf(other, key), DECLINE_OPT, key);
});
