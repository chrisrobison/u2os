import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '../db/connection.js';
import { isOwnedGuardArtifact } from '../runtime/home-guard.js';

export function installationModePath(dataDir = getDataDir()) {
  return path.join(dataDir, 'config', 'installation.json');
}

export function readInstallationMode(dataDir = getDataDir()) {
  return readInstallationConfig(dataDir)?.data.mode || 'personal';
}

function invalidConfiguration() {
  const error = new Error('Installation metadata is invalid or unavailable; preserve it and review configuration before starting. Do not replace an existing installation identity');
  error.code = 'INSTALLATION_METADATA_INVALID'; return error;
}

/** Read-only identity inspection: legacy absence is never guessed from owner
 * name, entity ID, path or credentials. No configuration is changed here. */
export function readInstallationIdentity(dataDir = getDataDir()) {
  return readInstallationConfig(dataDir)?.data.installationId ?? null;
}

function readInstallationConfig(dataDir) {
  const file = installationModePath(dataDir);
  let fd;
  try {
    let directory;
    try { directory = fs.lstatSync(path.dirname(file)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!directory.isDirectory()) throw invalidConfiguration();
    let metadata;
    try { metadata = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) throw invalidConfiguration();
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw invalidConfiguration();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd));
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object' || !['personal', 'demo'].includes(value.mode)) throw invalidConfiguration();
    if (Object.hasOwn(value, 'installationId') && (typeof value.installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.installationId))) throw invalidConfiguration();
    return { data: value, text };
  } catch { throw invalidConfiguration(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Caller owns the home. Atomic, durable metadata replacement preserves
 * unrelated fields; interruption before rename leaves old config intact. */
function persistInstallationConfig(dataDir, text, { initial = false } = {}) {
  const file = installationModePath(dataDir), directory = path.dirname(file);
  let temporary;
  try {
    if (Buffer.byteLength(text) > 1024 * 1024) throw invalidConfiguration();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw invalidConfiguration();
    temporary = fs.mkdtempSync(path.join(directory, '.installation-stage-'));
    fs.chmodSync(temporary, 0o700);
    const staged = path.join(temporary, 'installation.json');
    const fd = fs.openSync(staged, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (initial) fs.linkSync(staged, file); // Never clobber competing first setup.
    else fs.renameSync(staged, file);
    for (const parent of [directory, dataDir]) {
      const directoryFd = fs.openSync(parent, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } catch { throw invalidConfiguration(); }
  finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** A demo choice is permanent for this home; unmarked legacy homes are personal. */
export function ensureInstallationMode(requestedMode = null, dataDir = getDataDir()) {
  if (requestedMode !== null && requestedMode !== 'personal' && requestedMode !== 'demo') throw new Error('Invalid installation mode');
  const configuration = readInstallationConfig(dataDir), saved = configuration?.data;
  if (saved) {
    const savedMode = saved.mode;
    if (requestedMode && requestedMode !== savedMode) throw new Error(`This data home is already ${savedMode}; use a separate home for ${requestedMode}`);
    if (!saved.installationId) {
      // Preserve unknown fields byte-for-byte, including integers outside JS
      // precision, escapes and formatting. Append only our new root property.
      const closingBrace = configuration.text.lastIndexOf('}');
      const text = `${configuration.text.slice(0, closingBrace)},"installationId":${JSON.stringify(randomUUID())}${configuration.text.slice(closingBrace)}`;
      persistInstallationConfig(dataDir, text);
    }
    return savedMode;
  }
  const hadData = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((name) => {
    if (isOwnedGuardArtifact(dataDir, name)) return false;
    if (name !== 'config') return true;
    const configDir = path.join(dataDir, name);
    return !fs.statSync(configDir).isDirectory() || fs.readdirSync(configDir).length > 0;
  });
  if (requestedMode === 'demo' && hadData) throw new Error('Cannot convert an existing unmarked data home to demo; use a separate empty home');
  const mode = requestedMode || 'personal';
  persistInstallationConfig(dataDir, `${JSON.stringify({ mode, createdAt: new Date().toISOString(), installationId: randomUUID() })}\n`, { initial: true });
  return mode;
}
