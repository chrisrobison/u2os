import { getDb } from '../db/connection.js';
import { log } from '../logging/logger.js';
import { COLLECTIONS, getVaultDir } from './vault-dir.js';
import { listMarkdownFiles, fileSignature } from './markdown.js';
import { indexVault } from './indexer.js';

// Polling (not fs.watch) so behaviour is identical on Linux, macOS, network
// and synced folders. Signatures are cheap stat() calls; the full index only
// runs when a file was added, removed, or changed, or the owner link changed.
const DEFAULT_INTERVAL_MS = 5_000;

export function vaultSignature(vaultDir = getVaultDir()) {
  const owner = getDb().prepare('SELECT entity_id FROM owners WHERE entity_id IS NOT NULL LIMIT 1').get()?.entity_id || '';
  const files = ['me.md', ...Object.keys(COLLECTIONS).flatMap((dir) => listMarkdownFiles(vaultDir, dir))];
  return `${owner}|${files.map((file) => `${file}=${fileSignature(vaultDir, file)}`).join('|')}`;
}

export function startVaultWatcher({ eventBus, intervalMs = Number(process.env.U2OS_VAULT_POLL_MS) || DEFAULT_INTERVAL_MS, onIndexed = null } = {}) {
  let signature = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const vaultDir = getVaultDir();
      const next = vaultSignature(vaultDir);
      if (next === signature) return;
      const report = indexVault({ eventBus, vaultDir });
      signature = next;
      if (report.errors.length) log.warn('vault', 'Some vault files could not be indexed', { errors: report.errors.length });
      onIndexed?.(report);
    } catch (error) {
      log.error('vault', 'Vault indexing failed', { error: error?.message || String(error) });
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    reindexNow() { signature = null; tick(); },
    stop() { stopped = true; clearInterval(timer); },
  };
}
