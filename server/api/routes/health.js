import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson } from '../router.js';
import { getHealth as getConnectorsHealth } from '../../integrations/provider-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/api/routes/ -> server/api/ -> server/ -> repo root.
const PACKAGE_JSON_PATH = path.join(__dirname, '..', '..', '..', 'package.json');

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

export function registerHealthRoutes(router, { dataDir, dbPath, startTime }) {
  const version = readVersion();

  router.get('/api/health', async (_req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      version,
      dataDir,
      dbPath,
      uptimeSeconds: Math.round((Date.now() - startTime) / 1000),
      // Per docs/deployment.md §8: a glance at /api/health should tell you
      // if a configured real connector has gone unhealthy. Never includes
      // decrypted secrets -- see provider-registry.getHealth()'s own note.
      connectors: getConnectorsHealth({ dataDir }),
    });
  });
}
