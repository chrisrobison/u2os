import { sendJson } from '../router.js';
import { getVaultDir } from '../../vault/vault-dir.js';
import { indexVault, getLastVaultReport } from '../../vault/indexer.js';

// Owner-only (router default). The report names vault-relative paths and
// parse errors, never file contents.
export function registerVaultRoutes(router, { eventBus }) {
  router.get('/api/vault', async (_req, res) => {
    sendJson(res, 200, { vaultDir: getVaultDir(), lastIndex: getLastVaultReport() });
  });

  router.post('/api/vault/reindex', async (_req, res) => {
    sendJson(res, 200, { report: indexVault({ eventBus }) });
  });
}
