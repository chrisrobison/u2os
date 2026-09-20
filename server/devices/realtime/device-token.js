// A single, per-installation shared secret gating who may even OPEN a
// realtime device connection -- deliberately NOT a per-device credential or
// identity. This is a TRANSPORT-level gate (can this caller talk to the
// device bus at all), kept strictly separate from the per-device `trust`
// lifecycle (server/devices/device-registry.js) that governs AUTHORIZATION
// once connected -- the same identity/authentication/authorization split
// docs/devices.md's Policy section requires. A device presenting this
// token is merely "on the network and speaking the protocol correctly";
// it still starts life as `trust: 'untrusted'` in the registry.
//
// A full per-device cryptographic identity (docs/devices.md Phase 7 --
// pairing/public-key credentials) is the intended replacement for this. This
// is the explicit seam that phase plugs into: swap what gates
// handleUpgrade() in websocket-device-adapter.js, leave everything else
// (registry, trust field, resolver) unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from '../../db/connection.js';

function tokenPath(dataDir) {
  return path.join(dataDir, 'credentials', 'device-connect-token.key');
}

/**
 * Returns the current token, generating and persisting one (0600) on first
 * call. Idempotent. Mirrors server/security/vault.js's
 * generateOrLoadMasterKey() exactly.
 */
export function getOrCreateDeviceConnectToken(dataDir = getDataDir()) {
  const dir = path.join(dataDir, 'credentials');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms where chmod is a no-op
  }

  const file = tokenPath(dataDir);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').trim();
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
  return token;
}
