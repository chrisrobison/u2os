import { loadCandidate } from '../../mcp/jobs/hunt/candidate/load.js';
import { loadAutopilotConfig } from '../../mcp/jobs/hunt/autopilot/config.js';
import { generateMaterials } from '../../mcp/jobs/hunt/applications/materials.js';
import { stageAttachment } from '../tools/email-attachments.js';
import { createJobLlm } from './llm.js';

/**
 * The job's resume, cover letter and email draft, written once and reused. The owner pressed a button, so the
 * score threshold is not applied (a degraded score still refuses: materials are never written from a guess).
 * Throws with code NO_MODEL when no model can write them.
 */
export async function ensureMaterials({ vaultDir, store, job, need = 'email', llm = null, force = false, coverLetter = null, now = new Date() }) {
  const existing = store.getArtifacts(job.id);
  // `need` is the artifact the caller will use: the email draft, or the resume PDF a form uploads.
  if (!force && existing[need === 'form' ? 'resume_pdf' : 'email_json']) return { reused: true };
  const model = llm ?? createJobLlm();
  if (!model?.available) throw Object.assign(new Error('No model is available to write the materials. Connect one on the Models page, then try again.'), { code: 'NO_MODEL' });
  const candidate = loadCandidate(vaultDir);
  const result = await generateMaterials({
    store, vaultDir, job, candidate, llm: model, stage: stageAttachment, nameStyle: loadAutopilotConfig(vaultDir).file_names,
    minimumScore: 0, force, coverLetter, now,
  });
  return { reused: result.reused === true, needsInput: result.needsInput ?? [] };
}
