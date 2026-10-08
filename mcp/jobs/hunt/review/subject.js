import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONTACT_SOURCES } from '../sources/common.js';

// What a review looks at, and the hash that binds an approval to it. The hash
// covers the posting text, the resume and letter files, the email and the
// form plan: change any of them and the approval no longer applies.

const hashOf = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const read = (artifact) => { try { return artifact ? fs.readFileSync(artifact.path, 'utf8') : null; } catch { return null; } };

/** The settings a decision depends on besides the content: changing any of them means the decision must be made again. */
export function reviewPolicy({ preferences, config }) {
  return { minimum: preferences?.minimum_score ?? null, allow: config?.allow ?? null, blocklist: config?.blocklist ?? null, limits: config?.limits ?? null };
}

export function loadSubject({ store, job, kind, policy = null }) {
  if (!['email', 'form'].includes(kind)) throw new Error('kind must be email or form');
  const artifacts = store.getArtifacts(job.id);
  const sources = store.listSources(job.id);
  const posting = sources.find((source) => source.rawText)?.rawText ?? job.description ?? '';
  const inviting = sources.filter((source) => CONTACT_SOURCES.has(source.source)).map((source) => source.rawText).join('\n');
  const resumeText = read(artifacts.resume_txt);
  const letterText = read(artifacts.cover_letter_txt);
  let draft = null;
  try { draft = artifacts.email_json ? JSON.parse(read(artifacts.email_json)) : null; } catch { draft = null; }
  const application = kind === 'form' ? store.listApplications(job.id).filter((entry) => entry.kind === 'form').at(-1) ?? null : null;
  const subject = {
    kind, posting, invitingText: inviting, author: sources[0]?.author ?? null, resumeText, letterText,
    email: kind === 'email' && draft ? { to: draft.to, subject: draft.subject, text: draft.text, attachments: draft.attachments ?? [], needsInput: draft.needsInput ?? [] } : null,
    application,
  };
  subject.contentHash = hashOf({
    kind, posting: hashOf(posting), resumePdf: artifacts.resume_pdf?.sha256 ?? null, coverPdf: artifacts.cover_letter_pdf?.sha256 ?? null,
    resumeText: hashOf(resumeText ?? ''), letterText: hashOf(letterText ?? ''), email: subject.email, planHash: application?.planHash ?? null,
    // The score and the owner's settings are part of what was decided: a new score, threshold, allowance or blocklist re-opens the decision.
    score: (() => { const score = store.getScore(job.id); return score ? { value: score.score, degraded: score.degraded } : null; })(), policy,
  });
  return subject;
}
