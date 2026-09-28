import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// job-hunt/profile.md in the owner's vault: the details the owner agrees to
// send to employers they apply to. The model never supplies these; the
// server reads them here and fills them into forms itself.
//
//   ---
//   first_name: Sam
//   last_name: Rivera
//   email: sam@example.com
//   phone: "+1 503 555 0100"
//   location: Portland, OR
//   linkedin: https://www.linkedin.com/in/example
//   resume: resume.pdf              # relative to job-hunt/
//   boards: [greenhouse:acme, lever:globex]
//   submit: false                   # true to actually submit applications
//   max_applications_per_day: 5
//   answers:                        # standard answers, matched by question label
//     authorized to work: "Yes"
//   ---

export const JOB_HUNT_DIR = 'job-hunt';
const BOARD = /^(greenhouse|lever):[A-Za-z0-9_.-]{1,80}$/;
const MAX_BYTES = 64 * 1024;

export function loadProfile(vaultDir) {
  const dir = path.join(vaultDir, JOB_HUNT_DIR);
  const file = path.join(dir, 'profile.md');
  const stat = lstat(file);
  if (!stat) throw new Error(`No applicant profile: create ${JOB_HUNT_DIR}/profile.md in your vault`);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`${JOB_HUNT_DIR}/profile.md must be a regular file under 64 KiB`);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const data = (match ? yaml.load(match[1], { schema: yaml.CORE_SCHEMA }) : {}) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('profile.md frontmatter must be a mapping');

  const text_ = (key) => (typeof data[key] === 'string' || typeof data[key] === 'number') && String(data[key]).trim() ? String(data[key]).trim() : null;
  let [first, last] = [text_('first_name'), text_('last_name')];
  if ((!first || !last) && text_('name')) {
    const parts = text_('name').split(/\s+/);
    first ||= parts[0];
    last ||= parts.slice(1).join(' ') || null;
  }
  const boards = Array.isArray(data.boards) ? data.boards.map(String) : [];
  const badBoard = boards.find((board) => !BOARD.test(board));
  if (badBoard) throw new Error(`boards: "${badBoard}" must look like greenhouse:<board> or lever:<company>`);
  if (data.submit !== undefined && typeof data.submit !== 'boolean') throw new Error('submit must be true or false');
  const maxPerDay = data.max_applications_per_day ?? 5;
  if (!Number.isInteger(maxPerDay) || maxPerDay < 0 || maxPerDay > 50) throw new Error('max_applications_per_day must be a whole number from 0 to 50');
  const answers = data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)
    ? Object.fromEntries(Object.entries(data.answers).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key.toLowerCase(), String(value)]))
    : {};

  return {
    firstName: first,
    lastName: last,
    fullName: [first, last].filter(Boolean).join(' '),
    email: text_('email'),
    phone: text_('phone'),
    location: text_('location'),
    currentCompany: text_('current_company'),
    linkedin: text_('linkedin'),
    github: text_('github'),
    website: text_('website'),
    ...resolveResume(dir, text_('resume')),
    boards,
    submit: data.submit === true,
    maxPerDay,
    answers,
    coverLetter: (match ? match[2] : '').trim(),
  };
}

/**
 * The resume must be a regular file inside job-hunt/ (no links out of the
 * vault). A problem only matters when applying, so searching still works.
 */
function resolveResume(dir, relative) {
  if (!relative) return { resumePath: null, resumeError: null };
  const file = path.resolve(dir, relative);
  if (!file.startsWith(dir + path.sep)) return { resumePath: null, resumeError: 'resume must be a file inside job-hunt/' };
  if (!lstat(file)?.isFile()) return { resumePath: null, resumeError: `resume file ${relative} was not found in job-hunt/` };
  return { resumePath: file, resumeError: null };
}

export function requireApplicant(profile) {
  if (profile.resumeError) throw new Error(profile.resumeError);
  const missing = [['first_name', profile.firstName], ['last_name', profile.lastName], ['email', profile.email], ['resume', profile.resumePath]]
    .filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`profile.md is missing ${missing.join(', ')}`);
}

function lstat(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}
