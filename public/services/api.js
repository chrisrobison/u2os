// Thin REST client for the U2OS backend. Same-origin, no bundler --
// consumed directly as an ES module by components. Every function returns
// parsed JSON and throws an Error (using the response body's `error`
// message when present) on a non-2xx response.

const JSON_HEADERS = { 'Content-Type': 'application/json' };
let csrfToken = null;

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    options.headers = { ...(options.headers || {}), 'X-U2OS-CSRF': csrfToken };
  }
  const res = await fetch(path, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message = (body && body.error) || `${res.status} ${res.statusText}`;
    throw new Error(message);
  }

  return body;
}

export async function getAuthStatus() {
  const status = await request('/api/auth/status');
  csrfToken = status.csrfToken;
  return status;
}
export async function setupOwner(passphrase) {
  const result = await request('/api/auth/setup', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ passphrase }) });
  csrfToken = result.csrfToken; return result;
}
export async function login(passphrase) {
  const result = await request('/api/auth/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ passphrase }) });
  csrfToken = result.csrfToken; return result;
}
export async function logout() { const result = await request('/api/auth/logout', { method: 'POST' }); csrfToken = null; return result; }

function qs(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

export function getHealth() {
  return request('/api/health');
}

export function getCalendarEvents(range = 'upcoming') {
  return request(`/api/calendar/events${qs({ range })}`);
}

export function getDashboard() {
  return request('/api/dashboard/morning');
}

export function generateDashboard(context, params = {}) {
  return request('/api/dashboard/generate', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ context, params }),
  });
}

export function getTasks(status) {
  return request(`/api/tasks${qs({ status })}`);
}

export function createTask({ title, dueAt, relatedEntityId } = {}) {
  return request('/api/tasks', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ title, dueAt, relatedEntityId }),
  });
}

export function getEmails(folder = 'inbox') {
  return request(`/api/email${qs({ folder })}`);
}

export function getContacts(query) {
  return request(`/api/contacts${qs({ query })}`);
}

export function getMemoryEntities({ type, query } = {}) {
  return request(`/api/memory/entities${qs({ type, query })}`);
}

export function getMemoryEntity(id) {
  return request(`/api/memory/entities/${encodeURIComponent(id)}`);
}

export function getMemoryCandidates(status = 'pending') {
  return request(`/api/memory/candidates${qs({ status })}`);
}

export function acceptMemoryCandidate(id, payload) {
  return request(`/api/memory/candidates/${encodeURIComponent(id)}/accept`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) });
}

export function rejectMemoryCandidate(id) {
  return request(`/api/memory/candidates/${encodeURIComponent(id)}/reject`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}

export function sendAgentMessage(text) {
  return request('/api/agent/message', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  });
}

// Phase 4/5 voice entry point (docs/voice.md). `speaker` is
// `{ cluster, identity, confidence }` -- pass the Phase 4 stub or a real
// Phase 5 voiceprint-service result, either way. Response shape is
// identical to sendAgentMessage()'s, so callers render both the same way.
export function sendVoiceMessage(text, speaker) {
  return request('/api/agent/voice-message', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      text,
      // identity/confidence are display hints only. Authorization is based
      // on this observation vector, compared with enrollment by the server.
      voiceObservation: { vector: speaker?.observationVector || null },
    }),
  });
}

export function getVoiceEnrollment() {
  return request('/api/voice/enrollment');
}

export function saveVoiceEnrollment(vector) {
  return request('/api/voice/enrollment', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ vector }),
  });
}

export function deleteVoiceEnrollment() {
  return request('/api/voice/enrollment', { method: 'DELETE' });
}

export function getPendingActions() {
  return request('/api/actions/pending');
}

export function getAction(id) {
  return request(`/api/actions/${encodeURIComponent(id)}`);
}

export function approveAction(id) {
  return request(`/api/actions/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
}

export function rejectAction(id) {
  return request(`/api/actions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
}

export function getEvents({ type, since, correlationId, limit } = {}) {
  return request(`/api/events${qs({ type, since, correlationId, limit })}`);
}

export function getConnectors() {
  return request('/api/connectors');
}

export function saveGoogleCredentials({ clientId, clientSecret } = {}) {
  return request('/api/connectors/google/credentials', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ clientId, clientSecret }),
  });
}

export function saveWebSearchCredentials({ apiKey } = {}) {
  return request('/api/connectors/web-search/credentials', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ apiKey }),
  });
}

export function saveNotifyWebhookCredentials({ webhookUrl, format } = {}) {
  return request('/api/connectors/notify-webhook/credentials', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ webhookUrl, format }),
  });
}

export function disconnectGoogleService(service) {
  return request(`/api/connectors/google/disconnect${qs({ service })}`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });
}

export function setActiveProvider(domain, providerId) {
  return request(`/api/connectors/${encodeURIComponent(domain)}/active`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ providerId }),
  });
}

// Phase 4 (docs/devices.md): the /ws/devices realtime device bus' transport
// token. Session-gated like everything else here -- an unauthenticated
// caller can never learn it through the API.
export function getDeviceConnectToken() {
  return request('/api/devices/connect-token');
}

export function triggerSync(domain) {
  return request(`/api/connectors/${encodeURIComponent(domain)}/sync`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });
}
