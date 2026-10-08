import { candidateDigest, loadPreferences, loadResume } from './profile.js';
import { loadAnswers } from './answers.js';
import { loadFacts } from './facts.js';
import { loadRepos } from './github.js';

/** Everything about the candidate that scoring, materials, planning, review and acting read, from the owner's vault. */
export function loadCandidate(vaultDir) {
  const resume = loadResume(vaultDir);
  const preferences = loadPreferences(vaultDir);
  return { resume, preferences, answers: loadAnswers(vaultDir), facts: loadFacts(vaultDir), repos: loadRepos(vaultDir)?.repos ?? [], digest: candidateDigest(resume, preferences) };
}
