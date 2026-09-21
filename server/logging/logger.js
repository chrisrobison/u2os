// Structured logger. Per docs/deployment.md §6.
//
// Two output modes:
//  - human-readable (default) -- for interactive `npm start`/`npm run dev`.
//  - single-line JSON (LOG_FORMAT=json) -- the sane default inside
//    Docker/systemd, where log aggregators expect parseable structured
//    lines rather than free text.
//
// Deliberately tiny: three levels (info/warn/error), no transports, no
// buffering -- this app logs straight to stdout/stderr and lets the
// platform (docker logs, journalctl, launchd's StandardOutPath) handle
// storage/rotation.
//
// This module intentionally replaces only the call sites named in
// docs/deployment.md §6 (server/index.js's startup banner + HTTP access
// log, provider-registry.js's warn-once fallback, sync-scheduler.js's sync
// error handling) -- it is not a repo-wide console.* sweep.

const RECENT_LIMIT = 50;
const recent = [];

function isJsonFormat() {
  return process.env.LOG_FORMAT === 'json';
}

function formatPretty(timestamp, level, component, message, fields) {
  const entries = Object.entries(fields);
  const fieldsStr = entries.length
    ? ' ' +
      entries
        .map(([key, value]) => {
          const rendered = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
          return `${key}=${rendered}`;
        })
        .join(' ')
    : '';
  return `${timestamp} ${level.toUpperCase().padEnd(5)} [${component}] ${message}${fieldsStr}`;
}

function formatJson(timestamp, level, component, message, fields) {
  return JSON.stringify({ timestamp, level, component, message, ...fields });
}

function write(level, component, message, fields = {}) {
  const timestamp = new Date().toISOString();
  if (level === 'warn' || level === 'error') {
    // Diagnostics keeps only the static summary, never arbitrary fields:
    // provider errors, URLs, ids, and request paths can contain owner data.
    recent.push({
      timestamp,
      level,
      component,
      message: level === 'error' ? 'An error was reported' : 'A warning was reported',
    });
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  }
  const line = isJsonFormat()
    ? formatJson(timestamp, level, component, message, fields)
    : formatPretty(timestamp, level, component, message, fields);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function getRecentLogEntries({ limit = 20 } = {}) {
  const bounded = Math.max(0, Math.min(Number(limit) || 0, RECENT_LIMIT));
  return recent.slice(-bounded).map((entry) => ({ ...entry }));
}

export function clearRecentLogEntriesForTests() {
  recent.length = 0;
}

export const log = {
  /** log.info(component, message, fields?) */
  info(component, message, fields) {
    write('info', component, message, fields);
  },
  /** log.warn(component, message, fields?) */
  warn(component, message, fields) {
    write('warn', component, message, fields);
  },
  /** log.error(component, message, fields?) */
  error(component, message, fields) {
    write('error', component, message, fields);
  },
};
