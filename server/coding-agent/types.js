// Normalized coding-agent vocabulary (docs/coding-agents.md).
//
// A coding agent is a capability, not an API provider: something that can be
// handed a software-engineering task in a directory and report back. The
// task and run shapes here are deliberately provider-independent; anything
// vendor-specific lives in an adapter (providers/*.js) or in the owner's
// provider configuration (coding-agents.yaml), never in the task.

export const CAPABILITY_ID = 'coding.agent';

// queued -> running -> one terminal status. ("created" in the product spec is `queued`.)
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'needs_input']);

export const FILESYSTEM_LEVELS = Object.freeze(['none', 'read', 'project', 'unrestricted']);

export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_TASK_CHARS = 100_000;
const MAX_ENV_VARS = 32;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_VALUE = 8 * 1024;

// Least privilege: an omitted permission never widens. A task that only
// asks a question gets a read-only agent with no shell, network or git.
export const DEFAULT_PERMISSIONS = Object.freeze({ filesystem: 'read', shell: false, network: false, git: false });

export class CodingAgentError extends Error {
  constructor(message, code, { status = 400 } = {}) {
    super(message);
    this.name = 'CodingAgentError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Validates and normalizes a caller-supplied task. `cwd` stays as given
 * here (an absolute path); the runner resolves symlinks and checks it
 * against the owner's roots because that needs the filesystem.
 *
 * Returns { task, cwd, permissions, timeoutMs, environment, metadata }.
 */
export function normalizeTask(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid('A coding task must be an object');
  const { task, cwd, permissions, timeout, environment, metadata } = input;

  if (typeof task !== 'string' || !task.trim()) throw invalid('task must be a non-empty string');
  if (task.length > MAX_TASK_CHARS) throw invalid(`task is longer than ${MAX_TASK_CHARS} characters`);
  if (task.includes('\0')) throw invalid('task must not contain NUL characters');

  if (typeof cwd !== 'string' || !cwd.trim()) throw invalid('cwd is required: every run needs an explicit working directory');
  if (cwd.includes('\0')) throw invalid('cwd must not contain NUL characters');

  return {
    task,
    cwd,
    permissions: normalizePermissions(permissions),
    timeoutMs: normalizeTimeout(timeout),
    environment: normalizeEnvironment(environment),
    metadata: normalizeMetadata(metadata),
  };
}

export function normalizePermissions(permissions) {
  if (permissions === undefined || permissions === null) return { ...DEFAULT_PERMISSIONS };
  if (typeof permissions !== 'object' || Array.isArray(permissions)) throw invalid('permissions must be an object');
  const known = new Set(Object.keys(DEFAULT_PERMISSIONS));
  for (const key of Object.keys(permissions)) if (!known.has(key)) throw invalid(`permissions.${key} is not a known permission`);

  const result = { ...DEFAULT_PERMISSIONS };
  if (permissions.filesystem !== undefined) {
    if (!FILESYSTEM_LEVELS.includes(permissions.filesystem)) throw invalid(`permissions.filesystem must be one of ${FILESYSTEM_LEVELS.join(', ')}`);
    result.filesystem = permissions.filesystem;
  }
  for (const key of ['shell', 'network', 'git']) {
    if (permissions[key] === undefined) continue;
    if (typeof permissions[key] !== 'boolean') throw invalid(`permissions.${key} must be true or false`);
    result[key] = permissions[key];
  }
  // git is a use of the shell, so it cannot be granted on its own.
  if (result.git && !result.shell) throw invalid('permissions.git requires permissions.shell');
  return result;
}

function normalizeTimeout(timeout) {
  if (timeout === undefined || timeout === null) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS) throw invalid('timeout must be whole milliseconds from 1000 to 86400000');
  return timeout;
}

function normalizeEnvironment(environment) {
  if (environment === undefined || environment === null) return {};
  if (typeof environment !== 'object' || Array.isArray(environment)) throw invalid('environment must map names to string values');
  const entries = Object.entries(environment);
  if (entries.length > MAX_ENV_VARS) throw invalid(`environment may set at most ${MAX_ENV_VARS} variables`);
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) throw invalid(`environment.${name} is not a valid variable name`);
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE || value.includes('\0')) throw invalid(`environment.${name} must be a string without NUL characters, up to ${MAX_ENV_VALUE} characters`);
  }
  return Object.fromEntries(entries);
}

function normalizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid('metadata must be an object');
  if (JSON.stringify(metadata).length > 16 * 1024) throw invalid('metadata is larger than 16 KiB');
  return metadata;
}

function invalid(message) {
  return new CodingAgentError(message, 'invalid_task');
}
