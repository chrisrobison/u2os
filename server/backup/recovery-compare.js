import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as sqlite from 'node:sqlite';
import { getDataDir } from '../db/connection.js';
import { acquireHomeGuard } from '../runtime/home-guard.js';
import { readInstallationIdentity, readInstallationMode } from '../seed/installation-mode.js';
import { assertExecutableHome } from './recovery-state.js';
import { readInactiveRecoveryMarker, validateRecoverySchema, readWorkQuarantineCheckpoint } from './recovery-quarantine.js';
import { readConnectivityQuarantineCheckpoint } from './recovery-connectivity.js';

const LIMIT_BYTES = 4 * 1024 ** 3, LIMIT_ROWS = 100000;
const COLUMNS = {
  agent_actions: ['id','status'],
  action_attempts: ['id','queue_id','status','started_at','finished_at'],
  agent_runs: ['id','model_call_count','metered_model_calls','input_tokens','output_tokens','goal_id'],
  goals: ['id','owner_id','objective','completion_criteria','constraints','permitted_scope','budgets','status'],
  owners: ['id','entity_id','passphrase_hash','salt','scrypt_params'], entities: ['id'],
  connection_instances: ['id','status','credential_revision','smtp_instance_id','smtp_pair_initialized','deleted_at','last_error','updated_at'],
  devices: ['id','status','trust','updated_at'],
};
function refused() { const error = new Error('Recovery comparison refused: select distinct existing matching personal homes, stop both runtimes, and complete verified work/connectivity quarantine. Unknown identity, unsupported or changed storage requires offline review; no activation is authorized'); error.code = 'RECOVERY_COMPARISON_REFUSED'; return error; }
function existingHome(value) {
  if (typeof value !== 'string' || !value.trim()) throw refused();
  const home = fs.realpathSync(path.resolve(value));
  if (home === path.parse(home).root || !fs.lstatSync(home).isDirectory()) throw refused();
  return home;
}
function databaseFile(home) {
  const dir = path.join(home, 'db'), file = path.join(dir, 'u2os.sqlite');
  if (!fs.lstatSync(dir).isDirectory()) throw refused();
  let total = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    let stat; try { stat = fs.lstatSync(`${file}${suffix}`); } catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.nlink !== 1) throw refused(); total += stat.size;
  }
  if (total > LIMIT_BYTES) throw refused(); return file;
}
function policyFingerprint(home, name) {
  const dir = path.join(home, 'policies');
  let stat; try { stat = fs.lstatSync(dir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isDirectory()) throw refused();
  const file = path.join(dir, name);
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw refused();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const current = fs.fstatSync(fd); if (current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1 || current.size > 1024 * 1024) throw refused(); return createHash('sha256').update(fs.readFileSync(fd)).digest('hex'); }
  finally { fs.closeSync(fd); }
}
function boundedSchema(db) {
  validateRecoverySchema(db, COLUMNS);
  for (const table of ['agent_actions','action_attempts','agent_runs','goals','owners']) {
    if (db.prepare(`SELECT count(*) n FROM ${table}`).get().n > LIMIT_ROWS) throw refused();
  }
  const badUsage = ['model_call_count','metered_model_calls','input_tokens','output_tokens'].map((field) => `(typeof(${field}) != 'integer' OR ${field} < 0 OR ${field} > 9007199254740991)`).join(' OR ');
  if (db.prepare(`SELECT count(*) n FROM agent_runs WHERE ${badUsage} OR metered_model_calls > model_call_count`).get().n) throw refused();
  const badOwner = ['id','entity_id','passphrase_hash','salt','scrypt_params'].map((field) => `(typeof(${field}) != 'text' OR length(${field}) > ${['id','entity_id'].includes(field) ? 512 : 16384})`).join(' OR ');
  if (db.prepare(`SELECT count(*) n FROM owners WHERE ${badOwner}`).get().n) throw refused();
}
function owner(db) {
  const rows = db.prepare('SELECT id,entity_id FROM owners LIMIT 2').all();
  if (rows.length !== 1 || typeof rows[0].id !== 'string' || rows[0].id.length > 512 || typeof rows[0].entity_id !== 'string' || rows[0].entity_id.length > 512 ||
      !db.prepare('SELECT 1 FROM entities WHERE id=?').get(rows[0].entity_id)) throw refused();
  return rows[0];
}
function metrics(db) {
  const count = (sql) => db.prepare(sql).get().n;
  const actions = {
    originalOnly: count('SELECT count(*) n FROM agent_actions a LEFT JOIN recovered.agent_actions r ON r.id=a.id WHERE r.id IS NULL'),
    recordedCompletionsBeyondSnapshot: count("SELECT count(*) n FROM agent_actions a JOIN recovered.agent_actions r ON r.id=a.id WHERE a.status='executed' AND r.status IS NOT 'executed'"),
    newOrChangedAttemptEvidence: count('SELECT count(*) n FROM action_attempts a LEFT JOIN recovered.action_attempts r ON r.id=a.id WHERE r.id IS NULL OR a.status IS NOT r.status OR a.started_at IS NOT r.started_at OR a.finished_at IS NOT r.finished_at'),
    originalInFlightAttempts: count("SELECT count(*) n FROM action_attempts WHERE status='executing'"),
  };
  const runs = { originalOnly: count('SELECT count(*) n FROM agent_runs a LEFT JOIN recovered.agent_runs r ON r.id=a.id WHERE r.id IS NULL') };
  const additional = (field) => count(`SELECT COALESCE(sum(CASE WHEN r.id IS NULL THEN a.${field} ELSE max(a.${field}-r.${field},0) END),0) n FROM agent_runs a LEFT JOIN recovered.agent_runs r ON r.id=a.id`);
  const resources = {
    modelCallsBeyondSnapshot: additional('model_call_count'), recordedInputTokensBeyondSnapshot: additional('input_tokens'), recordedOutputTokensBeyondSnapshot: additional('output_tokens'),
    originalRunsWithUnmeteredCalls: count('SELECT count(*) n FROM agent_runs WHERE model_call_count > metered_model_calls'), monetaryCostAvailable: false,
    matchingRunsWithRegressedCounters: count('SELECT count(*) n FROM agent_runs a JOIN recovered.agent_runs r ON r.id=a.id WHERE a.model_call_count<r.model_call_count OR a.metered_model_calls<r.metered_model_calls OR a.input_tokens<r.input_tokens OR a.output_tokens<r.output_tokens'),
  };
  const goals = {
    originalOnly: count('SELECT count(*) n FROM goals a LEFT JOIN recovered.goals r ON r.id=a.id WHERE r.id IS NULL'),
    missingFromOriginal: count('SELECT count(*) n FROM recovered.goals r LEFT JOIN goals a ON r.id=a.id WHERE a.id IS NULL'),
    changedScopeOrBudget: count('SELECT count(*) n FROM goals a JOIN recovered.goals r ON r.id=a.id WHERE a.owner_id IS NOT r.owner_id OR a.objective IS NOT r.objective OR a.completion_criteria IS NOT r.completion_criteria OR a.constraints IS NOT r.constraints OR a.permitted_scope IS NOT r.permitted_scope OR a.budgets IS NOT r.budgets'),
    originalCancellationsBeyondSnapshot: count("SELECT count(*) n FROM goals a JOIN recovered.goals r ON r.id=a.id WHERE a.status='cancelled' AND r.status IS NOT 'cancelled'"),
  };
  for (const group of [actions,runs,resources,goals]) for (const value of Object.values(group)) if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw refused();
  return { actions, runs, resources, goals };
}

/** A comparison of recorded local evidence, not delivery verification or
 * permission. Both owners remain held through the consistent private copy. */
export async function compareRecoveryEvidence({ dataDir = getDataDir(), originalDataDir } = {}) {
  const guards = []; let original, snapshot, recovered, staging;
  try {
    if (typeof sqlite.backup !== 'function') throw refused();
    const home = existingHome(dataDir), source = existingHome(originalDataDir);
    if (home === source || home.startsWith(`${source}${path.sep}`) || source.startsWith(`${home}${path.sep}`) ||
        !readInstallationIdentity(home) || readInstallationIdentity(home) !== readInstallationIdentity(source)) throw refused();
    for (const dir of [home,source].sort()) guards.push(acquireHomeGuard(dir));
    const marker = readInactiveRecoveryMarker(home);
    assertExecutableHome(source);
    if (readInstallationMode(home) !== 'personal' || readInstallationMode(source) !== 'personal' || marker.installationId !== readInstallationIdentity(source)) throw refused();
    const targetFile = databaseFile(home), sourceFile = databaseFile(source);
    const policies = { authorizationChanged: policyFingerprint(home, 'policies.yaml') !== policyFingerprint(source, 'policies.yaml'), dataProcessingChanged: policyFingerprint(home, 'data-processing.yaml') !== policyFingerprint(source, 'data-processing.yaml') };
    recovered = new sqlite.DatabaseSync(targetFile, { readOnly: true }); recovered.exec('PRAGMA trusted_schema=OFF;'); boundedSchema(recovered);
    const work = readWorkQuarantineCheckpoint(recovered, marker);
    if (!work || marker.workQuarantine?.id !== work.id) throw refused();
    readConnectivityQuarantineCheckpoint(home, recovered, marker);
    const restoredOwner = owner(recovered);
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-recovery-compare-')); fs.chmodSync(staging, 0o700);
    const stagedFile = path.join(staging, 'original.sqlite');
    original = new sqlite.DatabaseSync(sourceFile, { readOnly: true }); original.exec('PRAGMA trusted_schema=OFF;');
    await sqlite.backup(original, stagedFile); original.close(); original = null; fs.chmodSync(stagedFile, 0o600);
    snapshot = new sqlite.DatabaseSync(stagedFile); snapshot.exec('PRAGMA trusted_schema=OFF;');
    if (snapshot.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') throw refused();
    boundedSchema(snapshot); const currentOwner = owner(snapshot);
    if (currentOwner.id !== restoredOwner.id || currentOwner.entity_id !== restoredOwner.entity_id) throw refused();
    snapshot.exec('PRAGMA query_only=ON;'); snapshot.prepare('ATTACH DATABASE ? AS recovered').run(targetFile);
    const ownerAuthenticationChanged = !!snapshot.prepare(`SELECT count(*) n FROM owners a JOIN recovered.owners r ON r.id=a.id
      WHERE a.passphrase_hash IS NOT r.passphrase_hash OR a.salt IS NOT r.salt OR a.scrypt_params IS NOT r.scrypt_params`).get().n;
    return { inactive: true, executionAuthorized: false, originalRetired: false, providerOutcomesVerified: false, resourceLedgerReconciled: false, comparedAt: new Date().toISOString(), installationMatched: true, ownerEntityMatched: true,
      ownerAuthenticationChanged, policies, ...metrics(snapshot) };
  } catch { throw refused(); }
  finally { try { snapshot?.close(); recovered?.close(); original?.close(); } finally { try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); } finally { for (const guard of guards.reverse()) guard.release(); } } }
}
