// Server-side persistence for Phase 5's voice enrollment (docs/voice.md).
// The actual enrollment audio capture + feature extraction happens
// client-side (public/services/voiceprint.js); this module just
// stores/returns the resulting small feature vector, in the same
// ~/.u2os/config/config.json file server/voice/voice-config.js already
// manages -- U2OS's existing "settings persist on the server" convention
// (server/policy/policies-loader.js, server/integrations/connectors-config.js),
// not localStorage, so an enrolled voice survives a refresh or a different
// browser tab.
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';
import { configPath } from './voice-config.js';

function readConfig(dataDir) {
  const file = configPath(dataDir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeConfig(config, dataDir) {
  const file = configPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function getVoiceEnrollment(dataDir = getDataDir()) {
  const config = readConfig(dataDir);
  const enrollment = config.voiceEnrollment;
  if (!enrollment || !Array.isArray(enrollment.vector) || !enrollment.vector.length) {
    return { enrolled: false, enrolledAt: null, vector: null };
  }
  return { enrolled: true, enrolledAt: enrollment.enrolledAt || null, vector: enrollment.vector };
}

export function saveVoiceEnrollment(vector, dataDir = getDataDir()) {
  if (!Array.isArray(vector) || !vector.length || !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('vector must be a non-empty array of finite numbers');
  }
  const config = readConfig(dataDir);
  const enrolledAt = new Date().toISOString();
  config.voiceEnrollment = { vector, enrolledAt };
  writeConfig(config, dataDir);
  return { enrolled: true, enrolledAt, vector };
}

export function clearVoiceEnrollment(dataDir = getDataDir()) {
  const config = readConfig(dataDir);
  delete config.voiceEnrollment;
  writeConfig(config, dataDir);
  return { enrolled: false, enrolledAt: null, vector: null };
}
