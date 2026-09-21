import fs from 'node:fs';
import { buildDiagnostics } from './diagnostics.js';

const PACKAGE_PATH = new URL('../../package.json', import.meta.url);
const REQUIRED_TABLES = ['events', 'entities', 'facts', 'agent_actions', 'action_queue', 'action_attempts'];

export function buildBugBundle(dependencies = {}) {
  const { db } = dependencies;
  const diagnostics = buildDiagnostics(dependencies);
  return {
    bundleFormat: 'u2os-sanitized-debug-v1',
    generatedAt: new Date().toISOString(),
    application: {
      version: packageVersion(),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    configuration: {
      environmentOverrides: configuredFlags(),
      planner: safeDependency(diagnostics.model),
      embeddings: safeDependency(diagnostics.embeddings),
    },
    schema: schemaMetadata(db),
    health: {
      status: diagnostics.status,
      server: diagnostics.server,
      database: diagnostics.database,
      actions: diagnostics.actions,
      memory: diagnostics.memory,
      connectors: diagnostics.connectors,
      recentErrors: diagnostics.recentErrors,
    },
    failedOperations: failedOperations(db),
    exclusions: [
      'credentials and tokens',
      'configuration values and provider endpoints',
      'action arguments, results, and raw errors',
      'email, calendar, task, document, and memory content',
      'database files and full logs',
    ],
  };
}

function packageVersion() {
  try { return JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')).version || null; } catch { return null; }
}

function configuredFlags() {
  const names = ['U2OS_BIND', 'U2OS_PUBLIC_ORIGIN', 'U2OS_SECURE_COOKIES', 'U2OS_TRUST_PROXY', 'U2OS_BODY_LIMIT_BYTES', 'U2OS_MDNS'];
  return Object.fromEntries(names.map((name) => [name, Object.hasOwn(process.env, name)]));
}

function safeDependency(value = {}) {
  return {
    state: value.state || 'unavailable',
    configured: !!value.configured,
    provider: value.provider || null,
    destination: value.destination || null,
    ...(value.mode ? { mode: value.mode } : {}),
  };
}

function schemaMetadata(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  return {
    strategy: 'additive-startup-migrations',
    sqliteUserVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version || 0),
    tableCount: tables.length,
    missingRequiredTables: REQUIRED_TABLES.filter((name) => !tables.includes(name)),
  };
}

function failedOperations(db) {
  return db.prepare(`
    SELECT tool, status, attempt_count, error_class, created_at, updated_at
    FROM action_queue
    WHERE status IN ('retry_wait', 'failed', 'dead_letter')
    ORDER BY updated_at DESC
    LIMIT 50
  `).all().map((row) => ({
    tool: row.tool,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    errorClass: row.error_class || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
