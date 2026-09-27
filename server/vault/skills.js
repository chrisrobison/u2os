import path from 'node:path';
import { getVaultDir, SKILLS_DIR } from './vault-dir.js';
import { listMarkdownFiles, readVaultFile, fileSignature } from './markdown.js';

// Skills are owner-written instructions in the vault: how the owner wants
// something done (docs/skills.md, ADR 0009). They are text for the planner,
// not code: routines name the skills they use and the runner passes the
// instructions along with the routine's own instruction.

export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_SKILL_CHARS = 8_000;

export function loadSkills(vaultDir = getVaultDir()) {
  const skills = new Map();
  for (const relativePath of listMarkdownFiles(vaultDir, SKILLS_DIR)) {
    const name = path.posix.basename(relativePath, '.md');
    try {
      if (!SKILL_NAME.test(name)) throw invalid('Skill file names must be lowercase letters, digits, "-" or "_"');
      const { frontmatter, body } = readVaultFile(vaultDir, relativePath);
      const instructions = body.trim();
      if (!instructions) throw invalid('A skill needs instructions in the body');
      if (instructions.length > MAX_SKILL_CHARS) throw invalid(`Skill instructions are limited to ${MAX_SKILL_CHARS} characters`);
      const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
      skills.set(name, { name, path: relativePath, description, instructions, error: null });
    } catch (error) {
      if (error.code !== 'VAULT_INVALID' && error.code !== 'ENOENT') throw error;
      skills.set(name, { name, path: relativePath, description: '', instructions: '', error: error.message });
    }
  }
  return skills;
}

/** Stat signature of the skills folder, so routine caches notice skill edits. */
export function skillsSignature(vaultDir = getVaultDir()) {
  return listMarkdownFiles(vaultDir, SKILLS_DIR).map((file) => `${file}=${fileSignature(vaultDir, file)}`).join('|');
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'VAULT_INVALID';
  return error;
}
