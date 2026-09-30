// Provider-independent "what changed" for a run: compare `git status` before
// and after. argv array, no shell, short timeout; a non-repository (or no
// git) simply yields no answer.
import { runProcess } from './runner.js';
import { buildChildEnv } from './env.js';

/** Map of path -> status code for the working tree, or null when unknown. */
export async function gitSnapshot(cwd) {
  const result = await runProcess({
    executable: 'git',
    args: ['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    cwd,
    env: buildChildEnv({}),
    timeoutMs: 15_000,
    maxCaptureBytes: 4 * 1024 * 1024,
  });
  if (result.spawnError || result.exitCode !== 0) return null;
  const snapshot = new Map();
  // With -z, stdout's lines were split on "\n" by the runner; entries are NUL separated.
  const entries = result.stdout.replaceAll('\n', '').split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const code = entry.slice(0, 2);
    snapshot.set(entry.slice(3), code);
    if (code[0] === 'R' || code[0] === 'C') i += 1; // a rename is followed by its source path
  }
  return snapshot;
}

/** Paths whose status differs between two snapshots, sorted. Undefined if either is unknown. */
export function changedFiles(before, after) {
  if (!before || !after) return undefined;
  const changed = new Set();
  for (const [file, code] of after) if (before.get(file) !== code) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}
