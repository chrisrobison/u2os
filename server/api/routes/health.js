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

export function registerHealthRoutes(router, { startTime }) {
  const version = readVersion();

  router.get('/api/health', async (_req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      version,
      uptimeSeconds: Math.round((Date.now() - startTime) / 1000),
      // This endpoint is intentionally safe for unauthenticated process
      // healthchecks. Dependency detail belongs to the owner-only diagnostics
      // endpoint and is never added here.
    });
  });
}
