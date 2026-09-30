import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodingAgentError } from './types.js';

/**
 * Validates a run's working directory and returns its real path.
 *
 * - must be absolute (the caller resolves relative paths; nothing is guessed)
 * - symlinks are resolved, so a link cannot smuggle a run outside `roots`
 * - must be an existing directory
 * - never the filesystem root or the owner's home directory itself, unless
 *   the owner lists it in `roots` in coding-agents.yaml
 * - when `roots` is non-empty, must be inside one of them
 */
export function resolveWorkingDirectory(cwd, { roots = [] } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw invalid('cwd must be an absolute path');
  let real;
  try { real = fs.realpathSync(cwd); } catch { throw invalid(`cwd does not exist: ${cwd}`); }
  if (!fs.statSync(real).isDirectory()) throw invalid(`cwd is not a directory: ${cwd}`);

  const realRoots = roots.map((root) => { try { return fs.realpathSync(root); } catch { return null; } }).filter(Boolean);
  const inside = (root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  if (realRoots.length) {
    if (!realRoots.some(inside)) throw invalid(`cwd is outside the roots allowed in coding-agents.yaml: ${real}`);
    return real;
  }
  if (real === path.parse(real).root) throw invalid('cwd must not be the filesystem root');
  let home = null;
  try { home = fs.realpathSync(os.homedir()); } catch { /* no home directory */ }
  if (home && real === home) throw invalid('cwd must be a project directory, not your whole home directory (or list it under roots in coding-agents.yaml)');
  return real;
}

function invalid(message) {
  return new CodingAgentError(message, 'invalid_cwd');
}
