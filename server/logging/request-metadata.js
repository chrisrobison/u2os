const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Only code-defined route templates/fixed labels, never request URLs,
 * dynamic path parameters, query values, headers, bodies or raw errors.
 * routeLogPath is assigned by the trusted router/static dispatcher. */
export function requestLogMetadata(req) {
  return { method: METHODS.has(req.method) ? req.method : '[unknown-method]',
    path: req.routeLogPath || '[unmatched]' };
}
