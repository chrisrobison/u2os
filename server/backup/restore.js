import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { acquireHomeGuard, canonicalDataHome, isOwnedGuardArtifact } from '../runtime/home-guard.js';
import { readArchive } from './archive-reader.js';
import { writeRecoveryState, syncDirectory } from './recovery-state.js';

export function verifyDatabase(home) {
  const file = path.join(home, 'db', 'u2os.sqlite');
  if (!fs.existsSync(file)) return 'absent';
  let db;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error();
    db = new DatabaseSync(file, { readOnly: true });
    if (db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal') throw new Error();
    const checks = db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error();
    return 'ok';
  } catch { throw new Error('snapshot: application SQLite integrity verification failed'); }
  finally { db?.close(); }
}

/** Publication is no-clobber and guarded. The durable incomplete marker
 * precedes every payload write, so interruption cannot enable a partial home. */
export async function restoreValidatedArchive(archive, dataDir, { force = false } = {}) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-restore-stage-'));
  let guard;
  try {
    fs.chmodSync(staging, 0o700);
    const payload = path.join(staging, 'payload');
    const counts = await readArchive(archive, payload);
    const database = verifyDatabase(payload);
    if (force) throw new Error('snapshot: force restore is unsupported; choose an isolated empty recovery home');
    // Before acquiring (and creating) a guard, preserve nonempty destinations.
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) throw new Error('snapshot: refusing to restore into a non-empty home; choose an isolated empty destination');
    const home = canonicalDataHome(dataDir);
    guard = acquireHomeGuard(home);
    if (fs.readdirSync(home).some((name) => !isOwnedGuardArtifact(home, name))) throw new Error('snapshot: refusing to restore into a non-empty home; choose an isolated empty destination');
    fs.chmodSync(home, 0o700);
    const state = { status: 'incomplete', restoredAt: new Date().toISOString(), database, ...counts };
    writeRecoveryState(home, state, { initial: true });
    function publish(source, destination) {
      for (const name of fs.readdirSync(source)) {
        const from = path.join(source, name), to = path.join(destination, name);
        if (fs.lstatSync(from).isDirectory()) {
          fs.mkdirSync(to, { mode: 0o700 }); publish(from, to);
        } else {
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600);
          const fd = fs.openSync(to, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      }
      syncDirectory(destination);
    }
    try {
      publish(payload, home);
      verifyDatabase(home);
      writeRecoveryState(home, { ...state, status: 'inactive', verifiedAt: new Date().toISOString() });
    } catch { throw new Error('snapshot: recovery publication incomplete; home remains inactive. Preserve it for offline review; no automatic retry or activation'); }
    return dataDir;
  } finally { guard?.release(); fs.rmSync(staging, { recursive: true, force: true }); }
}
