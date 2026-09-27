// Package permissions (docs/plugin-architecture.md §6): what a package may
// do at all. Declared in the manifest, normalized to flat strings, granted
// by the owner, and enforced by the capability invoker and the action queue
// worker -- never by the UI alone.
import { isPlainObject } from './json-schema.js';

// manifest domain -> { manifest key -> permission }
const BOOLEAN_PERMISSIONS = {
  email: { read: 'email.read', draft: 'email.draft', send: 'email.send' },
  calendar: { read: 'calendar.read', write: 'calendar.write' },
  contacts: { read: 'contacts.read', write: 'contacts.write' },
  tasks: { read: 'tasks.read', write: 'tasks.write' },
  notifications: { send: 'notifications.send' },
  browser: { navigate: 'browser.navigate', submitForms: 'browser.submit_forms' },
  shell: { execute: 'shell.execute' },
  devices: { control: 'devices.control' },
  payments: { spend: 'payments.spend' },
  code: { execute: 'code.execute' },
};
const FLAG_PERMISSIONS = new Set(['microphone', 'camera', 'location']);

export const PERMISSION_DESCRIPTIONS = Object.freeze({
  network: 'access the network',
  'email.read': 'read your email',
  'email.draft': 'draft email',
  'email.send': 'send email',
  'calendar.read': 'read your calendar',
  'calendar.write': 'create and change calendar events',
  'contacts.read': 'read your contacts',
  'contacts.write': 'change your contacts',
  'tasks.read': 'read your tasks',
  'tasks.write': 'create and complete tasks',
  'notifications.send': 'send you notifications',
  'browser.navigate': 'control a browser',
  'browser.submit_forms': 'submit web forms',
  microphone: 'use the microphone',
  camera: 'use the camera',
  location: 'know your location',
  'shell.execute': 'run shell commands',
  'devices.control': 'control devices',
  'payments.spend': 'spend money',
  'code.execute': 'run its own code inside U2OS (not sandboxed)',
});

// Permissions whose grant deserves extra emphasis in review output.
export const SENSITIVE_PERMISSIONS = new Set(['email.send', 'browser.submit_forms', 'shell.execute', 'payments.spend', 'code.execute', 'devices.control']);

const SCOPE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*(\.\*)?$/;
const KNOWN = new Set([...Object.values(BOOLEAN_PERMISSIONS).flatMap((map) => Object.values(map)), ...FLAG_PERMISSIONS, 'network']);

/**
 * normalizePermissions(manifest.permissions) -> { permissions: string[], errors: string[] }
 */
export function normalizePermissions(declared) {
  const errors = [];
  const permissions = new Set();
  if (declared === undefined || declared === null) return { permissions: [], errors };
  if (!isPlainObject(declared)) return { permissions: [], errors: ['permissions: must be a mapping'] };

  for (const [domain, value] of Object.entries(declared)) {
    if (domain === 'network') {
      const allowed = typeof value === 'boolean' ? value : isPlainObject(value) ? value.allowed : undefined;
      if (typeof allowed !== 'boolean') errors.push('permissions.network: must be true/false or { allowed: true }');
      else if (allowed) permissions.add('network');
      if (isPlainObject(value)) {
        for (const key of Object.keys(value)) if (key !== 'allowed') errors.push(`permissions.network.${key}: unsupported (host allow-lists are not enforced yet)`);
      }
    } else if (FLAG_PERMISSIONS.has(domain)) {
      if (typeof value !== 'boolean') errors.push(`permissions.${domain}: must be true or false`);
      else if (value) permissions.add(domain);
    } else if (domain === 'filesystem') {
      if (!isPlainObject(value)) { errors.push('permissions.filesystem: must map read/write to scope lists'); continue; }
      for (const [mode, scopes] of Object.entries(value)) {
        if (mode !== 'read' && mode !== 'write') { errors.push(`permissions.filesystem.${mode}: use read or write`); continue; }
        if (!Array.isArray(scopes)) { errors.push(`permissions.filesystem.${mode}: must be a list of scopes`); continue; }
        for (const scope of scopes) {
          // Scopes are logical storage names, never paths.
          if (typeof scope !== 'string' || !SCOPE.test(scope)) errors.push(`permissions.filesystem.${mode}: "${scope}" is not a valid scope (use names like profile.resume or jobs.*)`);
          else permissions.add(`filesystem.${mode}:${scope}`);
        }
      }
    } else if (Object.hasOwn(BOOLEAN_PERMISSIONS, domain)) {
      if (!isPlainObject(value)) { errors.push(`permissions.${domain}: must be a mapping`); continue; }
      for (const [key, flag] of Object.entries(value)) {
        const permission = BOOLEAN_PERMISSIONS[domain][key];
        if (!permission) errors.push(`permissions.${domain}.${key}: unknown permission`);
        else if (typeof flag !== 'boolean') errors.push(`permissions.${domain}.${key}: must be true or false`);
        else if (flag) permissions.add(permission);
      }
    } else {
      errors.push(`permissions.${domain}: unknown permission domain`);
    }
  }
  return { permissions: [...permissions].sort(), errors };
}

export function isKnownPermission(permission) {
  if (KNOWN.has(permission)) return true;
  const match = /^filesystem\.(read|write):(.+)$/.exec(permission);
  return Boolean(match && SCOPE.test(match[2]));
}

/** Does `held` (a granted/declared permission) cover `required`? */
export function covers(held, required) {
  if (held === required) return true;
  const h = /^filesystem\.(read|write):(.+)$/.exec(held);
  const r = /^filesystem\.(read|write):(.+)$/.exec(required);
  if (!h || !r || h[1] !== r[1]) return false;
  if (!h[2].endsWith('.*')) return false;
  const prefix = h[2].slice(0, -1); // keep the trailing dot
  return r[2].startsWith(prefix);
}

/**
 * checkPermissions({ required, declared, granted }) ->
 *   { allowed, required, missingDeclared, missingGrant }
 * A permission is usable only when the package declared it AND the owner
 * granted it.
 */
export function checkPermissions({ required = [], declared = [], granted = [] }) {
  const missingDeclared = required.filter((perm) => !declared.some((held) => covers(held, perm)));
  const missingGrant = required.filter((perm) => !granted.some((held) => covers(held, perm)));
  return { allowed: !missingDeclared.length && !missingGrant.length, required: [...required], missingDeclared, missingGrant };
}

export function describePermission(permission) {
  if (PERMISSION_DESCRIPTIONS[permission]) return PERMISSION_DESCRIPTIONS[permission];
  const match = /^filesystem\.(read|write):(.+)$/.exec(permission);
  if (match) return `${match[1] === 'read' ? 'read' : 'write'} ${match[2]}`;
  return permission;
}
