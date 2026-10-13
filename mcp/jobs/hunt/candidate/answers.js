import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from '../../profile.js';
import { writeConfigFile } from '../../../../server/vault/config-log.js';

// job-hunt/answers.yaml: the owner's standard answers to common application
// questions. Only what is written here is ever answered for the owner: work
// authorization, visa sponsorship, relocation, salary and similar are facts
// about the owner's life that U2OS cannot infer and must never guess.
//
//   work_authorization_us: true
//   requires_sponsorship: false
//   willing_to_relocate: false
//   open_to_onsite: true            # in-office or hybrid work is acceptable
//   over_18: true
//   salary_expectation: "$200,000 - $240,000"
//   start_date: "Available immediately"
//   demographics:                    # self-identification questions; only what is written here is ever answered
//     gender: Male
//     race: White
//     pronouns: He/him
//     veteran: false
//     disability: false
//     sexual_orientation: Straight
//     hispanic: false                # Hispanic or Latino
//     transgender: false
//   custom:                          # any other question, matched by words in its label
//     "how many years of python": "20+"
//   policy:
//     accept_privacy_notices: true   # ordinary privacy / data-processing consents (default true)
//     accept_truthfulness_attestations: false   # "I certify the above is true" (default false)

export const answersPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'answers.yaml');

const BOOLEANS = ['work_authorization_us', 'requires_sponsorship', 'willing_to_relocate', 'open_to_onsite', 'over_18'];
const TEXTS = ['salary_expectation', 'start_date'];
const DEMOGRAPHIC_TEXTS = ['gender', 'race', 'pronouns', 'sexual_orientation'];
const DEMOGRAPHIC_BOOLEANS = ['veteran', 'disability', 'hispanic', 'transgender'];

export function loadAnswers(vaultDir) {
  let data = {};
  try {
    const stat = fs.lstatSync(answersPath(vaultDir));
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('answers.yaml must be a regular file under 64 KiB');
    data = yaml.load(fs.readFileSync(answersPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('answers.yaml must be a mapping');
  const answers = { custom: {}, demographics: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } };
  for (const key of BOOLEANS) if (data[key] !== undefined) { if (typeof data[key] !== 'boolean') throw new Error(`answers.yaml: ${key} must be true or false`); answers[key] = data[key]; }
  for (const key of TEXTS) if (data[key] !== undefined && data[key] !== null) answers[key] = String(data[key]).slice(0, 300);
  if (data.demographics !== undefined && data.demographics !== null) {
    if (typeof data.demographics !== 'object' || Array.isArray(data.demographics)) throw new Error('answers.yaml: demographics must be a mapping');
    for (const key of Object.keys(data.demographics)) if (![...DEMOGRAPHIC_TEXTS, ...DEMOGRAPHIC_BOOLEANS].includes(key)) throw new Error(`answers.yaml: demographics.${key} is not a known answer`);
    for (const key of DEMOGRAPHIC_TEXTS) if (data.demographics[key] !== undefined) { if (typeof data.demographics[key] !== 'string' || !data.demographics[key].trim()) throw new Error(`answers.yaml: demographics.${key} must be text`); answers.demographics[key] = data.demographics[key].trim().slice(0, 100); }
    for (const key of DEMOGRAPHIC_BOOLEANS) if (data.demographics[key] !== undefined) { if (typeof data.demographics[key] !== 'boolean') throw new Error(`answers.yaml: demographics.${key} must be true or false`); answers.demographics[key] = data.demographics[key]; }
  }
  if (data.custom && typeof data.custom === 'object') for (const [fragment, value] of Object.entries(data.custom)) if (['string', 'number', 'boolean'].includes(typeof value)) answers.custom[fragment.toLowerCase()] = String(value);
  if (data.policy && typeof data.policy === 'object') for (const key of Object.keys(answers.policy)) if (typeof data.policy[key] === 'boolean') answers.policy[key] = data.policy[key];
  return answers;
}

const MAX_FRAGMENT = 200;
const MAX_ANSWER = 2000;
const CUSTOM_HEADER = /^custom:\s*(#.*)?$/;
const CUSTOM_EMPTY = /^custom:\s*\{\s*\}\s*(#.*)?$/;

/** What a question's label is stored as under `custom:`: the plan matches when the label contains it. */
export const customFragment = (label) => String(label ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_FRAGMENT);

/**
 * Adds answers to questions U2OS could not answer, as entries under `custom:`
 * in answers.yaml, from the Job details page. The file is edited as text so
 * the owner's comments and other entries stay exactly as they were; an entry
 * for the same question is replaced. Goes through the config-change log.
 * entries: [{ label, value }]
 */
export function addCustomAnswers(vaultDir, entries, { channel = 'api' } = {}) {
  const wanted = new Map();
  for (const entry of entries) {
    const fragment = customFragment(entry?.label);
    const value = typeof entry?.value === 'string' || typeof entry?.value === 'number' || typeof entry?.value === 'boolean' ? String(entry.value).trim() : '';
    if (!fragment) throw Object.assign(new Error('Every answer needs the question it answers'), { code: 'BAD_INPUT' });
    if (!value) throw Object.assign(new Error(`The answer to "${fragment.slice(0, 60)}" is empty`), { code: 'BAD_INPUT' });
    if (value.length > MAX_ANSWER || /\0/.test(value)) throw Object.assign(new Error(`The answer to "${fragment.slice(0, 60)}" is too long`), { code: 'BAD_INPUT' });
    wanted.set(fragment, value);
  }
  if (!wanted.size) return { saved: 0 };
  loadAnswers(vaultDir); // a damaged file is refused before anything is written
  let text = '';
  try { text = fs.readFileSync(answersPath(vaultDir), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = text.split('\n');
  const header = lines.findIndex((line) => CUSTOM_HEADER.test(line) || CUSTOM_EMPTY.test(line));
  const added = [...wanted].map(([fragment, value]) => `  ${JSON.stringify(fragment)}: ${JSON.stringify(value)}`);
  if (header === -1) {
    const body = text.replace(/\s*$/, '');
    text = `${body}${body ? '\n\n' : ''}custom:\n${added.join('\n')}\n`;
  } else {
    // Drop older entries for the same questions (single-line entries inside the custom block), then add the new ones first.
    let end = header + 1;
    while (end < lines.length && (/^\s/.test(lines[end]) || lines[end].trim() === '')) end += 1;
    const kept = lines.slice(header + 1, end).filter((line) => {
      if (!line.trim() || line.trim().startsWith('#')) return true;
      try { const parsed = yaml.load(line.trim(), { schema: yaml.CORE_SCHEMA }); const key = parsed && typeof parsed === 'object' ? Object.keys(parsed)[0] : null; return !(key && wanted.has(customFragment(key))); } catch { return true; }
    });
    lines.splice(header, end - header, CUSTOM_HEADER.test(lines[header]) ? lines[header] : 'custom:', ...added, ...kept);
    text = lines.join('\n');
  }
  const check = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  for (const [fragment, value] of wanted) if (String(check?.custom?.[Object.keys(check.custom ?? {}).find((key) => customFragment(key) === fragment)] ?? '') !== value) throw new Error('Could not write the answers safely; answers.yaml was not changed');
  writeConfigFile(vaultDir, 'job-hunt/answers.yaml', text, { channel });
  return { saved: wanted.size };
}
