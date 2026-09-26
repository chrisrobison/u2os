import fs from 'node:fs';
import path from 'node:path';
import { restoreBackup } from '../../server/backup/snapshot.js';

// Isolated process fault injection: die after the first payload file write,
// not at an arbitrary timer. Preserve private staging under the test root.
const copy = fs.copyFileSync, mktemp = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...args) => mktemp(String(prefix).includes('u2os-restore-stage-') ? path.join(process.env.FIXTURE_ROOT, 'interrupted-stage-') : prefix, ...args);
fs.copyFileSync = (...args) => {
  copy(...args);
  if (String(args[0]).includes('interrupted-stage-')) process.kill(process.pid, 'SIGKILL');
};
await restoreBackup({ archivePath: process.env.FIXTURE_ARCHIVE, dataDir: process.env.U2OS_HOME });
