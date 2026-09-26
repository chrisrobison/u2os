// Local process ownership, separate from application SQLite transactions.
// SQLite's OS-backed exclusive lock has no lease expiry or PID-stealing race.
// Never unlink this file: replacing its inode could create two lock domains.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const GUARD_FILE = '.runtime-lock.sqlite';
const owners = new Map();

export function canonicalDataHome(dataDir) {
  const resolved = path.resolve(dataDir);
  if (resolved === path.parse(resolved).root) throw new Error('A filesystem root cannot be a runtime data home');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return fs.realpathSync(resolved);
}

function unavailable(inUse = false) {
  const error = new Error(inUse
    ? 'This data home is already in use; stop the other runtime and wait for shutdown before restarting'
    : 'Runtime ownership unavailable; check local guard permissions and stop other runtimes. Do not delete a lock to bypass running work');
  error.code = inUse ? 'HOME_IN_USE' : 'HOME_GUARD_UNAVAILABLE';
  return error;
}

/** Same-process restart may await an already-closing runtime. Active/startup
 * owners are never waited out or stolen. Other processes fail immediately. */
export async function waitForClosingRuntime(home) {
  const existing = owners.get(home);
  if (existing?.closing) await existing.closing;
}

export function acquireHomeGuard(home) {
  home = canonicalDataHome(home);
  if (owners.has(home)) throw unavailable(true);
  const file = path.join(home, GUARD_FILE);
  let db;
  try {
    let created = false;
    try {
      const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); created = true;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw unavailable();
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 0;');
    if (created || stat.size === 0) {
      // Recover a reserved empty file left between creation and SQLite setup.
      // Exclusive atomic initialization also handles two first-start contenders.
      db.exec(`BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS u2os_runtime_guard (version INTEGER NOT NULL);
        INSERT INTO u2os_runtime_guard SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM u2os_runtime_guard);
        COMMIT;`);
    }
    {
      const objects = db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
      if (objects.length !== 1 || objects[0].name !== 'u2os_runtime_guard' || objects[0].type !== 'table') throw unavailable();
      const columns = db.prepare('PRAGMA table_info(u2os_runtime_guard)').all();
      if (columns.length !== 1 || columns[0].name !== 'version' || columns[0].type !== 'INTEGER' || columns[0].notnull !== 1) throw unavailable();
      const rows = db.prepare('SELECT version FROM u2os_runtime_guard LIMIT 2').all();
      if (rows.length !== 1 || rows[0].version !== 1) throw unavailable();
    }
    db.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
  } catch (error) {
    try { db?.close(); } catch { /* no ownership was returned */ }
    throw unavailable(error.errcode === 5 || error.errcode === 6);
  }
  const owner = { closing: null };
  owners.set(home, owner);
  let released = false;
  return {
    markClosing(promise) { owner.closing = promise; },
    release() {
      if (released) return;
      db.close(); // Rolls back the empty transaction and releases the OS lock.
      released = true;
      if (owners.get(home) === owner) owners.delete(home);
    },
  };
}

/** Ignore only the current bootstrap's owned guard artifacts when deciding
 * whether an otherwise empty home may explicitly initialize as demo. */
export function isOwnedGuardArtifact(dataDir, name) {
  if (![GUARD_FILE, `${GUARD_FILE}-journal`].includes(name)) return false;
  try { return owners.has(fs.realpathSync(path.resolve(dataDir))); }
  catch { return false; }
}
