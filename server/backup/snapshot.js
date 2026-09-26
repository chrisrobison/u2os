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
// SECURITY: the resulting .tar.gz contains U2OS_HOME in full, including
// credentials/*.enc.json AND the master key that decrypts them (a backup
// that can't decrypt its own credentials on restore isn't useful). The
// archive is therefore exactly as sensitive as the live data directory --
// store and transmit it accordingly. This is documented here and in the
// CLI's own usage text below.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDataDir } from '../db/connection.js';
import { canonicalDataHome } from '../runtime/home-guard.js';
import { withOfflineHome } from '../runtime/offline-home.js';
import { canonicalOutputPath, stageSnapshot } from './stage.js';

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function assertTarAvailable() {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'snapshot: the system "tar" binary is required for backup/restore but was not found on PATH. ' +
        'tar ships by default on macOS and Linux, the documented U2OS deployment targets.'
    );
  }
}

/**
 * Creates a timestamped .tar.gz of an exclusively owned offline home.
 * SQLite and related regular files are staged and checked before atomic,
 * no-clobber publication. Returns the resolved requested output path.
 */
export async function createBackup({ dataDir = getDataDir(), outputPath } = {}) {
  assertTarAvailable();

  if (!fs.existsSync(dataDir)) {
    throw new Error(`snapshot: U2OS_HOME "${dataDir}" does not exist -- nothing to back up.`);
  }

  const home = canonicalDataHome(dataDir);
  return withOfflineHome(async () => {
    const requestedOutputPath = path.resolve(outputPath || `u2os-backup-${timestampForFilename()}.tar.gz`);
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
      execFileSync('tar', ['-czf', archive, '-C', payload, '.'], { stdio: 'inherit' });
      fs.chmodSync(archive, 0o600);
      const archiveFd = fs.openSync(archive, 'r');
      try { fs.fsyncSync(archiveFd); } finally { fs.closeSync(archiveFd); }
      // Same-filesystem atomic publication, without replacing a prior archive.
      try { fs.linkSync(archive, resolvedOutputPath); }
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
export function restoreBackup({ archivePath, dataDir = getDataDir(), force = false } = {}) {
  assertTarAvailable();

  const resolvedArchivePath = path.resolve(archivePath);
  if (!fs.existsSync(resolvedArchivePath)) {
    throw new Error(`snapshot: archive "${resolvedArchivePath}" does not exist.`);
  }

  const alreadyExists = fs.existsSync(dataDir);
  const isNonEmpty = alreadyExists && fs.readdirSync(dataDir).length > 0;
  if (isNonEmpty && !force) {
    throw new Error(
      `snapshot: refusing to restore into non-empty U2OS_HOME "${dataDir}" without --force. ` +
        'Pass --force to overwrite/merge into the existing directory.'
    );
  }

  fs.mkdirSync(dataDir, { recursive: true });
  execFileSync('tar', ['-xzf', resolvedArchivePath, '-C', dataDir], { stdio: 'inherit' });

  return dataDir;
}

function printUsage() {
  console.log(`U2OS backup/restore -- offline snapshot of U2OS_HOME.

Usage:
  node server/backup/snapshot.js backup [outputPath]
  node server/backup/snapshot.js restore <archivePath> [--force]

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

  restore   Extracts an archive created by "backup" back into U2OS_HOME.
            Refuses to run into a non-empty U2OS_HOME unless --force is
            passed, to avoid silently clobbering existing live data.

Environment:
  U2OS_HOME   The data directory to back up from / restore into.
              Defaults to ~/.u2os.
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
  const positional = rest.filter((arg) => !arg.startsWith('--'));

  if (mode === 'backup') {
    const outputPath = await createBackup({ outputPath: positional[0] });
    console.log(`Backup written to ${outputPath}`);
    console.log(
      'WARNING: this archive contains your full U2OS data directory, including encrypted ' +
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
    const dataDir = restoreBackup({ archivePath, force });
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
