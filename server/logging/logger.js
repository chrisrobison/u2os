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
