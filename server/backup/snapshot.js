#!/usr/bin/env node
// Coordinated offline snapshots and legacy tar restore of U2OS_HOME.
//
// IMPLEMENTATION CHOICE (tar vs. a custom archive format): this shells out
// to the system `tar` binary via node:child_process rather than
// reimplementing a tar (or ad-hoc) archive writer in pure JS, and rather
// than adding an npm tar dependency. Reasons:
//   - Node's stdlib has no tar writer (only node:zlib for the gzip layer).
//   - docs/deployment.md explicitly asks NOT to add a tar npm dependency
//     for this ("Node has no built-in tar writer... do NOT add a tar npm
//     dependency for this").
//   - `tar` ships by default on both documented deployment targets
//     (macOS and Linux -- see docs/deployment.md's "what this phase
//     deliberately does not do": Windows Service packaging is future
//     work, so Windows' lack of a bundled `tar` is out of scope here).
//   - Creation archives private staged regular files only, not the live
//     directory. Source links/special files are rejected; SQLite is captured
//     through its backup API and runtime locks/sidecars are excluded.
//
// SECURITY: plaintext payloads include credentials AND their master key.
// Opt-in authenticated encryption protects that payload with an independent
// secret kept outside the archive; legacy plaintext output remains explicitly
// UNENCRYPTED. All staging remains private, including before authentication.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getDataDir } from '../db/connection.js';
import { canonicalDataHome } from '../runtime/home-guard.js';
import { withOfflineHome } from '../runtime/offline-home.js';
import { canonicalOutputPath, stageSnapshot } from './stage.js';
import { archiveFormat, encryptArchive, decryptArchive, validateBackupPassphrase } from './encryption.js';
import { readBackupPassphrase } from './passphrase.js';

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function tarOptions(stdio = 'inherit') {
  const env = { ...process.env };
  delete env.U2OS_BACKUP_PASSPHRASE;
  return { stdio, env };
}

function assertTarAvailable() {
  try {
    execFileSync('tar', ['--version'], tarOptions('ignore'));
  } catch {
    throw new Error(
      'snapshot: the system "tar" binary is required for backup/restore but was not found on PATH. ' +
        'tar ships by default on macOS and Linux, the documented U2OS deployment targets.'
    );
  }
}

/**
 * Creates a timestamped .tar.gz (or authenticated .tar.gz.enc) of an
 * exclusively owned offline home. A supplied passphrase implies encryption.
 * SQLite and related regular files are staged and checked before atomic,
 * no-clobber publication. Returns the resolved requested output path.
 */
export async function createBackup({ dataDir = getDataDir(), outputPath, encrypted = false, passphrase } = {}) {
  assertTarAvailable();
  const useEncryption = encrypted || passphrase !== undefined;
  if (useEncryption) validateBackupPassphrase(passphrase);

  if (!fs.existsSync(dataDir)) {
    throw new Error(`snapshot: U2OS_HOME "${dataDir}" does not exist -- nothing to back up.`);
  }

  const home = canonicalDataHome(dataDir);
  return withOfflineHome(async () => {
    const requestedOutputPath = path.resolve(outputPath || `u2os-backup-${timestampForFilename()}.tar.gz${useEncryption ? '.enc' : ''}`);
    const resolvedOutputPath = canonicalOutputPath(requestedOutputPath);
    if (resolvedOutputPath === home || resolvedOutputPath.startsWith(`${home}${path.sep}`)) {
      throw new Error('snapshot: backup output must be outside the source data home');
    }
    if (fs.existsSync(resolvedOutputPath)) throw new Error('snapshot: backup output already exists; choose a new filename');
    const parent = path.dirname(resolvedOutputPath);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, '.u2os-backup-stage-'));
    try {
      fs.chmodSync(staging, 0o700);
      const payload = path.join(staging, 'payload');
      await stageSnapshot(home, payload);
      const archive = path.join(staging, 'snapshot.tar.gz');
      const fd = fs.openSync(archive, 'wx', 0o600); fs.closeSync(fd);
      execFileSync('tar', ['-czf', archive, '-C', payload, '.'], tarOptions());
      fs.chmodSync(archive, 0o600);
      const publishedArchive = useEncryption ? path.join(staging, 'snapshot.tar.gz.enc') : archive;
      if (useEncryption) await encryptArchive(archive, publishedArchive, passphrase);
      const archiveFd = fs.openSync(publishedArchive, 'r');
      try { fs.fsyncSync(archiveFd); } finally { fs.closeSync(archiveFd); }
      // Same-filesystem atomic publication, without replacing a prior archive.
      try { fs.linkSync(publishedArchive, resolvedOutputPath); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('snapshot: backup output already exists; choose a new filename');
        throw error;
      }
      return requestedOutputPath;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }, { dataDir: home });
}

/**
 * Restores a snapshot created by createBackup() back into U2OS_HOME.
 * Refuses to extract into a non-empty target directory unless
 * `force: true` is passed, so a restore can never silently clobber
 * existing live data.
 */
export async function restoreBackup({ archivePath, dataDir = getDataDir(), force = false, encrypted = false, passphrase } = {}) {
  assertTarAvailable();

  const resolvedArchivePath = path.resolve(archivePath);
  if (!fs.existsSync(resolvedArchivePath)) {
    throw new Error(`snapshot: archive "${resolvedArchivePath}" does not exist.`);
  }

  const format = archiveFormat(resolvedArchivePath);
  if (format !== 'encrypted' && (encrypted || passphrase !== undefined || resolvedArchivePath.endsWith('.enc'))) {
    throw new Error('snapshot: expected an encrypted archive; no extraction was attempted');
  }
  if (format === 'plaintext') return extractArchive(resolvedArchivePath, dataDir, force);
  validateBackupPassphrase(passphrase);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-backup-decrypt-'));
  try {
    fs.chmodSync(staging, 0o700);
    const plaintext = path.join(staging, 'authenticated.tar.gz');
    await decryptArchive(resolvedArchivePath, plaintext, passphrase);
    return extractArchive(plaintext, dataDir, force);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function extractArchive(resolvedArchivePath, dataDir, force) {
  const alreadyExists = fs.existsSync(dataDir);
  const isNonEmpty = alreadyExists && fs.readdirSync(dataDir).length > 0;
  if (isNonEmpty && !force) {
    throw new Error(
      `snapshot: refusing to restore into non-empty U2OS_HOME "${dataDir}" without --force. ` +
        'Pass --force to overwrite/merge into the existing directory.'
    );
  }

  fs.mkdirSync(dataDir, { recursive: true });
  execFileSync('tar', ['-xzf', resolvedArchivePath, '-C', dataDir], tarOptions());

  return dataDir;
}

function printUsage() {
  console.log(`U2OS backup/restore -- offline snapshot of U2OS_HOME.

Usage:
  node server/backup/snapshot.js backup [outputPath]
  node server/backup/snapshot.js backup --encrypt [outputPath]
  node server/backup/snapshot.js restore <archivePath> [--encrypt] [--force]

  backup    Requires a stopped runtime and Node.js 22.16 or newer for SQLite.
            Creates a private .tar.gz from a coherent staged U2OS_HOME snapshot.
            Output must be outside the source home and must not already exist.
            Links/special files are refused. Runtime locks and SQLite sidecars
            are excluded; committed WAL data is captured through SQLite backup.
            Includes the data directory regular files
            (config, policies, db, and credentials -- including the
            encrypted secrets AND the master key needed to decrypt them).

              ** WARNING: the resulting archive is exactly as sensitive as
              ** your live U2OS_HOME directory. Store and transmit it
              ** accordingly -- never upload it to a shared/public location.
            --encrypt wraps the tar payload in authenticated encryption.
            Supply an independent backup passphrase through masked terminal
            input (with confirmation) or U2OS_BACKUP_PASSPHRASE, never arguments.
            Without --encrypt creation remains explicitly UNENCRYPTED.

  restore   Extracts an archive created by "backup" back into U2OS_HOME.
            Refuses to run into a non-empty U2OS_HOME unless --force is
            passed, to avoid silently clobbering existing live data.
            Encrypted archives authenticate fully in private staging before
            extraction. --encrypt requires encrypted input; legacy .tar.gz
            remains supported and is labeled UNENCRYPTED. Restore ownership
            and inactive-copy safeguards are still unfinished.

Environment:
  U2OS_HOME   The data directory to back up from / restore into.
              Defaults to ~/.u2os.
  U2OS_BACKUP_PASSPHRASE  Explicit noninteractive backup secret (12+ characters).
              Removed from this CLI environment before spawning children.
              Prefer masked terminal input. No account/owner secret is reused.
`);
}

async function main() {
  const [, , mode, ...rest] = process.argv;

  if (!mode || mode === '--help' || mode === '-h') {
    printUsage();
    process.exit(mode ? 0 : 1);
    return;
  }

  const forceIndex = rest.indexOf('--force');
  const force = forceIndex !== -1;
  if (force) rest.splice(forceIndex, 1);
  const encryptIndex = rest.indexOf('--encrypt');
  const encrypted = encryptIndex !== -1;
  if (encrypted) rest.splice(encryptIndex, 1);
  if (rest.some((arg) => arg.startsWith('--')) || rest.length > 1) {
    throw new Error('snapshot: unsupported arguments; use --help. Never pass a passphrase as an argument');
  }
  const positional = rest.filter((arg) => !arg.startsWith('--'));

  if (mode === 'backup') {
    const passphrase = encrypted ? await readBackupPassphrase({ confirm: true }) : undefined;
    // A supplied environment secret must not reach tar even in plaintext mode.
    delete process.env.U2OS_BACKUP_PASSPHRASE;
    const outputPath = await createBackup({ outputPath: positional[0], encrypted, passphrase });
    console.log(`Backup written to ${outputPath}`);
    console.log(
      `${encrypted ? 'ENCRYPTED archive: keep the independent passphrase outside the archive.' : 'UNENCRYPTED archive: protect it like the live home.'} ` +
      'This archive contains your full U2OS data directory, including encrypted ' +
        'credentials AND the master key needed to decrypt them. Treat it as sensitive as your ' +
        'live data -- store and transmit it accordingly.'
    );
  } else if (mode === 'restore') {
    const archivePath = positional[0];
    if (!archivePath) {
      printUsage();
      process.exit(1);
      return;
    }
    const format = archiveFormat(path.resolve(archivePath));
    const expectsEncryption = encrypted || archivePath.endsWith('.enc') || format === 'encrypted' || process.env.U2OS_BACKUP_PASSPHRASE !== undefined;
    if (expectsEncryption && format !== 'encrypted') throw new Error('snapshot: expected an encrypted archive; no extraction was attempted');
    const passphrase = expectsEncryption ? await readBackupPassphrase() : undefined;
    delete process.env.U2OS_BACKUP_PASSPHRASE;
    if (!expectsEncryption) console.log('UNENCRYPTED legacy archive: no authentication or confidentiality guarantee.');
    const dataDir = await restoreBackup({ archivePath, force, encrypted: expectsEncryption, passphrase });
    console.log(`Restored ${archivePath} into ${dataDir}`);
  } else {
    printUsage();
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
