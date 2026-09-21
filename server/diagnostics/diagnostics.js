import fs from 'node:fs';
import { getHealth as getConnectorHealth } from '../integrations/provider-registry.js';
import { getRecentLogEntries } from '../logging/logger.js';

export function buildDiagnostics({ db, dbPath, dataDir, startTime, sseHub, modelRouter, embeddingProvider } = {}) {
  const queueCounts = groupedCounts(db, 'action_queue', 'status');
  const pendingActions = scalar(db, "SELECT COUNT(*) AS count FROM agent_actions WHERE status = 'pending'");
  const connectors = getConnectorHealth({ dataDir }).map((entry) => ({
    domain: entry.domain,
    provider: entry.active,
    state: entry.connected ? 'healthy' : 'unavailable',
    mode: entry.active === 'mock' ? 'mock' : 'real',
    lastSuccessfulSync: entry.lastSyncAt,
    hasRecentError: !!entry.lastError,
  }));
  const model = modelStatus(modelRouter, 'planner');
  const embeddings = embeddingProvider
    ? { state: 'healthy', configured: true, provider: embeddingProvider.id || 'configured', destination: embeddingProvider.destination || 'configured_remote_model' }
    : { state: 'unavailable', configured: false, provider: null, destination: null };
  const recentErrors = getRecentLogEntries({ limit: 20 });
  const degraded = connectors.some((entry) => entry.state !== 'healthy')
    || model.state !== 'healthy'
    || (queueCounts.dead_letter || 0) > 0
    || recentErrors.some((entry) => entry.level === 'error');

  return {
    status: degraded ? 'degraded' : 'healthy',
    generatedAt: new Date().toISOString(),
    server: {
      uptimeSeconds: Math.max(0, Math.round((Date.now() - startTime) / 1000)),
      sseClientCount: sseHub?.clientCount || 0,
    },
    database: {
      state: 'healthy',
      sizeBytes: databaseSize(dbPath),
      eventCount: scalar(db, 'SELECT COUNT(*) AS count FROM events'),
    },
    actions: {
      pendingApproval: pendingActions,
      queued: sum(queueCounts, ['queued', 'leased', 'executing']),
      retrying: queueCounts.retry_wait || 0,
      failed: queueCounts.failed || 0,
      deadLetters: queueCounts.dead_letter || 0,
      completed: queueCounts.completed || 0,
    },
    connectors,
    model,
    embeddings,
    memory: {
      entities: scalar(db, "SELECT COUNT(*) AS count FROM entities WHERE status = 'active'"),
      facts: scalar(db, "SELECT COUNT(*) AS count FROM facts WHERE status = 'current'"),
    },
    recentErrors,
  };
}

function modelStatus(modelRouter, role) {
  try {
    const provider = modelRouter?.resolve(role);
    if (!provider) return { state: 'unavailable', configured: false, provider: null, destination: null };
    const mock = String(provider.id || '').startsWith('mock');
    return {
      state: mock ? 'degraded' : 'healthy',
      configured: true,
      provider: provider.id || 'configured',
      destination: provider.destination || (mock ? 'local_model' : 'configured_remote_model'),
      mode: mock ? 'mock' : 'real',
    };
  } catch {
    return { state: 'unavailable', configured: false, provider: null, destination: null };
  }
}

function groupedCounts(db, table, column) {
  const rows = db.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all();
  return Object.fromEntries(rows.map((row) => [row.value, Number(row.count)]));
}

function scalar(db, sql) {
  return Number(db.prepare(sql).get()?.count || 0);
}

function sum(counts, keys) {
  return keys.reduce((total, key) => total + (counts[key] || 0), 0);
}

function databaseSize(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, file) => {
    try { return total + fs.statSync(file).size; } catch { return total; }
  }, 0);
}
