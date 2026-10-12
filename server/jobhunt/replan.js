import { loadPreferences, loadResume, candidateDigest } from '../../mcp/jobs/hunt/candidate/profile.js';
import { loadRepos } from '../../mcp/jobs/hunt/candidate/github.js';
import { loadFacts } from '../../mcp/jobs/hunt/candidate/facts.js';
import { loadAnswers } from '../../mcp/jobs/hunt/candidate/answers.js';
import { loadAutopilotConfig } from '../../mcp/jobs/hunt/autopilot/config.js';
import { ensureCombinedPdf } from '../../mcp/jobs/hunt/applications/materials.js';
import { planApplication } from '../../mcp/jobs/hunt/applications/form/submit.js';
import { createJobLlm } from './llm.js';

/**
 * Reads the job's application form again and plans every answer from the
 * owner's current resume, facts and answers. Read-only against the board;
 * submits nothing. Shared by `job plan` and the Job details page.
 */
export async function planJob({ vaultDir, store, job, llm = null, url = null, verifiedNoClick = false, now = new Date() }) {
  const resume = loadResume(vaultDir);
  const preferences = loadPreferences(vaultDir);
  const candidate = { resume, preferences, answers: loadAnswers(vaultDir), facts: loadFacts(vaultDir), repos: loadRepos(vaultDir)?.repos ?? [], digest: candidateDigest(resume, preferences) };
  const config = loadAutopilotConfig(vaultDir);
  return planApplication({ store, job, candidate, llm: llm ?? createJobLlm(), ensureCombined: ensureCombinedPdf, nameStyle: config.file_names, driver: config.browser.driver, url, verifiedNoClick, now });
}
