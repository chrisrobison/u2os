import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';

export function installationModePath(dataDir = getDataDir()) {
  return path.join(dataDir, 'config', 'installation.json');
}

/** A demo choice is permanent for this home; unmarked legacy homes are personal. */
export function ensureInstallationMode(requestedMode = null, dataDir = getDataDir()) {
  if (requestedMode !== null && requestedMode !== 'personal' && requestedMode !== 'demo') throw new Error('Invalid installation mode');
  const file = installationModePath(dataDir);
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!['personal', 'demo'].includes(saved.mode)) throw new Error('Invalid persisted installation mode');
    if (requestedMode && requestedMode !== saved.mode) throw new Error(`This data home is already ${saved.mode}; use a separate home for ${requestedMode}`);
    return saved.mode;
  }
  const hadData = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((name) => {
    if (name !== 'config') return true;
    const configDir = path.join(dataDir, name);
    return !fs.statSync(configDir).isDirectory() || fs.readdirSync(configDir).length > 0;
  });
  if (requestedMode === 'demo' && hadData) throw new Error('Cannot convert an existing unmarked data home to demo; use a separate empty home');
  const mode = requestedMode || 'personal';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mode, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  return mode;
}
