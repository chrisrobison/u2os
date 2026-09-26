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

export function getModelStatus() {
  return request('/api/model');
}

export function listGoalDrafts() {
  return request('/api/goals');
}

export function getGoalDraft(id) {
  return request(`/api/goals/${encodeURIComponent(id)}`);
}

export function createGoalDraft(payload) {
  return request('/api/goals', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) });
}

export function updateGoalDraft(id, payload) {
  return request(`/api/goals/${encodeURIComponent(id)}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(payload) });
}

export function runGoalOnce(id) {
  return request(`/api/goals/${encodeURIComponent(id)}/runs`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}

export function getGoalRunEvidence(goalId, runId) {
  return request(`/api/goals/${encodeURIComponent(goalId)}/runs/${encodeURIComponent(runId)}`);
}

export function saveConnectorConfig(endpoint, values) {
  return request(endpoint, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(values) });
}

export function runConnectorAction(endpoint) {
  return request(endpoint, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}

export function getDiagnostics() {
  return request('/api/diagnostics');
}

export function createBugBundle() {
  return request('/api/diagnostics/bug-bundle', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  });
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

export function getMemoryEntityDeletionPreview(id) {
  return request(`/api/memory/entities/${encodeURIComponent(id)}/deletion-preview`);
}

export function deleteMemoryEntity(id, previewToken) {
  return request(`/api/memory/entities/${encodeURIComponent(id)}`, { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ previewToken }) });
}

export function deleteMemoryRelationship(id) {
  return request(`/api/memory/relationships/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

export function confirmMemoryFact(id) {
  return request(`/api/memory/facts/${encodeURIComponent(id)}/confirm`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}

export function updateMemoryFact(id, payload) {
  return request(`/api/memory/facts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(payload) });
}

export function deleteMemoryFact(id) {
  return request(`/api/memory/facts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function createConversation() {
  return request('/api/agent/conversations', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}

export function listConversations() {
  return request('/api/agent/conversations');
}

export function getConversationTurns(id) {
  return request(`/api/agent/conversations/${encodeURIComponent(id)}/turns`);
}

export function sendAgentMessage(text, conversationId) {
  return request('/api/agent/message', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ text, conversationId }),
  });
}

// Phase 4/5 voice entry point (docs/voice.md). `speaker` is
// `{ cluster, identity, confidence }` -- pass the Phase 4 stub or a real
// Phase 5 voiceprint-service result, either way. Response shape is
// identical to sendAgentMessage()'s, so callers render both the same way.
export function sendVoiceMessage(text, speaker, conversationId) {
  return request('/api/agent/voice-message', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      text,
      conversationId,
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

export function getActionOperations() {
  return request('/api/actions/operations');
}

export function getAction(id) {
  return request(`/api/actions/${encodeURIComponent(id)}`);
}

export function getActionExplanation(id) {
  return request(`/api/actions/${encodeURIComponent(id)}/explain`);
}

export function getRecommendationExplanation(id) {
  return request(`/api/recommendations/${encodeURIComponent(id)}/explain`);
}

export function getRecommendation(id) {
  return request(`/api/recommendations/${encodeURIComponent(id)}`);
}

export function updateRecommendation(id, status) {
  return request(`/api/recommendations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });
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

export function getEvents({ type, since, correlationId, subjectType, subjectId, limit } = {}) {
  return request(`/api/events${qs({ type, since, correlationId, subjectType, subjectId, limit })}`);
}

export function getConnectors() {
  return request('/api/connectors');
}

export function getTriggers() {
  return request('/api/triggers');
}

export function getTriggerHistory(id, limit = 20) {
  return request(`/api/triggers/${encodeURIComponent(id)}/history${qs({ limit })}`);
}

export function dryRunTrigger(id) {
  return request(`/api/triggers/${encodeURIComponent(id)}/dry-run`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}

export function createTrigger({ name, kind, config, enabled = true }) {
  return request('/api/triggers', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, kind, config, enabled }),
  });
}

export function updateTrigger(id, patch) {
  return request(`/api/triggers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function deleteTrigger(id) {
  return request(`/api/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function saveGoogleCredentials({ clientId, clientSecret } = {}) {
  return request('/api/connectors/google/credentials', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ clientId, clientSecret }),
  });
}

// issue #163 PR 5: saveWebSearchCredentials/saveImapCredentials/
// disconnectImap/
// saveNotifyWebhookCredentials wrapped the now-removed legacy single-account
// credential routes -- every connector that can have more than one account
// (imap, SMTP, brave-search/web-search, webhook) is configured through the
// connection-instance wrappers below instead.

export function disconnectGoogleService(service) {
  return request(`/api/connectors/google/disconnect${qs({ service })}`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });
}

// Instance-scoped counterpart of disconnectGoogleService(): disconnects one
// specific google account's service, independent of whichever instance (if
// any) is the domain's current active one -- see server/api/routes/
// connectors.js's matching route comment.
export function disconnectGoogleInstanceService(instanceId, service) {
  return request(`/api/connectors/google/instances/${encodeURIComponent(instanceId)}/disconnect${qs({ service })}`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });
}

export function setActiveProvider(domain, providerId, { connectorId, instanceId } = {}) {
  const body = connectorId && instanceId ? { providerId, connectorId, instanceId } : { providerId };
  return request(`/api/connectors/${encodeURIComponent(domain)}/active`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

// Connection-instance CRUD (issue #163 PR 2/5): multiple accounts per
// connector. Mirrors server/api/routes/connectors.js's
// /api/connectors/:connectorId/instances routes.
export function listConnectorInstances(connectorId) {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/instances`);
}

export function associateImapSmtp(imapInstanceId, smtpInstanceId) {
  return request(`/api/connectors/imap/instances/${encodeURIComponent(imapInstanceId)}/smtp`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ smtpInstanceId }),
  });
}

export function createConnectorInstance(connectorId, data = {}) {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/instances`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
}

export function updateConnectorInstance(connectorId, instanceId, data = {}) {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/instances/${encodeURIComponent(instanceId)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
}

export function deleteConnectorInstance(connectorId, instanceId) {
  return request(`/api/connectors/${encodeURIComponent(connectorId)}/instances/${encodeURIComponent(instanceId)}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  });
}

// Phase 4 (docs/devices.md): the /ws/devices realtime device bus' transport
// token. Session-gated like everything else here -- an unauthenticated
// caller can never learn it through the API.
export function getDeviceConnectToken() {
  return request('/api/devices/connect-token');
}

// Phase 6 (docs/devices.md): device management UI.
export function getDevices(filters = {}) {
  return request(`/api/devices${qs(filters)}`);
}

export function getDevice(id) {
  return request(`/api/devices/${encodeURIComponent(id)}`);
}

export function updateDevice(id, { name, location, owner } = {}) {
  return request(`/api/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, location, owner }),
  });
}

export function setDeviceTrust(id, trust) {
  return request(`/api/devices/${encodeURIComponent(id)}/trust`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ trust }),
  });
}

export function deleteDevice(id) {
  return request(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function testDeviceCapability(id, capability, args = {}) {
  return request(`/api/devices/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ capability, args }),
  });
}

export function getCapabilities() {
  return request('/api/capabilities');
}

export function triggerSync(domain) {
  return request(`/api/connectors/${encodeURIComponent(domain)}/sync`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });
}
