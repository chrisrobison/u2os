import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from '../../profile.js';
import { BOARD } from './ats.js';

// Which company boards to read: the ones the owner lists in
// job-hunt/boards.yaml, plus (unless `derive: false`) boards the store has
// already seen through application links (an HN listing that points at
// jobs.lever.co/acme tells us the board).
//
//   boards:
//     - greenhouse:anthropic
//     - lever:palantir
//     - ashby:ramp
//   derive: true

export const boardsPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'boards.yaml');

export function loadBoardConfig(vaultDir) {
  let data = {};
  try {
    const stat = fs.lstatSync(boardsPath(vaultDir));
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('boards.yaml must be a regular file under 64 KiB');
    data = yaml.load(fs.readFileSync(boardsPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('boards.yaml must be a mapping');
  const boards = (Array.isArray(data.boards) ? data.boards : []).map(String);
  const bad = boards.find((board) => !BOARD.test(board));
  if (bad) throw new Error(`boards.yaml: "${bad}" must look like greenhouse:<board>, lever:<company> or ashby:<board>`);
  return { boards, derive: data.derive !== false };
}

const PATTERNS = [
  [/(?:^|\/\/)(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([A-Za-z0-9_.-]+)\/jobs\//i, 'greenhouse'],
  [/\/\/jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9_.-]+)\//i, 'lever'],
  [/\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)\//i, 'ashby'],
];

/** Boards named by application links already in the store. */
export function deriveBoards(store) {
  const found = new Set();
  for (const job of store.listJobs({ limit: 5000 })) {
    for (const url of job.applicationUrls) {
      for (const [pattern, kind] of PATTERNS) {
        const slug = url.match(pattern)?.[1];
        if (slug && slug !== 'embed') { const name = `${kind}:${decodeURIComponent(slug)}`; if (BOARD.test(name)) found.add(name); }
      }
    }
  }
  return [...found].sort();
}

export function resolveBoards({ vaultDir, store, only = [] }) {
  if (only.length) return [...new Set(only)];
  const config = loadBoardConfig(vaultDir);
  return [...new Set([...config.boards, ...(config.derive ? deriveBoards(store) : [])])];
}
