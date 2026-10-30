import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdown } from '../../../server/vault/markdown.js';
import { editVaultFile } from '../../../server/vault/writeback.js';
import { JOB_HUNT_DIR } from '../profile.js';
import { scoreJob } from './jobs/scorer.js';
import { candidateDigest, loadPreferences, loadResume } from './candidate/profile.js';
import { loadRepos } from './candidate/github.js';
import { factsPath } from './candidate/facts.js';

// Evidence resolution (#636, Phase 5 of #626). The scorer judges some parts of a fit (experience, seniority, technical
// overlap, company, interest) and raises concerns, and nothing in the owner's files backs those judgements, so the job
// detail panel lists them as "unverified". This module lets the owner answer, per item, "can you back this up?" with
// Yes, No or Partly (and an optional detail), and keeps what they said with its provenance.
//
// Questions are derived here from the job's stored score and latest review; a client cannot invent one or change its
// wording. Each has a stable key: `dim:<dimension>` for a model-judged dimension, `concern:<12 hex of SHA-256>` for a
// concern, so the same item keeps the same key until its text changes.
//
// Storage (documented in docs/job-hunt.md "Evidence resolution" and docs/vault.md):
//   job-hunt/evidence/<job-id>.md   the record, one file per job, written with editVaultFile. Front matter holds
//                                   `answers`: a list of { key, answer, detail, label, source: owner, job, at }.
//   job-hunt/facts.md               Yes and Partly answers are also added, one marked line each, under
//                                   "## Owner-stated evidence", so the claim guard and the materials generator treat
//                                   them as facts the owner approved. A No is never written there: it is a recorded gap,
//                                   not a claim anything may make.
// Nothing here changes a dimension's points or invents a per-skill number. A saved answer is rescored through the
// existing scorer (scoreJob), which sees the owner's statements as part of the candidate digest.

export const JOB_ID = /^job_[0-9a-f]{16}$/;
export const EVIDENCE_DIR = `${JOB_HUNT_DIR}/evidence`;
export const FACTS_HEADING = '## Owner-stated evidence';
export const ANSWERS = Object.freeze(['yes', 'no', 'partly']);
export const MAX_DETAIL = 1000;
export const MAX_ENTRIES = 100;
const MAX_FACTS_BYTES = 200 * 1024;
const KEY = /^(dim:(experience|seniority|technical|company|interest)|concern:[0-9a-f]{12})$/;
const DIMENSIONS = ['experience', 'seniority', 'technical', 'company', 'interest'];
const CAVEAT_CONCERN = /Scored by rules without a model|Model unavailable/i;
const DETERMINISTIC_CONCERN = [/relocat|on-site|remote|location/i, /range|salary|compensation|minimum/i];
const NO_RESCORE = new Set(['applying', 'applied', 'contacted', 'followup_due', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'closed', 'skipped', 'uncertain']);

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const titleCase = (value) => String(value ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export const evidenceRelativePath = (jobId) => {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw fail('BAD_INPUT', 'Invalid job id');
  return `${EVIDENCE_DIR}/${jobId}.md`;
};

// ---- questions ------------------------------------------------------------------------

const concernKey = (text) => `concern:${crypto.createHash('sha256').update(squash(text).toLowerCase(), 'utf8').digest('hex').slice(0, 12)}`;

/**
 * The questions the owner can answer for a job, from its stored score and latest review only:
 *   [{ key, kind: 'dimension' | 'concern', statement, prompt, source }]
 * `statement` is the stored text being asked about; `prompt` is U2OS's wording. Rule-based items (location, pay) and the
 * "scored by rules" caveat get no question: a rule, not a judgement, decided them.
 */
export function evidenceQuestions({ score, dimensions = score?.dimensions ?? {}, review = null }) {
  if (!score) return [];
  const questions = [];
  const seen = new Set();
  const add = (question) => { if (!seen.has(question.key)) { seen.add(question.key); questions.push(question); } };
  const ruled = ['location', 'compensation'].map((name, index) => (dimensions[name]?.reason && Number.isFinite(dimensions[name].points) && dimensions[name].max > 0 ? DETERMINISTIC_CONCERN[index] : null)).filter(Boolean);
  for (const name of DIMENSIONS) {
    const dim = dimensions[name];
    if (!dim?.reason || !Number.isFinite(dim.points) || !(dim.max > 0)) continue;
    add({ key: `dim:${name}`, kind: 'dimension', statement: `${titleCase(name)}: ${dim.reason}`, prompt: `Can you back up the ${name} part of this match with your own experience?`, source: 'Scorer' });
  }
  for (const concern of score.concerns ?? []) {
    const text = String(concern ?? '').trim();
    if (!text || CAVEAT_CONCERN.test(text) || ruled.some((pattern) => pattern.test(text))) continue;
    add({ key: concernKey(text), kind: 'concern', statement: text, prompt: 'Do you have experience or evidence that addresses this concern?', source: 'Scorer' });
  }
  for (const concern of (review?.concerns ?? []).filter((entry) => entry?.text && entry.severity !== 'blocking')) {
    const text = String(concern.text).trim();
    if (!text) continue;
    add({ key: concernKey(text), kind: 'concern', statement: text, prompt: 'Do you have experience or evidence that addresses this concern?', source: 'Review' });
  }
  return questions;
}

// ---- the record -------------------------------------------------------------------------

/** Refuses a vault where job-hunt or job-hunt/evidence is a link or a file. Creates the folders when `create`. */
function ensureDir(vaultDir, create) {
  let dir = vaultDir;
  for (const part of EVIDENCE_DIR.split('/')) {
    dir = path.join(dir, part);
    let stat = null;
    try { stat = fs.lstatSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) {
      if (!create) return false;
      fs.mkdirSync(dir, { mode: 0o700 });
      continue;
    }
    if (!stat.isDirectory()) throw fail('UNSAFE_PATH', `${EVIDENCE_DIR} must be a real folder inside the vault (not a link)`);
  }
  return true;
}

function validEntry(raw, jobId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!KEY.test(String(raw.key)) || !ANSWERS.includes(raw.answer) || raw.source !== 'owner' || raw.job !== jobId) return null;
  const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? raw.at : null;
  if (!at) return null;
  const detail = typeof raw.detail === 'string' ? raw.detail.slice(0, MAX_DETAIL) : '';
  return { key: raw.key, answer: raw.answer, detail, label: squash(raw.label).slice(0, 400), source: 'owner', job: jobId, at };
}

/** What the owner has stated for a job: { exists, answers: [entry] }. A hand-edited entry that is not valid is ignored. */
export function readEvidence(vaultDir, jobId) {
  const relativePath = evidenceRelativePath(jobId);
  if (!ensureDir(vaultDir, false)) return { path: relativePath, exists: false, answers: [] };
  const file = path.join(vaultDir, relativePath);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { path: relativePath, exists: false, answers: [] }; throw error; }
  if (!stat.isFile()) throw fail('UNSAFE_PATH', 'The evidence file must be a regular file (not a link)');
  if (stat.size > 256 * 1024) throw fail('EVIDENCE_INVALID', 'The evidence file is too large for the app to open; edit it in a text editor');
  let parsed;
  try { parsed = parseMarkdown(fs.readFileSync(file, 'utf8')); } catch (error) { throw fail('EVIDENCE_INVALID', `${relativePath} has invalid frontmatter; fix the file first (${error.message})`); }
  const listed = Array.isArray(parsed.frontmatter.answers) ? parsed.frontmatter.answers : [];
  const byKey = new Map();
  for (const raw of listed.slice(0, MAX_ENTRIES)) { const entry = validEntry(raw, jobId); if (entry) byKey.set(entry.key, entry); }
  return { path: relativePath, exists: true, answers: [...byKey.values()] };
}

const factLine = (entry) => {
  const clean = (text, max) => squash(text).replace(/<!--|-->/g, '').slice(0, max);
  const how = entry.answer === 'yes' ? 'can back up' : 'can partly back up';
  return `- <!-- u2-evidence ${entry.job} ${entry.key} --> Stated by the owner on ${entry.at.slice(0, 10)} (job ${entry.job}, ${entry.key}): ${how} "${clean(entry.label, 300)}"${entry.detail ? ` - ${clean(entry.detail, MAX_DETAIL)}` : ''}`;
};
const markerOf = (jobId, key) => `<!-- u2-evidence ${jobId} ${key} -->`;

/** facts.md text with the job's line for `key` set to `line` (or removed when null). Pure. */
export function applyFactsLine(text, { jobId, key, line }) {
  const lines = String(text).split('\n');
  const marker = markerOf(jobId, key);
  const at = lines.findIndex((entry) => entry.includes(marker));
  if (line == null) {
    if (at === -1) return text;
    lines.splice(at, 1);
    const head = lines.findIndex((entry) => entry.trim() === FACTS_HEADING);
    if (head !== -1) {
      let end = head + 1;
      while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1;
      if (lines.slice(head + 1, end).every((entry) => !entry.trim())) lines.splice(head, end - head);
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  if (at !== -1) { lines[at] = line; return lines.join('\n'); }
  const head = lines.findIndex((entry) => entry.trim() === FACTS_HEADING);
  if (head === -1) {
    const body = String(text).replace(/\s*$/, '');
    return `${body}${body ? '\n\n' : ''}${FACTS_HEADING}\n\n${line}\n`;
  }
  let end = head + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1;
  let last = end - 1;
  while (last > head && !lines[last].trim()) last -= 1;
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

/** Atomic text write of facts.md: a regular file only, temporary file then rename, refused if it changed meanwhile. */
function mirrorToFacts(vaultDir, { jobId, key, line }) {
  const file = factsPath(vaultDir);
  const dir = path.dirname(file);
  try { if (!fs.lstatSync(dir).isDirectory()) throw fail('UNSAFE_PATH', `${JOB_HUNT_DIR} must be a real folder inside the vault (not a link)`); } catch (error) { if (error.code !== 'ENOENT') throw error; if (line == null) return false; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  let original = '';
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw fail('UNSAFE_PATH', `${JOB_HUNT_DIR}/facts.md must be a regular file (not a link)`);
    if (stat.size > MAX_FACTS_BYTES) throw fail('TOO_LARGE', `${JOB_HUNT_DIR}/facts.md is too large to add to from the app`);
    mode = stat.mode & 0o777;
    original = fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; if (line == null) return false; }
  const next = applyFactsLine(original, { jobId, key, line });
  if (next === original) return false;
  const temporary = path.join(dir, `.facts.md.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
  try {
    fs.chmodSync(temporary, mode);
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== original) throw fail('CONFLICT', `${JOB_HUNT_DIR}/facts.md changed while it was being edited; try again`);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return true;
}

const recordBody = (job, answers) => [
  `# Evidence you stated for ${squash(job.company)} - ${squash(job.role) || '(no role)'}`, '',
  ...answers.map((entry) => `- ${entry.at.slice(0, 10)} ${titleCase(entry.answer)}: ${entry.label}${entry.detail ? ` (${squash(entry.detail).slice(0, 200)})` : ''}`),
].join('\n');

/**
 * Saves the owner's answer to one question. job: { id, company, role }; questions: evidenceQuestions(...) for that job.
 * Returns { entry, changed }. Saving the same answer again changes nothing (the original timestamp is kept); a different
 * answer or detail replaces the earlier one for that key.
 */
export function saveEvidenceAnswer({ vaultDir, job, questions, key, answer, detail = '', now = new Date() }) {
  const jobId = job?.id;
  const relativePath = evidenceRelativePath(jobId);
  if (typeof key !== 'string' || !KEY.test(key)) throw fail('BAD_INPUT', 'That is not an evidence question');
  const question = questions.find((entry) => entry.key === key);
  if (!question) throw fail('BAD_INPUT', 'That question is not waiting for an answer on this job');
  if (typeof answer !== 'string' || !ANSWERS.includes(answer)) throw fail('BAD_INPUT', 'answer must be yes, no or partly');
  if (detail != null && typeof detail !== 'string') throw fail('BAD_INPUT', 'detail must be text');
  const text = String(detail ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_DETAIL) throw fail('TOO_LARGE', `The detail can be at most ${MAX_DETAIL} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('BAD_INPUT', 'The detail must be plain text');

  const current = readEvidence(vaultDir, jobId);
  const previous = current.answers.find((entry) => entry.key === key) ?? null;
  const entry = previous && previous.answer === answer && previous.detail === text
    ? previous
    : { key, answer, detail: text, label: squash(question.statement).slice(0, 400), source: 'owner', job: jobId, at: now.toISOString() };
  const changed = entry !== previous;
  if (changed) {
    if (!previous && current.answers.length >= MAX_ENTRIES) throw fail('TOO_LARGE', `A job can hold at most ${MAX_ENTRIES} stated answers`);
    ensureDir(vaultDir, true);
    editVaultFile({ vaultDir, relativePath }, (frontmatter) => {
      const kept = (Array.isArray(frontmatter.answers) ? frontmatter.answers : []).map((raw) => validEntry(raw, jobId)).filter((valid) => valid && valid.key !== key);
      const answers = [...kept, entry];
      return { frontmatter: { ...frontmatter, job: jobId, company: String(job.company ?? ''), role: String(job.role ?? ''), updated: now.toISOString(), answers }, body: recordBody(job, answers) };
    }, { create: true });
  }
  // The mirror is checked every time, so a save whose facts.md write failed earlier is repaired by saving again.
  mirrorToFacts(vaultDir, { jobId, key, line: answer === 'no' ? null : factLine(entry) });
  return { entry, changed };
}

// ---- what the job view carries ------------------------------------------------------------

const summary = (score) => (score ? { score: score.score, confidence: typeof score.confidence === 'number' && Number.isFinite(score.confidence) ? score.confidence : null, label: score.label ?? null, scoredAt: score.scoredAt ?? null, model: score.model ?? null, degraded: Boolean(score.degraded) } : null);

/** For the detail view: { questions, answers, lastAnsweredAt, rescorePending, error? }. A broken evidence file never breaks the job view. */
export function evidenceView({ vaultDir, store, job }) {
  const score = store.getScore(job.id);
  const questions = evidenceQuestions({ score, review: store.listReviews(job.id)[0] ?? null });
  let answers = [];
  let error = null;
  try { answers = readEvidence(vaultDir, job.id).answers; } catch (caught) { error = String(caught.message).slice(0, 200); }
  const lastAnsweredAt = answers.map((entry) => entry.at).sort().at(-1) ?? null;
  const rescorePending = Boolean(lastAnsweredAt && score && !NO_RESCORE.has(job.status) && !(Date.parse(score.scoredAt) >= Date.parse(lastAnsweredAt)));
  return { questions, answers, lastAnsweredAt, rescorePending, ...(error ? { error } : {}) };
}

// ---- rescoring ----------------------------------------------------------------------------

/**
 * Scores the job again with the existing scorer (scoreJob + store.saveScore, as `job score --rescore` does), after
 * adding the owner's stated evidence for this job to the candidate digest. Never replaces a model score with a rule
 * estimate: without a model, or when the model falls back to rules, the old score stays and the status says why.
 * Returns { status: 'done' | 'pending' | 'failed' | 'skipped', reason?, previous, current } where previous and current
 * are { score, confidence, label, scoredAt, model, degraded } or null.
 */
export async function rescoreJob({ vaultDir, store, job, llm = null, now = new Date() }) {
  const previous = summary(store.getScore(job.id));
  const outcome = (status, reason, current = null) => ({ status, ...(reason ? { reason } : {}), previous, current });
  if (!previous) return outcome('skipped', 'This job has not been scored yet.');
  if (NO_RESCORE.has(job.status)) return outcome('skipped', `This job is ${job.status.replace(/_/g, ' ')}, so its score is left as it was.`);
  if (!llm?.available) return outcome('pending', 'No model is available right now.');
  try {
    const resume = loadResume(vaultDir);
    const preferences = loadPreferences(vaultDir);
    const questions = evidenceQuestions({ score: store.getScore(job.id), review: store.listReviews(job.id)[0] ?? null });
    const statements = new Map(questions.map((question) => [question.key, question.statement]));
    const ownerEvidence = readEvidence(vaultDir, job.id).answers.map((entry) => {
      const verdict = { yes: 'YES, can back this up', partly: 'PARTLY', no: 'NO (the candidate says this is a real gap)' }[entry.answer];
      return `* ${squash(statements.get(entry.key) ?? entry.label).slice(0, 300)} -> ${verdict}${entry.detail ? `: ${squash(entry.detail).slice(0, MAX_DETAIL)}` : ''}`;
    });
    const candidate = { resume, preferences, repos: loadRepos(vaultDir)?.repos ?? [], digest: candidateDigest(resume, preferences, { ownerEvidence }) };
    const result = await scoreJob({ job, source: store.listSources(job.id)[0] ?? null, candidate, llm });
    if (result.degraded) return outcome('failed', 'The model did not produce a score, so the rule-based estimate (which ignores your answer) was not kept.');
    const saved = store.saveScore(job.id, result, now);
    return outcome('done', null, summary(saved));
  } catch (error) {
    return outcome('failed', String(error.message ?? 'Rescoring failed').slice(0, 200));
  }
}
