// Loads/writes the voice-authorization block inside ~/.u2os/config/config.json
// (`voiceThresholds` + `privateDomains`), mirroring the existing idempotent
// pattern in server/policy/policies-loader.js and
// server/integrations/connectors-config.js: write sane defaults into the
// file the first time they're missing, then just read them back on every
// subsequent call. Unlike those two, config.json already exists by the time
// a normal server boots (server/seed/seed.js's ensureConfigFile() writes
// {port, modelProvider} on first run) -- this module never assumes that,
// though, and is equally happy creating the whole file from scratch (e.g. a
// unit test that never ran seed).
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';

// Defaults per docs/voice.md's "Server-side enforcement" section and
// PROMPT.md #7's example thresholds.
export const DEFAULT_VOICE_THRESHOLDS = { conversation: 0.7, standard: 0.85, private: 0.95 };
export const DEFAULT_PRIVATE_DOMAINS = [];

export function configPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'config', 'config.json');
}

/**
 * Ensures ~/.u2os/config/config.json has a `voiceThresholds` object and a
 * `privateDomains` array, filling in only whatever is missing (a
 * hand-edited file that already customized one threshold keeps its other
 * values; it never gets clobbered back to defaults). Returns the
 * voice-relevant slice of config -- not the whole file -- since that's all
 * callers need.
 */
export function ensureVoiceConfig(dataDir = getDataDir()) {
  const file = configPath(dataDir);
  let config = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      // Malformed file -- fail safe by treating it as empty rather than
      // crashing the server; the defaults below get written back over it.
      config = {};
    }
  }

  let changed = false;

  if (typeof config.voiceThresholds !== 'object' || config.voiceThresholds === null) {
    config.voiceThresholds = { ...DEFAULT_VOICE_THRESHOLDS };
    changed = true;
  } else {
    for (const key of Object.keys(DEFAULT_VOICE_THRESHOLDS)) {
      if (typeof config.voiceThresholds[key] !== 'number') {
        config.voiceThresholds[key] = DEFAULT_VOICE_THRESHOLDS[key];
        changed = true;
      }
    }
  }

  if (!Array.isArray(config.privateDomains)) {
    config.privateDomains = [...DEFAULT_PRIVATE_DOMAINS];
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  return { voiceThresholds: config.voiceThresholds, privateDomains: config.privateDomains };
}
