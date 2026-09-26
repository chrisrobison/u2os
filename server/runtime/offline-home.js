import { getDataDir } from '../db/connection.js';
import { acquireHomeGuard } from './home-guard.js';

/** CLI entry points acquire before opening/migrating application storage.
 * Do not use this inside an already-owned runtime or release before awaited
 * work settles. Low-level store helpers remain the caller's responsibility. */
export async function withOfflineHome(operation, { dataDir = getDataDir() } = {}) {
  const guard = acquireHomeGuard(dataDir);
  try { return await operation(); }
  finally { guard.release(); }
}
