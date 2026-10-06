// Turns a model provider failure into a short, fixed-vocabulary reason that is
// safe to show the owner. Raw error text is never passed through: provider
// responses and URLs can carry private payload text or credentials.
const NETWORK_CODES = {
  ECONNREFUSED: ['connection_refused', 'connection refused: nothing is listening at the configured endpoint'],
  ENOTFOUND: ['host_not_found', 'host not found: check the endpoint hostname'],
  EAI_AGAIN: ['host_not_found', 'host not found: check the endpoint hostname'],
  EHOSTUNREACH: ['host_unreachable', 'host unreachable: check the network and endpoint'],
  ENETUNREACH: ['host_unreachable', 'host unreachable: check the network and endpoint'],
  ECONNRESET: ['connection_reset', 'connection reset by the endpoint'],
  ETIMEDOUT: ['timeout', 'the endpoint did not answer in time'],
  UND_ERR_CONNECT_TIMEOUT: ['timeout', 'the endpoint did not answer in time'],
};

export function classifyModelFailure(error) {
  const seen = new Set();
  for (let e = error; e && typeof e === 'object' && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (NETWORK_CODES[e.code]) return reason(...NETWORK_CODES[e.code]);
  }
  const message = String(error?.message || '');
  if (/not signed in/i.test(message)) return reason('not_signed_in', 'the CLI tool is not signed in: run it once in a terminal as the account that runs U2OS (for example `grok login`, `codex login`, or `claude`)');
  if (/timed out/i.test(message)) return reason('timeout', 'the model did not answer in time');
  const http = /HTTP (\d{3})/.exec(message);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) return reason('unauthorized', `the endpoint rejected the credentials (HTTP ${status})`);
    if (status === 404) return reason('not_found', 'the endpoint or model name was not found (HTTP 404)');
    if (status === 429) return reason('rate_limited', 'the endpoint is rate limiting requests (HTTP 429)');
    return reason('http_error', `the endpoint returned HTTP ${status}`);
  }
  if (/no plan content|invalid JSON|invalid plan/i.test(message)) return reason('invalid_response', 'the model returned something that is not a valid plan');
  return reason('error', 'the model call failed');
}

function reason(code, text) { return { code, text }; }
