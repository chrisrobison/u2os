// Loads/writes ~/.u2os/config/connectors.yaml, mirroring the existing
// pattern in server/policy/policies-loader.js: a default file is written on
// first load if absent, and every subsequent load just reads it back.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDataDir } from '../db/connection.js';

const DOMAINS = ['calendar', 'email', 'contacts', 'web', 'notifications'];

// Per docs/connectors.md's "Fast-follow" section, caldav/imap are accepted
// as valid `active` values for calendar/email respectively even though their
// provider modules are stub-only this phase (provider-registry.js falls back
// to mock for them, same as any other not-connected real id).
const VALID_PROVIDER_IDS = {
  calendar: ['mock', 'google-calendar', 'caldav'],
  email: ['mock', 'gmail', 'imap'],
  contacts: ['mock', 'google-contacts'],
  web: ['mock', 'brave-search'],
  notifications: ['mock', 'webhook'],
};

const DEFAULT_CONFIG = {
  calendar: { active: 'mock' },
  email: { active: 'mock' },
  contacts: { active: 'mock' },
  web: { active: 'mock' },
  notifications: { active: 'mock' },
};

export function connectorsConfigPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'config', 'connectors.yaml');
}

export function validProviderIdsFor(domain) {
  return VALID_PROVIDER_IDS[domain] || [];
}

export function ensureDefaultConnectorsConfig(dataDir = getDataDir()) {
  const file = connectorsConfigPath(dataDir);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml.dump(DEFAULT_CONFIG), 'utf8');
  }
  return file;
}

export function loadConnectorsConfig(dataDir = getDataDir()) {
  const file = ensureDefaultConnectorsConfig(dataDir);
  const raw = fs.readFileSync(file, 'utf8');
  const loaded = yaml.load(raw) || {};
  // Defensive merge: any domain missing from a hand-edited file falls back
  // to 'mock' rather than crashing provider-registry.js.
  const config = {};
  for (const domain of DOMAINS) {
    config[domain] = { active: 'mock', ...(loaded[domain] || {}) };
  }
  return config;
}

export function saveConnectorsConfig(config, dataDir = getDataDir()) {
  const file = connectorsConfigPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(config), 'utf8');
  return config;
}

/**
 * Validates providerId is a known id for that domain, then persists it as
 * the domain's active provider. Throws on an unknown domain/providerId so
 * the API route can turn that into a 400.
 */
export function setActiveProvider(domain, providerId, dataDir = getDataDir()) {
  if (!DOMAINS.includes(domain)) {
    throw new Error(`Unknown connector domain: ${domain}`);
  }
  const validIds = validProviderIdsFor(domain);
  if (!validIds.includes(providerId)) {
    throw new Error(`Unknown provider "${providerId}" for domain "${domain}". Valid: ${validIds.join(', ')}`);
  }
  const config = loadConnectorsConfig(dataDir);
  config[domain] = { ...config[domain], active: providerId };
  saveConnectorsConfig(config, dataDir);
  return config;
}

export { DOMAINS };
