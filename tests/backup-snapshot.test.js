import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackup, restoreBackup } from '../server/backup/snapshot.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('backup-snapshot: full round trip -- snapshot a seeded U2OS_HOME, restore into a fresh empty dir, content matches', async () => {
  const sourceHome = tempDir('u2os-backup-src-');
  const destHome = tempDir('u2os-backup-dst-');
  const archiveDir = tempDir('u2os-backup-archive-');
  try {
    // Seed known content across a nested subdirectory (config/) and a
    // top-level file, mirroring U2OS_HOME's real shape
    // (config/, policies/, db/, credentials/, cache/).
    fs.mkdirSync(path.join(sourceHome, 'config'), { recursive: true });
    fs.mkdirSync(path.join(sourceHome, 'db'), { recursive: true });
    fs.mkdirSync(path.join(sourceHome, 'credentials'), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'config', 'config.json'), JSON.stringify({ port: 4000 }));
    fs.writeFileSync(path.join(sourceHome, 'db', 'marker.txt'), 'known-db-content-xyz');
    fs.writeFileSync(path.join(sourceHome, 'credentials', 'master.key'), 'fake-master-key-bytes');

    const outputPath = path.join(archiveDir, 'snapshot.tar.gz');
    const written = await createBackup({ dataDir: sourceHome, outputPath });
    assert.equal(written, outputPath);
    assert.ok(fs.existsSync(outputPath), 'archive file should exist after backup');
    assert.ok(fs.statSync(outputPath).size > 0, 'archive should not be empty');

    // Destination starts genuinely empty.
    assert.equal(fs.readdirSync(destHome).length, 0);

    const restoredInto = await restoreBackup({ archivePath: outputPath, dataDir: destHome });
    assert.equal(restoredInto, destHome);

    assert.equal(
      fs.readFileSync(path.join(destHome, 'config', 'config.json'), 'utf8'),
      JSON.stringify({ port: 4000 })
    );
    assert.equal(fs.readFileSync(path.join(destHome, 'db', 'marker.txt'), 'utf8'), 'known-db-content-xyz');
    assert.equal(
      fs.readFileSync(path.join(destHome, 'credentials', 'master.key'), 'utf8'),
      'fake-master-key-bytes'
    );
  } finally {
    fs.rmSync(sourceHome, { recursive: true, force: true });
    fs.rmSync(destHome, { recursive: true, force: true });
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});

test('backup-snapshot: restore refuses a non-empty target without --force, and proceeds with force: true', async () => {
  const sourceHome = tempDir('u2os-backup-src2-');
  const destHome = tempDir('u2os-backup-dst2-');
  const archiveDir = tempDir('u2os-backup-archive2-');
  try {
    fs.mkdirSync(path.join(sourceHome, 'db'), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'db', 'marker.txt'), 'fresh-content');

    const outputPath = path.join(archiveDir, 'snapshot.tar.gz');
    await createBackup({ dataDir: sourceHome, outputPath });

    // Make the destination non-empty with unrelated pre-existing content.
    fs.writeFileSync(path.join(destHome, 'pre-existing.txt'), 'do-not-clobber-me-silently');

    await assert.rejects(
      () => restoreBackup({ archivePath: outputPath, dataDir: destHome }),
      /non-empty/i,
      'restore into a non-empty dir without --force must refuse'
    );
    // The refusal must not have touched the pre-existing file/dir contents.
    assert.equal(fs.readFileSync(path.join(destHome, 'pre-existing.txt'), 'utf8'), 'do-not-clobber-me-silently');

    // With --force, it proceeds and the archive's content lands.
    const restoredInto = await restoreBackup({ archivePath: outputPath, dataDir: destHome, force: true });
    assert.equal(restoredInto, destHome);
    assert.equal(fs.readFileSync(path.join(destHome, 'db', 'marker.txt'), 'utf8'), 'fresh-content');
  } finally {
    fs.rmSync(sourceHome, { recursive: true, force: true });
    fs.rmSync(destHome, { recursive: true, force: true });
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});
