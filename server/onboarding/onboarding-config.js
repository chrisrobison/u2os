import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';

// First-run onboarding status, stored as `onboardingCompletedAt` inside
// ~/.u2os/config/config.json -- same read-merge-write pattern as
// server/voice/voice-config.js and server/agent/provider-config.js's
// saveModelConfig(), so this never clobbers unrelated keys like `vaultDir`
// or `model`.

export function configPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'config', 'config.json');
}

function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/** Whether the first-run onboarding wizard has been completed, and when. */
export function getOnboardingStatus(dataDir = getDataDir()) {
  const config = readConfig(configPath(dataDir));
  const completedAt = typeof config.onboardingCompletedAt === 'string' ? config.onboardingCompletedAt : null;
  return { completed: Boolean(completedAt), completedAt };
}

/** Idempotent: a second call keeps the original completion timestamp. */
export function completeOnboarding(dataDir = getDataDir()) {
  const file = configPath(dataDir);
  const config = readConfig(file);
  if (typeof config.onboardingCompletedAt !== 'string') {
    config.onboardingCompletedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  return getOnboardingStatus(dataDir);
}
