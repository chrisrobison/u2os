import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBDIRS = ['config', 'policies', 'db', 'credentials', 'cache'];

/**
 * Local-first data directory. Default ~/.u2os, overridable via U2OS_HOME.
 * Read fresh (not cached) so tests can point separate temp dirs per test by
 * setting process.env.U2OS_HOME before calling into any store/module here.
 */
export function getDataDir() {
  return process.env.U2OS_HOME || path.join(os.homedir(), '.u2os');
}

export function ensureDataDirs() {
  const dataDir = getDataDir();
  for (const sub of SUBDIRS) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
  return dataDir;
}

export function getDbPath() {
  return path.join(ensureDataDirs(), 'db', 'u2os.sqlite');
}

// Keyed by resolved db file path (not a single module-level singleton) so
// hermetic tests using distinct U2OS_HOME temp dirs never share a connection,
// while normal server operation still reuses one connection per process.
const dbCache = new Map();

export function getDb() {
  const dbPath = getDbPath();
  let db = dbCache.get(dbPath);
  if (db) return db;

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  dbCache.set(dbPath, db);
  return db;
}

export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Test-only helper: close and forget all cached connections. */
export function closeAllForTests() {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbCache.clear();
}
