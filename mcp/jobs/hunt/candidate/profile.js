import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from '../../profile.js';
import { NARRATIVES } from './narratives.js';

// The candidate: the canonical resume (JSON Resume format) plus the owner's
// preferences. Both are owner-authored files in the vault. The model never
// supplies or alters either.
//
//   job-hunt/resume.json       canonical employment history and skills
//   job-hunt/preferences.yaml  what the owner wants (all keys optional)

export const DEFAULT_PREFERENCES = Object.freeze({
  minimum_score: 82,
  locations: ['San Francisco', 'Bay Area hybrid', 'Remote US'],
  home: { city: 'San Francisco', region: 'CA', country: 'US', areas: ['san francisco', 'sf', 'bay area', 'oakland', 'berkeley', 'palo alto', 'mountain view', 'sunnyvale', 'san jose', 'south bay', 'peninsula', 'redwood city', 'menlo park'] },
  minimum_salary: null,
  preferred_roles: ['staff engineer', 'principal engineer', 'founding engineer', 'engineering manager', 'director of engineering', 'vp engineering', 'cto', 'head of engineering', 'developer experience', 'sdk', 'platform', 'ai', 'agent', 'developer tools', 'operations software'],
  avoid: [],
  interests: ['AI agents', 'developer tools', 'operations software', 'robotics and hardware'],
  narratives: {},
});

const MAX_BYTES = 512 * 1024;

function readFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`${file} must be a regular file under 512 KiB`);
  return fs.readFileSync(file, 'utf8');
}

export function resumePath(vaultDir) { return path.join(vaultDir, JOB_HUNT_DIR, 'resume.json'); }
export function preferencesPath(vaultDir) { return path.join(vaultDir, JOB_HUNT_DIR, 'preferences.yaml'); }

export function loadResume(vaultDir) {
  let text;
  try { text = readFile(resumePath(vaultDir)); } catch { throw new Error(`No resume: run "npm run u2 -- job profile import <resume.json>" (expected ${JOB_HUNT_DIR}/resume.json in your vault)`); }
  const resume = JSON.parse(text);
  if (!resume || typeof resume !== 'object' || !resume.basics || !Array.isArray(resume.work)) throw new Error('resume.json must be JSON Resume format with basics and work');
  return resume;
}

export function loadPreferences(vaultDir) {
  let data = {};
  try { data = yaml.load(readFile(preferencesPath(vaultDir)), { schema: yaml.CORE_SCHEMA }) ?? {}; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('preferences.yaml must be a mapping');
  const minimumScore = data.minimum_score ?? DEFAULT_PREFERENCES.minimum_score;
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) throw new Error('minimum_score must be 0-100');
  return { ...DEFAULT_PREFERENCES, ...data, minimum_score: minimumScore, home: { ...DEFAULT_PREFERENCES.home, ...(data.home ?? {}) } };
}

/** Copies a resume into the vault after validating it. */
export function importResume(vaultDir, source) {
  const text = readFile(path.resolve(source));
  const resume = JSON.parse(text);
  if (!resume?.basics || !Array.isArray(resume.work)) throw new Error('Not a JSON Resume file (needs basics and work)');
  const target = resumePath(vaultDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(resume, null, 2)}\n`, { mode: 0o600 });
  return { target, name: resume.basics.name, jobs: resume.work.length };
}

const stripHtml = (html) => String(html ?? '')
  .replace(/<\/(li|p|div|ul)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#x27;|&#39;/g, "'")
  .replace(/\n{2,}/g, '\n').trim();

/**
 * Plain-text digest of the candidate for a model. Deliberately omits phone,
 * email and references: scoring does not need them, and less personal data
 * leaves the machine.
 */
export function candidateDigest(resume, preferences = DEFAULT_PREFERENCES, { narratives = NARRATIVES } = {}) {
  const lines = [];
  lines.push(`Name: ${resume.basics.name}`);
  if (resume.basics.summary) lines.push(`Summary: ${stripHtml(resume.basics.summary)}`);
  lines.push(`Home: ${[resume.basics.location?.city, resume.basics.location?.region].filter(Boolean).join(', ')}`);
  lines.push('\nEMPLOYMENT (canonical; do not assume anything not listed):');
  for (const job of resume.work) {
    lines.push(`* ${job.position}, ${job.company}${job.location ? `, ${job.location}` : ''} (${job.period || [job.startDate, job.endDate].filter(Boolean).join(' - ')})`);
    const summary = stripHtml(job.summary);
    if (summary) lines.push(summary.split('\n').map((line) => `    ${line}`).join('\n'));
  }
  lines.push('\nSKILLS:');
  for (const skill of resume.skills ?? []) lines.push(`* ${skill.name}: ${(skill.keywords ?? []).join(', ')}`);
  lines.push('\nEDUCATION:');
  for (const school of resume.education ?? []) lines.push(`* ${school.institution}: ${school.area ?? ''}`);
  lines.push('\nPREFERENCES:');
  lines.push(`Locations, in order: ${preferences.locations.join('; ')}`);
  lines.push(`Preferred roles: ${preferences.preferred_roles.join(', ')}`);
  if (preferences.minimum_salary) lines.push(`Minimum salary: ${preferences.minimum_salary}`);
  if (preferences.avoid?.length) lines.push(`Avoid: ${preferences.avoid.join(', ')}`);
  lines.push(`Interests: ${preferences.interests.join(', ')}`);
  lines.push('\nPROFESSIONAL NARRATIVES (choose the one that fits the role):');
  for (const [id, narrative] of Object.entries(narratives)) lines.push(`* ${id}: ${narrative.label}; emphasize ${narrative.emphasize.join('; ')}`);
  return lines.join('\n');
}
