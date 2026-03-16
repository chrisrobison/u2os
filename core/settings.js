const fs = require('fs');
const path = require('path');

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) return isPlainObject(override) ? { ...override } : override;
  if (!isPlainObject(override)) return { ...base };

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function toClientKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function readJsonIfExists(filePath) {
  if (!filePath) return {};
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    return {};
  }
  const raw = fs.readFileSync(absolutePath, 'utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return isPlainObject(parsed) ? parsed : {};
}

function loadEffectiveSettings({ globalSettingsPath, clientsDir, clientName }) {
  const globalSettings = readJsonIfExists(globalSettingsPath);
  const clientKey = toClientKey(clientName);

  if (!clientKey) {
    return {
      clientKey: null,
      globalSettings,
      clientSettings: {},
      effectiveSettings: globalSettings,
      source: {
        global: path.resolve(process.cwd(), globalSettingsPath),
        client: null
      }
    };
  }

  const clientPath = path.join(clientsDir, clientKey, 'settings.json');
  const clientSettings = readJsonIfExists(clientPath);
  return {
    clientKey,
    globalSettings,
    clientSettings,
    effectiveSettings: deepMerge(globalSettings, clientSettings),
    source: {
      global: path.resolve(process.cwd(), globalSettingsPath),
      client: path.resolve(process.cwd(), clientPath)
    }
  };
}

module.exports = {
  deepMerge,
  toClientKey,
  loadEffectiveSettings
};

