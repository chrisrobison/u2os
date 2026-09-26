import { DatabaseSync } from 'node:sqlite';
import { reviewRecoveryWork } from '../../server/backup/recovery-quarantine.js';

const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  // Die after state updates but before the audit/checkpoint commit. SQLite
  // must roll back the whole quarantine when explicit apply next opens it.
  if (sql.startsWith('INSERT INTO events')) process.kill(process.pid, 'SIGKILL');
  return prepare.call(this, sql);
};
reviewRecoveryWork({ apply: true });
