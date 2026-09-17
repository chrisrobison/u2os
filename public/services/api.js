// Thin REST client for the U2OS backend. Same-origin, no bundler --
// consumed directly as an ES module by components. Every function returns
// parsed JSON and throws an Error (using the response body's `error`
// message when present) on a non-2xx response.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request(path, options = {}) {
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

export function sendAgentMessage(text, actorId) {
  return request('/api/agent/message', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ text, actorId }),
  });
}

export function getPendingActions() {
  return request('/api/actions/pending');
}

export function getAction(id) {
  return request(`/api/actions/${encodeURIComponent(id)}`);
}

export function approveAction(id, approvedBy = 'user') {
  return request(`/api/actions/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ approvedBy }),
  });
}

export function rejectAction(id, rejectedBy = 'user') {
  return request(`/api/actions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ rejectedBy }),
  });
}

export function getEvents({ type, since, correlationId, limit } = {}) {
  return request(`/api/events${qs({ type, since, correlationId, limit })}`);
}
