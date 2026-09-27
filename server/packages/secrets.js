// Package secrets (docs/plugin-architecture.md §10). Packages reference
// secrets by declared name only; values are stored encrypted by the existing
// credential vault (server/security/vault.js) and are never written into
// manifests, workflows, settings, events or logs.
import { readEncryptedFile, writeEncryptedFile, deleteEncryptedFile } from '../security/vault.js';
import { PACKAGE_ID } from './ids.js';

const SECRET_NAME = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;

function key(packageId, name) {
  if (!PACKAGE_ID.test(packageId) || !SECRET_NAME.test(name)) throw new Error('Invalid package secret reference');
  return `package--${packageId}--${name}`;
}

function assertDeclared(manifest, name) {
  if (!manifest.secrets.includes(name)) {
    const error = new Error(`${manifest.id} does not declare secret ${name}`);
    error.status = 400;
    throw error;
  }
}

export function setPackageSecret(manifest, name, value) {
  assertDeclared(manifest, name);
  writeEncryptedFile(key(manifest.id, name), { value });
}

export function getPackageSecret(manifest, name) {
  assertDeclared(manifest, name);
  return readEncryptedFile(key(manifest.id, name))?.value ?? null;
}

export function deletePackageSecret(manifest, name) {
  assertDeclared(manifest, name);
  deleteEncryptedFile(key(manifest.id, name));
}

/** Which declared secrets have a stored value (names only). */
export function secretStatus(manifest) {
  return manifest.secrets.map((name) => {
    let configured = false;
    try { configured = readEncryptedFile(key(manifest.id, name)) !== null; } catch { configured = false; }
    return { name, configured };
  });
}
