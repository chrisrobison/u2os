#!/usr/bin/env node
// Full-fidelity backup/restore of U2OS_HOME. Per docs/deployment.md §7.
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
//   - System tar preserves permissions, symlinks, and every other bit of
///    filesystem metadata "for free" -- a hand-rolled format would need to
//     reimplement that fidelity itself, for a one-off local backup tool
//     where the extra dependency-free code isn't worth the risk of getting
//     an edge case wrong.
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
 * Creates a timestamped .tar.gz snapshot of the entire U2OS_HOME directory
 * tree (config/, policies/, db/, credentials/, cache/). Returns the
 * resolved output path.
 */
export function createBackup({ dataDir = getDataDir(), outputPath } = {}) {
  assertTarAvailable();

  if (!fs.existsSync(dataDir)) {
    throw new Error(`snapshot: U2OS_HOME "${dataDir}" does not exist -- nothing to back up.`);
  }

  const resolvedOutputPath = path.resolve(
    outputPath || `u2os-backup-${timestampForFilename()}.tar.gz`
  );

  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  // Archive the *contents* of dataDir at the archive root (not the
  // enclosing directory name), so restore can extract into a U2OS_HOME of
  // any name/location.
  execFileSync('tar', ['-czf', resolvedOutputPath, '-C', dataDir, '.'], { stdio: 'inherit' });

  return resolvedOutputPath;
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
  console.log(`U2OS backup/restore -- full-fidelity snapshot of U2OS_HOME.

Usage:
  node server/backup/snapshot.js backup [outputPath]
  node server/backup/snapshot.js restore <archivePath> [--force]

  backup    Creates a timestamped .tar.gz of the entire U2OS_HOME directory
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
    const outputPath = createBackup({ outputPath: positional[0] });
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
