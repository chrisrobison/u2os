import { sendJson } from '../router.js';
import { getVaultDir } from '../../vault/vault-dir.js';
import { indexVault, getLastVaultReport } from '../../vault/indexer.js';
import { exportMemoryToVault } from '../../vault/exporter.js';
import { loadPolicies, getPolicySourceStatus } from '../../policy/policies-loader.js';

// Owner-only (router default). The report names vault-relative paths and
// parse errors, never file contents.
export function registerVaultRoutes(router, { eventBus }) {
  router.get('/api/vault', async (_req, res) => {
    loadPolicies(); // refresh the policy file status without changing the running engine
    sendJson(res, 200, { vaultDir: getVaultDir(), lastIndex: getLastVaultReport(), policy: getPolicySourceStatus() });
  });

  router.post('/api/vault/reindex', async (_req, res) => {
    sendJson(res, 200, { report: indexVault({ eventBus }) });
  });

  // Writes database memory into new vault files (never overwriting), then
  // indexes them so the files become the authority for those records.
  router.post('/api/vault/export', async (_req, res) => {
    const exported = exportMemoryToVault();
    sendJson(res, 200, { export: exported, index: indexVault({ eventBus }) });
  });
}
