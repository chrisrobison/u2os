import { withOfflineHome } from '../runtime/offline-home.js';
import { exportMemoryToVault } from './exporter.js';

// `npm run vault:export`: stop the runtime first (same ownership guard as
// other offline commands), or use POST /api/vault/export while it runs.
try {
  await withOfflineHome(() => {
    process.stdout.write(`${JSON.stringify(exportMemoryToVault(), null, 2)}\n`);
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
