import fs from 'node:fs';
import path from 'node:path';
import { JOB_HUNT_DIR } from '../../profile.js';
import { generateResume, resumeToText } from './resume-generator.js';
import { assembleEmail, assembleLetter, generateCoverLetter, generateOutreachEmail, letterToText } from './letters.js';
import { chooseStrategy, needsCoverLetter } from './strategy.js';
import { combinedHtml, letterHtml, renderPdfs, resumeHtml } from './render.js';
import { parseLetterText } from './letters.js';
import { attachmentName } from './names.js';

const slug = (value) => String(value ?? 'unspecified').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unspecified';

export function materialsDir(vaultDir, job) {
  return path.join(vaultDir, JOB_HUNT_DIR, 'materials', slug(job.company), `${slug(job.role)}-${job.id.slice(4, 10)}`);
}

const write = (file, text) => fs.writeFileSync(file, text, { mode: 0o600 });

/**
 * Generates the materials for one job: resume (json, txt, pdf), a cover letter
 * when useful, and an outreach email draft when the strategy includes email.
 * Idempotent: existing materials are reused unless `force`.
 */
export async function generateMaterials({ store, vaultDir, job, candidate, llm, minimumScore = 82, force = false, pdf = true, coverLetter = null, stage = null, nameStyle = 'plain', now = new Date() }) {
  const score = store.getScore(job.id);
  if (!score) throw new Error(`Job ${job.id} has not been scored: run "job score" first`);
  if (score.degraded) throw new Error('Refusing to write materials from a degraded (rule-based) score; run "job score --rescore" with a model first');
  if (!llm?.available) throw new Error('A model is required to write materials');
  const existing = store.getArtifacts(job.id);
  if (existing.resume_json && !force) {
    let needsInput = [];
    try { needsInput = JSON.parse(fs.readFileSync(existing.email_json.path, 'utf8')).needsInput ?? []; } catch { /* no email draft */ }
    return { reused: true, dir: path.dirname(existing.resume_json.path), artifacts: existing, needsInput };
  }

  const source = store.listSources(job.id)[0] ?? null;
  const decision = chooseStrategy(job, { score, minimumScore: 0 });
  const dir = materialsDir(vaultDir, job);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = {};
  const models = new Set();

  const { document, model } = await generateResume({ job, source, score, candidate, llm });
  models.add(model);
  files.resume_json = path.join(dir, 'resume.json'); write(files.resume_json, `${JSON.stringify(document, null, 2)}\n`);
  files.resume_txt = path.join(dir, 'resume.txt'); write(files.resume_txt, resumeToText(document));

  let letter = null;
  if (coverLetter ?? needsCoverLetter({ strategy: decision.strategy, score })) {
    const result = await generateCoverLetter({ job, source, score, candidate, llm });
    models.add(result.model);
    letter = assembleLetter({ paragraphs: result.paragraphs, resume: candidate.resume, job, date: now });
    files.cover_letter_txt = path.join(dir, 'cover-letter.txt'); write(files.cover_letter_txt, letterToText(letter));
  }

  let email = null;
  if (decision.email) {
    const draft = await generateOutreachEmail({ job, source, score, candidate, llm, recipient: decision.email });
    models.add(draft.model);
    const assembled = assembleEmail({ draft, resume: candidate.resume });
    email = { to: decision.email, subject: assembled.subject, text: assembled.text, attachments: [], requirements: assembled.requirements, needsInput: assembled.needsInput };
  }

  let pages = {};
  if (pdf) {
    const entries = [{ file: path.join(dir, 'resume.pdf'), html: (size) => resumeHtml(document, { fontSize: size }), sizes: [9.4, 9, 8.6], maxPages: 2 }];
    if (letter) {
      entries.push({ file: path.join(dir, 'cover-letter.pdf'), html: () => letterHtml(letter), maxPages: 2 });
      // For forms with no cover-letter upload: the letter first, then the resume, as one file.
      entries.push({ file: path.join(dir, 'resume-with-cover-letter.pdf'), html: (size) => combinedHtml(letter, document, { fontSize: size }), sizes: [9.4, 9, 8.6], maxPages: 4 });
    }
    for (const result of await renderPdfs(entries)) pages[path.basename(result.file)] = result.pages;
    files.resume_pdf = path.join(dir, 'resume.pdf');
    if (letter) { files.cover_letter_pdf = path.join(dir, 'cover-letter.pdf'); files.combined_pdf = path.join(dir, 'resume-with-cover-letter.pdf'); }
  }
  if (email) {
    // Attachments are staged, content-addressed references (email.send never takes a path).
    // Without a stager (or without PDFs) the draft has none.
    const name = (kind) => attachmentName({ kind, person: candidate.resume.basics.name, company: job.company, seed: job.id, style: nameStyle });
    const toStage = [[files.resume_pdf, name('resume')], [files.cover_letter_pdf, name('cover_letter')]].filter(([file]) => file);
    email.attachments = stage ? toStage.map(([file, name]) => stage(vaultDir, file, { name }).ref) : [];
    files.email_json = path.join(dir, 'email.json'); write(files.email_json, `${JSON.stringify(email, null, 2)}\n`);
  }

  store.transaction(() => {
    for (const [kind, file] of Object.entries(files)) store.addArtifact(job.id, kind, file, { models: [...models], pages: pages[path.basename(file)] ?? null, strategy: decision.strategy }, now);
    const target = email?.needsInput?.length ? 'needs_input' : 'materials_generated';
    if (['discovered', 'scored', 'researching', 'qualified', 'needs_input', 'materials_generated'].includes(store.getJob(job.id).status)) store.transition(job.id, target, { dir, strategy: decision.strategy, coverLetter: Boolean(letter), email: Boolean(email), needsInput: email?.needsInput ?? [] }, now);
    else store.recordEvent(job.id, 'materials_regenerated', { detail: { dir } }, now);
  });
  return { reused: false, dir, strategy: decision, needsInput: email?.needsInput ?? [], artifacts: store.getArtifacts(job.id), pages, letter: Boolean(letter), email };
}


/**
 * Builds resume-with-cover-letter.pdf for a job whose materials predate it (or whose letter was written later),
 * from the stored resume.json and cover-letter.txt. No model is involved. Returns the artifact, or null when
 * there is no letter to combine.
 */
export async function ensureCombinedPdf({ store, job, now = new Date(), render = renderPdfs }) {
  const artifacts = store.getArtifacts(job.id);
  if (!artifacts.resume_json || !artifacts.cover_letter_txt) return null;
  const file = path.join(path.dirname(artifacts.resume_json.path), 'resume-with-cover-letter.pdf');
  const fresh = artifacts.combined_pdf && fs.existsSync(artifacts.combined_pdf.path) && artifacts.combined_pdf.createdAt >= artifacts.cover_letter_txt.createdAt && artifacts.combined_pdf.createdAt >= artifacts.resume_json.createdAt;
  if (fresh) return artifacts.combined_pdf;
  const letter = parseLetterText(fs.readFileSync(artifacts.cover_letter_txt.path, 'utf8'));
  if (!letter) return null;
  const document = JSON.parse(fs.readFileSync(artifacts.resume_json.path, 'utf8'));
  await render([{ file, html: (size) => combinedHtml(letter, document, { fontSize: size }), sizes: [9.4, 9, 8.6], maxPages: 4 }]);
  store.addArtifact(job.id, 'combined_pdf', file, { rebuilt: true }, now);
  return store.getArtifacts(job.id).combined_pdf;
}
