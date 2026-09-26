import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';

const DATABASE = 'db/u2os.sqlite';
const SIDECARS = new Set([`${DATABASE}-wal`, `${DATABASE}-shm`, `${DATABASE}-journal`]);
const GUARDS = new Set(['.runtime-lock.sqlite', '.runtime-lock.sqlite-journal', '.runtime-lock.sqlite-wal', '.runtime-lock.sqlite-shm']);

/** Source ownership must already be held. Never open application storage
 * through getDb(): a snapshot must not migrate or reconcile the source. */
export async function stageSnapshot(home, destination) {
  const databasePath = path.join(home, DATABASE);
  const hasDatabase = fs.existsSync(databasePath);
  function copyDirectory(source, target, prefix = '') {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (GUARDS.has(relative)) continue;
      if (SIDECARS.has(relative)) {
        if (!hasDatabase) throw new Error('snapshot: SQLite sidecars exist without the application database; review storage before backup');
        continue;
      }
      const from = path.join(source, name), to = path.join(target, name);
      const stat = fs.lstatSync(from);
      if (stat.isDirectory()) copyDirectory(from, to, relative);
      else if (!stat.isFile()) throw new Error('snapshot: source links or special files are unsupported; review storage before backup');
      else if (relative !== DATABASE) {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(to, stat.mode & 0o777);
      }
    }
  }
  copyDirectory(home, destination);
  if (!hasDatabase) return;
  if (typeof sqlite.backup !== 'function') throw new Error('snapshot: SQLite backup requires Node.js 22.16 or newer; upgrade Node before backup');
  const source = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  const targetPath = path.join(destination, DATABASE);
  try { await sqlite.backup(source, targetPath); }
  finally { source.close(); }
  fs.chmodSync(targetPath, 0o600);
  const target = new sqlite.DatabaseSync(targetPath);
  try {
    // Keep the staged database self-contained; no raw WAL/SHM is archived.
    if (target.prepare('PRAGMA journal_mode = DELETE').get().journal_mode !== 'delete') throw new Error('snapshot: cannot make a self-contained SQLite snapshot');
    const checks = target.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('snapshot: SQLite snapshot integrity failed; no archive was published');
  } finally { target.close(); }
}

/** Resolve parent aliases even when trailing directories do not exist yet. */
export function canonicalOutputPath(output) {
  const resolved = path.resolve(output);
  let parent = path.dirname(resolved);
  const missing = [];
  while (!fs.existsSync(parent)) {
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('snapshot: output parent is unavailable');
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...missing, path.basename(resolved));
}
