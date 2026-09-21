// One auditable server-side registry for every named dashboard source.
// Resolvers read local synchronized stores only: rendering a dashboard must
// never make the browser choose an endpoint or cause an unbounded network
// request. Context planners may apply a bounded predicate after resolution,
// but they cannot introduce new source/data-access behavior.
import { getDb } from '../db/connection.js';
import * as tasksProvider from '../integrations/mock-tasks-provider.js';
import * as emailProvider from '../integrations/mock-email-provider.js';
import { listPendingActions } from '../policy/policy-engine.js';
import { listEvents } from '../events/log.js';
import { listRecommendations } from './recommendation-store.js';

const MAX_ITEMS = 50;

const resolvers = {
  'calendar.today': () => calendarRows().filter((event) => new Date(event.start_at).toDateString() === new Date().toDateString()),
  'calendar.upcoming': () => calendarRows(),
  'tasks.priority': () => tasksProvider.listTasks({ status: 'open' }).slice(0, 5),
  'tasks.all': () => tasksProvider.listTasks({ status: 'open' }),
  'email.important': () => emailProvider.searchEmails({ folder: 'inbox' }).filter((email) => !email.is_read).slice(0, 10),
  'email.unread': () => emailProvider.searchEmails({ folder: 'inbox' }).filter((email) => !email.is_read),
  'actions.pending': () => listPendingActions(),
  'events.recent': () => listEvents(getDb(), { limit: 20 }),
  'recommendations.open': () => listRecommendations({ status: 'open' }),
};

export const DASHBOARD_SOURCES = Object.freeze(Object.keys(resolvers));

export function resolveDashboardSource(source, { filter, limit = MAX_ITEMS } = {}) {
  const resolver = resolvers[source];
  if (!resolver) throw new Error(`Unknown dashboard source: ${source}`);
  const numericLimit = Number(limit);
  const boundedLimit = Number.isFinite(numericLimit) ? Math.max(0, Math.min(numericLimit, MAX_ITEMS)) : MAX_ITEMS;
  const values = resolver();
  const filtered = typeof filter === 'function' ? values.filter(filter) : values;
  return filtered.slice(0, boundedLimit);
}

function calendarRows() {
  return getDb().prepare('SELECT * FROM calendar_events ORDER BY start_at ASC').all().map((row) => ({
    ...row,
    attendees: JSON.parse(row.attendees || '[]'),
  }));
}
