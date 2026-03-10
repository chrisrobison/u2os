const fs = require('fs/promises');
const path = require('path');

const ALLOWED_HOOK_EVENTS = new Set(['onLoad', 'onView', 'beforeSave', 'afterSave', 'onSave']);
const ALLOWED_HOOK_TYPES = new Set(['client', 'server']);
const APP_ID_PATTERN = /^[a-z0-9_-]+$/i;

function validateHook(hook, itemId, eventName, index) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    throw new Error(`Nav item '${itemId}' hook ${eventName}[${index}] must be an object`);
  }

  if (!ALLOWED_HOOK_TYPES.has(hook.type)) {
    throw new Error(`Nav item '${itemId}' hook ${eventName}[${index}] has invalid type '${hook.type}'`);
  }

  if (!hook.name || typeof hook.name !== 'string') {
    throw new Error(`Nav item '${itemId}' hook ${eventName}[${index}] requires a string name`);
  }

  if (hook.options != null && (typeof hook.options !== 'object' || Array.isArray(hook.options))) {
    throw new Error(`Nav item '${itemId}' hook ${eventName}[${index}] options must be an object`);
  }
}

function validateNavItem(item, pathLabel = 'root') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Navigation item '${pathLabel}' must be an object`);
  }

  if (!item.id || typeof item.id !== 'string') {
    throw new Error(`Navigation item '${pathLabel}' requires a string id`);
  }

  if (!item.title || typeof item.title !== 'string') {
    throw new Error(`Navigation item '${item.id}' requires a string title`);
  }

  if (item.componentTag != null && typeof item.componentTag !== 'string') {
    throw new Error(`Navigation item '${item.id}' componentTag must be a string`);
  }

  if (item.componentProps != null && (typeof item.componentProps !== 'object' || Array.isArray(item.componentProps))) {
    throw new Error(`Navigation item '${item.id}' componentProps must be an object`);
  }

  if (item.meta != null && (typeof item.meta !== 'object' || Array.isArray(item.meta))) {
    throw new Error(`Navigation item '${item.id}' meta must be an object`);
  }

  if (item.hooks != null) {
    if (typeof item.hooks !== 'object' || Array.isArray(item.hooks)) {
      throw new Error(`Navigation item '${item.id}' hooks must be an object`);
    }

    for (const [eventName, hookList] of Object.entries(item.hooks)) {
      if (!ALLOWED_HOOK_EVENTS.has(eventName)) {
        throw new Error(`Navigation item '${item.id}' uses unknown hook event '${eventName}'`);
      }
      if (!Array.isArray(hookList)) {
        throw new Error(`Navigation item '${item.id}' hook '${eventName}' must be an array`);
      }
      hookList.forEach((hook, index) => validateHook(hook, item.id, eventName, index));
    }
  }

  if (item.children != null) {
    if (!Array.isArray(item.children)) {
      throw new Error(`Navigation item '${item.id}' children must be an array`);
    }
    item.children.forEach((child, index) => validateNavItem(child, `${item.id}.${index}`));
  }
}

function validateAppDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('App definition must be an object');
  }

  if (!definition.version || typeof definition.version !== 'string') {
    throw new Error('App definition requires a string version');
  }

  if (!definition.app || typeof definition.app !== 'object' || Array.isArray(definition.app)) {
    throw new Error('App definition requires an app object');
  }

  if (!definition.app.id || typeof definition.app.id !== 'string') {
    throw new Error('App definition app.id must be a string');
  }

  if (!definition.app.name || typeof definition.app.name !== 'string') {
    throw new Error('App definition app.name must be a string');
  }

  if (!Array.isArray(definition.navigation)) {
    throw new Error('App definition requires a navigation array');
  }

  definition.navigation.forEach((item, index) => validateNavItem(item, `navigation.${index}`));
}

function assertAppId(value) {
  if (!value || !APP_ID_PATTERN.test(value)) {
    throw new Error(`Invalid app id '${value}'`);
  }
}

async function listAppIds(appsDir) {
  const entries = await fs.readdir(appsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.replace(/\.json$/, ''))
    .sort();
}

async function loadAppDefinition(appsDir, appId) {
  assertAppId(appId);
  const filePath = path.join(appsDir, `${appId}.json`);
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  validateAppDefinition(parsed);
  return parsed;
}

module.exports = {
  loadAppDefinition,
  listAppIds,
  validateAppDefinition,
  ALLOWED_HOOK_EVENTS,
  ALLOWED_HOOK_TYPES
};
