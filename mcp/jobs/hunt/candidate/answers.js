import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from '../../profile.js';

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
//   custom:                          # any other question, matched by words in its label
//     "how many years of python": "20+"
//   policy:
//     accept_privacy_notices: true   # ordinary privacy / data-processing consents (default true)
//     accept_truthfulness_attestations: false   # "I certify the above is true" (default false)

export const answersPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'answers.yaml');

const BOOLEANS = ['work_authorization_us', 'requires_sponsorship', 'willing_to_relocate', 'open_to_onsite', 'over_18'];
const TEXTS = ['salary_expectation', 'start_date'];

export function loadAnswers(vaultDir) {
  let data = {};
  try {
    const stat = fs.lstatSync(answersPath(vaultDir));
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('answers.yaml must be a regular file under 64 KiB');
    data = yaml.load(fs.readFileSync(answersPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('answers.yaml must be a mapping');
  const answers = { custom: {}, policy: { accept_privacy_notices: true, accept_truthfulness_attestations: false } };
  for (const key of BOOLEANS) if (data[key] !== undefined) { if (typeof data[key] !== 'boolean') throw new Error(`answers.yaml: ${key} must be true or false`); answers[key] = data[key]; }
  for (const key of TEXTS) if (data[key] !== undefined && data[key] !== null) answers[key] = String(data[key]).slice(0, 300);
  if (data.custom && typeof data.custom === 'object') for (const [fragment, value] of Object.entries(data.custom)) if (['string', 'number', 'boolean'].includes(typeof value)) answers.custom[fragment.toLowerCase()] = String(value);
  if (data.policy && typeof data.policy === 'object') for (const key of Object.keys(answers.policy)) if (typeof data.policy[key] === 'boolean') answers.policy[key] = data.policy[key];
  return answers;
}
