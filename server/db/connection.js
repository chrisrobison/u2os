import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// SECURITY: 'credentials' is deliberately excluded here. It must never be
// created with this loop's default (umask-dependent, often 0755)
// permissions even momentarily -- server/security/vault.js owns creating it
// itself, always explicitly at 0700, via ensureCredentialsDir() (called from
// generateOrLoadMasterKey()/writeEncryptedFile()). server/index.js calls
// generateOrLoadMasterKey() during startup specifically so that directory
// exists at the correct permissions from the very first boot, not lazily
// whenever the owner happens to save their first real credential.
const SUBDIRS = ['config', 'policies', 'db', 'cache'];

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

  // Additive-only migration, run BEFORE schema.sql executes: Phase 7 added
  // emails.correlation_id (see docs/feedback.md's email-edit-detection) to a
  // table that already shipped in earlier phases. schema.sql's own
  // `CREATE TABLE IF NOT EXISTS emails` is a no-op against an existing
  // database, so it can never add a column to an already-existing table --
  // and schema.sql's `CREATE INDEX ... ON emails(correlation_id)` would
  // fail outright against a pre-Phase-7 emails table that lacks the column.
  // Ensuring the column exists first keeps schema.sql itself pure
  // idempotent DDL for every table, old and new alike.
  ensureColumn(db, 'emails', 'correlation_id', 'TEXT');
  ensureColumn(db, 'agent_actions', 'rejected_by', 'TEXT');
  ensureColumn(db, 'agent_actions', 'rejected_at', 'TEXT');
  // Data-processing privacy policy (PLAN.md Phase 6): every fact gets a
  // classification (public/personal/private/sensitive) used to decide
  // whether it may reach a remote model provider, separate from tool
  // authorization. Existing rows default to 'personal' -- the same default
  // recordFact() itself uses for a fact with no classification specified --
  // so nothing that was already in memory becomes accidentally MORE
  // restricted OR less restricted than it would have been if classified at
  // write time.
  ensureColumn(db, 'facts', 'classification', "TEXT NOT NULL DEFAULT 'personal'");
  ensureColumn(db, 'facts', 'status', "TEXT NOT NULL DEFAULT 'current'");
  ensureColumn(db, 'facts', 'supersedes_fact_id', 'TEXT');
  ensureColumn(db, 'facts', 'deleted_at', 'TEXT');
  // Data-processing privacy policy, extended to the rest of the memory/
  // context surface (issue #2, part of #1): `facts` was the only table
  // carrying a classification column; entities, relationships,
  // calendar_events, emails, and tasks had none, leaving nothing
  // deterministic for a privacy filter to key off of for those types. Same
  // column, same safe default, same rationale as facts.classification
  // above. NOTE: calendar_events already has an unrelated `category` column
  // (business/interviews/personal) consumed by the policy engine for
  // calendar.reschedule autonomy decisions -- that is a different axis from
  // this data-processing classification and must never be conflated with
  // it, so `classification` is added here as a distinct additional column.
  ensureColumn(db, 'entities', 'classification', "TEXT NOT NULL DEFAULT 'personal'");
  ensureColumn(db, 'relationships', 'classification', "TEXT NOT NULL DEFAULT 'personal'");
  ensureColumn(db, 'entities', 'deleted_at', 'TEXT');
  ensureColumn(db, 'relationships', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'relationships', 'deleted_at', 'TEXT');
  ensureColumn(db, 'calendar_events', 'classification', "TEXT NOT NULL DEFAULT 'personal'");
  ensureColumn(db, 'emails', 'classification', "TEXT NOT NULL DEFAULT 'personal'");
  ensureColumn(db, 'tasks', 'classification', "TEXT NOT NULL DEFAULT 'personal'");
  // Explainability (PLAN.md Phase 9): which retrieved memory items
  // (facts/entities/relationships/events, by id) actually informed a given
  // proposed action's plan -- i.e. ContextAssembler's provenanceRefs, AFTER
  // the data-processing privacy filter, for the specific request that
  // produced this row. Nullable: not every agent_actions row comes from a
  // model plan (e.g. a direct evaluateAndMaybeExecute() call from a
  // non-chat route, or a proactive evaluator, may have none).
  ensureColumn(db, 'agent_actions', 'context_provenance', 'TEXT');
  ensureColumn(db, 'agent_actions', 'account_binding', 'TEXT');
  ensureColumn(db, 'agent_runs', 'model_call_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'owners', 'entity_id', 'TEXT REFERENCES entities(id)');
  // Durable action delivery initially shipped without persisted actor
  // provenance. Add it without rebuilding existing queue tables.
  ensureColumn(db, 'action_queue', 'actor', 'TEXT');
  ensureColumn(db, 'connection_instances', 'credential_revision', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'connection_instances', 'smtp_instance_id', 'TEXT');
  ensureColumn(db, 'connection_instances', 'smtp_pair_initialized', 'INTEGER NOT NULL DEFAULT 0');
  // Durable trigger scheduling: older installations have persisted due
  // times but no execution ownership. Additive leases allow atomic claims
  // and expired-worker recovery without rebuilding or discarding triggers.
  ensureColumn(db, 'triggers', 'lease_owner', 'TEXT');
  ensureColumn(db, 'triggers', 'lease_expires_at', 'TEXT');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  dbCache.set(dbPath, db);
  return db;
}

function ensureColumn(db, table, column, type) {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  // Table doesn't exist yet -- schema.sql (executed right after this
  // function returns) will create it from scratch with the column already
  // in place, so there is nothing to migrate.
  if (!tableExists) return;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
