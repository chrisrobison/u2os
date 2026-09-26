import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getDataDir } from '../db/connection.js';
import { acquireHomeGuard } from '../runtime/home-guard.js';
import { writeRecoveryState, syncDirectory } from './recovery-state.js';
import { readInactiveRecoveryMarker, validateRecoverySchema, readWorkQuarantineCheckpoint } from './recovery-quarantine.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT = 'system.recovery_connectivity_quarantined';
const MAX_FILE = 1024 * 1024, MAX_TOTAL = 64 * MAX_FILE, MAX_FILES = 1000;
const COLUMNS = {
  connection_instances: ['id','status','credential_revision','smtp_instance_id','smtp_pair_initialized','deleted_at','last_error','updated_at'],
  devices: ['id','status','trust','updated_at'],
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
class ConnectivityRefusal extends Error {
  constructor() {
    super('Recovery connectivity review refused or interrupted; preserve the inactive home and its private review files. Complete database-work quarantine first; changed, linked, oversized or unsupported storage requires offline inspection. Activation is not supported');
    this.code = 'RECOVERY_CONNECTIVITY_REFUSED';
  }
}
function refused() { return new ConnectivityRefusal(); }
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function directory(file, create = false) {
  if (!exists(file)) { if (!create) return false; fs.mkdirSync(file, { mode: 0o700 }); syncDirectory(path.dirname(file)); }
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw refused();
  if (create) fs.chmodSync(file, 0o700);
  return true;
}
function fingerprint(file) {
  if (!exists(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE) throw refused();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_FILE || opened.ino !== stat.ino || opened.dev !== stat.dev) throw refused();
    const bytes = fs.readFileSync(fd);
    try { return { size: bytes.length, hash: digest(bytes) }; }
    finally { bytes.fill(0); }
  } finally { fs.closeSync(fd); }
}
const same = (a, b) => a && b && a.size === b.size && a.hash === b.hash;
function allowedFile(name) {
  const ordinary = name.replace(/^(credentials|config)\/\._/, '$1/');
  return ['config/config.json','config/connectors.yaml','credentials/device-connect-token.key'].includes(ordinary) ||
    (name === 'credentials/._master.key') || /^credentials\/[A-Za-z0-9_.-]+\.enc\.json$/.test(ordinary);
}
function activeFiles(home) {
  const files = [];
  if (directory(path.join(home, 'credentials'))) {
    for (const name of fs.readdirSync(path.join(home, 'credentials'))) {
      if (name === 'master.key') { fingerprint(path.join(home, 'credentials', name)); continue; }
      const relative = `credentials/${name}`;
      if (!allowedFile(relative)) throw refused();
      files.push({ name: relative, ...fingerprint(path.join(home, relative)) });
      if (files.length > MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL) throw refused();
    }
  }
  if (!directory(path.join(home, 'config'))) throw refused();
  for (const name of ['config/config.json','config/connectors.yaml','config/._config.json','config/._connectors.yaml']) {
    const info = fingerprint(path.join(home, name)); if (info) files.push({ name, ...info });
  }
  if (files.length > MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL) throw refused();
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
function databaseState(db) {
  if (db.prepare(`SELECT count(*) n FROM connection_instances WHERE deleted_at IS NULL AND
    (typeof(id) != 'text' OR length(id) > 512 OR typeof(status) != 'text' OR length(status) > 64 OR
     (smtp_instance_id IS NOT NULL AND (typeof(smtp_instance_id) != 'text' OR length(smtp_instance_id) > 512)))`).get().n ||
      db.prepare("SELECT count(*) n FROM devices WHERE typeof(id) != 'text' OR length(id) > 512 OR typeof(status) != 'text' OR length(status) > 64 OR typeof(trust) != 'text' OR length(trust) > 64").get().n) throw refused();
  const accounts = db.prepare('SELECT id,status,credential_revision,smtp_instance_id,smtp_pair_initialized FROM connection_instances WHERE deleted_at IS NULL ORDER BY id LIMIT 10001').all();
  const devices = db.prepare('SELECT id,status,trust FROM devices ORDER BY id LIMIT 10001').all();
  if (accounts.length > 10000 || devices.length > 10000 || accounts.some((row) => !Number.isSafeInteger(row.credential_revision) || row.credential_revision < 0 || row.credential_revision >= Number.MAX_SAFE_INTEGER)) throw refused();
  const after = { accounts: accounts.map((row) => ({ ...row, status: 'disconnected', credential_revision: row.credential_revision + 1, smtp_instance_id: null, smtp_pair_initialized: 1 })), devices: devices.map((row) => ({ ...row, status: 'offline', trust: 'revoked' })) };
  return { hash: digest(JSON.stringify({ accounts, devices })), afterHash: digest(JSON.stringify(after)), accounts: accounts.length, devices: devices.length };
}
function privateDirectory(home, marker, create) {
  const root = path.join(home, 'recovery-review');
  const recovery = path.join(root, marker.recoveryId);
  const target = path.join(recovery, marker.connectivityPreparation.id);
  for (const dir of [root, recovery, target]) if (!directory(dir, create)) throw refused();
  return target;
}
function publishInventory(dir, inventory) {
  const staging = fs.mkdtempSync(path.join(dir, '.inventory-stage-'));
  try {
    const file = path.join(staging, 'inventory.json'), fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(inventory)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const target = path.join(dir, 'inventory.json');
    if (exists(target)) throw refused();
    // Ownership is held, and there is no async gap between no-clobber check
    // and rename. A process interruption leaves a single-link complete file.
    fs.renameSync(file, target); syncDirectory(dir);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
function readInventory(dir, marker) {
  const file = path.join(dir, 'inventory.json'); fingerprint(file);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.version !== 1 || value.id !== marker.connectivityPreparation.id || value.recoveryId !== marker.recoveryId ||
      !UUID.test(value.id) || !UUID.test(value.recoveryId) || !Array.isArray(value.files) || value.files.length > MAX_FILES ||
      Object.keys(value).some((key) => !['version','id','recoveryId','createdAt','files','master','beforeHash','afterHash','counts'].includes(key)) ||
      !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
      !/^[0-9a-f]{64}$/.test(value.beforeHash) || !/^[0-9a-f]{64}$/.test(value.afterHash)) throw refused();
  const names = new Set();
  for (const entry of value.files) {
    if (!entry || !allowedFile(entry.name) || names.has(entry.name) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE || !/^[0-9a-f]{64}$/.test(entry.hash) || Object.keys(entry).some((key) => !['name','size','hash'].includes(key))) throw refused();
    names.add(entry.name);
  }
  if (value.files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL || !value.counts ||
      Object.keys(value.counts).length !== 4 || ['accounts','devices','credentialFiles','runtimeConfigurationFiles'].some((key) => !Number.isSafeInteger(value.counts[key]) || value.counts[key] < 0) || value.counts.accounts > 10000 || value.counts.devices > 10000 ||
      value.counts.credentialFiles !== value.files.filter((file) => file.name.startsWith('credentials/')).length ||
      value.counts.runtimeConfigurationFiles !== value.files.filter((file) => file.name.startsWith('config/')).length ||
      (value.master !== null && (!value.master || value.master.size !== 32 || !/^[0-9a-f]{64}$/.test(value.master.hash) || Object.keys(value.master).some((key) => !['size','hash'].includes(key))))) throw refused();
  return value;
}
function checkFiles(home, dir, inventory) {
  const current = activeFiles(home);
  if (current.some((entry) => !inventory.files.some((file) => file.name === entry.name && same(entry, file)))) throw refused();
  const master = fingerprint(path.join(home, 'credentials', 'master.key'));
  if (master ? !same(master, inventory.master) : inventory.master !== null) throw refused();
  for (const entry of inventory.files) {
    const source = fingerprint(path.join(home, entry.name));
    const destinationDirectory = path.join(dir, path.dirname(entry.name));
    if (exists(destinationDirectory)) directory(destinationDirectory);
    const held = fingerprint(path.join(dir, entry.name));
    if ((!source && !held) || (source && !same(source, entry)) || (held && !same(held, entry))) throw refused();
  }
}

/** No decryption, providers, models or application migrations. Files remain
 * available privately for inspection; every exit leaves execution inactive. */
export function reviewRecoveryConnectivity({ dataDir = getDataDir(), apply = false } = {}) {
  if (typeof apply !== 'boolean') throw refused();
  let home; try { home = fs.realpathSync(path.resolve(dataDir)); } catch { throw refused(); }
  const guard = acquireHomeGuard(home); let db;
  try {
    let marker = readInactiveRecoveryMarker(home);
    const database = path.join(home, 'db', 'u2os.sqlite');
    if (!directory(path.dirname(database))) throw refused();
    const stat = fs.lstatSync(database); if (!stat.isFile() || stat.nlink !== 1) throw refused();
    db = new DatabaseSync(database, { readOnly: !apply }); db.exec('PRAGMA trusted_schema = OFF;');
    validateRecoverySchema(db, COLUMNS);
    const work = readWorkQuarantineCheckpoint(db, marker);
    if (!work || marker.workQuarantine?.id !== work.id || !UUID.test(marker.recoveryId)) throw refused();
    const state = databaseState(db), files = activeFiles(home);
    const master = fingerprint(path.join(home, 'credentials', 'master.key'));
    if (master && master.size !== 32) throw refused();
    if (!master && files.some((file) => file.name.endsWith('.enc.json'))) throw refused();
    const summary = { accounts: state.accounts, devices: state.devices, credentialFiles: files.filter((file) => file.name.startsWith('credentials/')).length, runtimeConfigurationFiles: files.filter((file) => file.name.startsWith('config/')).length };
    if (!marker.connectivityPreparation && !apply) return { inactive: true, alreadyApplied: false, inProgress: false, counts: summary };
    if (marker.connectivityPreparation && (!UUID.test(marker.connectivityPreparation.id) || Object.keys(marker.connectivityPreparation).some((key) => key !== 'id'))) throw refused();
    if (!marker.connectivityPreparation) {
      marker = { ...marker, connectivityPreparation: { id: randomUUID() } };
      const reviewRoot = path.join(home, 'recovery-review'), recoveryRoot = path.join(reviewRoot, marker.recoveryId);
      for (const parent of [reviewRoot, recoveryRoot]) if (exists(parent)) directory(parent);
      if (exists(path.join(recoveryRoot, marker.connectivityPreparation.id))) throw refused();
      writeRecoveryState(home, marker);
    }
    const dir = privateDirectory(home, marker, apply);
    if (!exists(path.join(dir, 'inventory.json'))) {
      if (!apply || marker.connectivityQuarantine || fs.readdirSync(dir).some((name) => !/^\.inventory-stage-[A-Za-z0-9]+$/.test(name))) throw refused();
      publishInventory(dir, { version: 1, id: marker.connectivityPreparation.id, recoveryId: marker.recoveryId, createdAt: new Date().toISOString(), files, master, beforeHash: state.hash, afterHash: state.afterHash, counts: summary });
    }
    const inventory = readInventory(dir, marker); checkFiles(home, dir, inventory);
    const receipt = { version: 1, id: inventory.id, appliedAt: inventory.createdAt, counts: inventory.counts, scope: 'connectivity-only' };
    const prior = db.prepare('SELECT CASE WHEN length(data) <= 65536 THEN data ELSE NULL END data FROM events WHERE type = ? AND source = ? AND subject_id = ? LIMIT 2').all(EVENT, 'system:recovery', marker.recoveryId);
    if (prior.length > 1 || (prior.length && prior[0].data !== JSON.stringify(receipt)) || (!prior.length && marker.connectivityQuarantine)) throw refused();
    if (prior.length) {
      if (files.length || state.hash !== inventory.afterHash) throw refused();
      if (apply && marker.connectivityQuarantine?.id !== receipt.id) writeRecoveryState(home, { ...marker, connectivityQuarantine: receipt });
      return { inactive: true, alreadyApplied: true, inProgress: false, counts: inventory.counts };
    }
    if (state.hash !== inventory.beforeHash) throw refused();
    if (!apply) return { inactive: true, alreadyApplied: false, inProgress: true, counts: inventory.counts };
    for (const entry of inventory.files) {
      const source = path.join(home, entry.name), held = path.join(dir, entry.name);
      directory(path.dirname(held), true);
      if (!exists(held)) {
        const staging = fs.mkdtempSync(path.join(path.dirname(held), '.copy-stage-'));
        try {
          const copied = path.join(staging, 'payload');
          fs.copyFileSync(source, copied, fs.constants.COPYFILE_EXCL); fs.chmodSync(copied, 0o600);
          const fd = fs.openSync(copied, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          if (!same(fingerprint(copied), entry)) throw refused();
          if (exists(held)) throw refused();
          fs.renameSync(copied, held); syncDirectory(path.dirname(held));
        } finally { fs.rmSync(staging, { recursive: true, force: true }); }
      }
      if (!same(fingerprint(held), entry)) throw refused();
      if (exists(source)) {
        if (!same(fingerprint(source), entry)) throw refused();
        fs.unlinkSync(source); syncDirectory(path.dirname(source));
      }
    }
    checkFiles(home, dir, inventory);
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (databaseState(db).hash !== inventory.beforeHash || readWorkQuarantineCheckpoint(db, marker)?.id !== work.id) throw refused();
      db.prepare("UPDATE connection_instances SET status = 'disconnected', credential_revision = credential_revision + 1, smtp_instance_id = NULL, smtp_pair_initialized = 1, last_error = 'Archived connection requires fresh owner configuration after recovery', updated_at = ? WHERE deleted_at IS NULL").run(receipt.appliedAt);
      db.prepare("UPDATE devices SET status = 'offline', trust = 'revoked', updated_at = ?").run(receipt.appliedAt);
      if (databaseState(db).hash !== inventory.afterHash) throw refused();
      db.prepare(`INSERT INTO events (id,type,timestamp,source,actor_type,actor_id,subject_type,subject_id,data,metadata,created_at)
        VALUES (?,?,?,'system:recovery','system','recovery','recovery',?,?,'{"classification":"private"}',?)`)
        .run(`recovery_connectivity_${receipt.id}`, EVENT, receipt.appliedAt, marker.recoveryId, JSON.stringify(receipt), receipt.appliedAt);
      db.exec('COMMIT;');
    } catch { db.exec('ROLLBACK;'); throw refused(); }
    writeRecoveryState(home, { ...marker, connectivityQuarantine: receipt });
    return { inactive: true, alreadyApplied: false, inProgress: false, counts: inventory.counts };
  } catch (error) { if (error instanceof ConnectivityRefusal) throw error; throw refused(); }
  finally { db?.close(); guard.release(); }
}
