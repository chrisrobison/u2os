import fs from 'node:fs';
import path from 'node:path';
import { JOB_HUNT_DIR } from '../../profile.js';

// Owner-approved material beyond the bare resume JSON:
//
//   job-hunt/facts.md   facts, bullets and projects the owner has approved for
//                       use in applications (for example lifted from résumés
//                       the owner already sent). Free Markdown. A "## Project:
//                       Name" heading defines a project the generator may list.
//   job-hunt/voice.md   writing samples in the owner's voice (optional).
//
// Generated text may only claim what these files, the resume and the owner's
// public repositories support (applications/guard.js).

const read = (file) => { try { const stat = fs.lstatSync(file); return stat.isFile() && stat.size < 256 * 1024 ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; } };

export const factsPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'facts.md');
export const voicePath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'voice.md');

export function loadFacts(vaultDir) {
  const text = read(factsPath(vaultDir));
  const projects = [...text.matchAll(/^##\s+Project:\s*(.+?)\s*$/gim)].map((match) => match[1]);
  return { text, projects, voice: read(voicePath(vaultDir)) };
}
