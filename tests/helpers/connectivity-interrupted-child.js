import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { reviewRecoveryConnectivity } from '../../server/backup/recovery-connectivity.js';

const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  // Files are already private/offline; interrupt after database updates but
  // before checkpoint commit. Explicit retry must recover SQLite rollback.
  if (process.argv[2] !== 'files' && sql.startsWith('INSERT INTO events')) process.kill(process.pid, 'SIGKILL');
  return prepare.call(this, sql);
};
const unlink = fs.unlinkSync;
fs.unlinkSync = (file) => {
  if (process.argv[2] === 'files' && String(file).endsWith('config/config.json')) process.kill(process.pid, 'SIGKILL');
  return unlink(file);
};
reviewRecoveryConnectivity({ apply: true });
