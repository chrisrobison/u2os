// Composes dashboard schemas from live data (calendar/tasks/memory) for a
// requested context, instead of returning a fixed pre-baked payload per
// context. Every schema this module builds is run through
// validateDashboard() before generateDashboard() returns it -- per
// docs/dashboards.md, that is the one hard security boundary that must hold
// for every context, not just "morning".
//
// Per docs/connectors.md's "Task system" note, tasks are intentionally
// always-native (mock-tasks-provider.js directly), never behind
// provider-registry. Calendar goes through getProvider('calendar') so a
// connected real calendar is actually reflected here.
import { getProvider } from '../integrations/provider-registry.js';
import * as tasksProvider from '../integrations/mock-tasks-provider.js';
import { getEntity } from '../memory/entity-store.js';
import { getFacts } from '../memory/fact-store.js';
import { getRelationships } from '../memory/relationship-store.js';
import { listPendingActions } from '../policy/policy-engine.js';
import { validateDashboard } from '../api/dashboard-schema.js';
import { listRecommendations } from './recommendation-store.js';

const SUPPORTED_CONTEXTS = new Set(['morning', 'before-meeting', 'project']);

/** Thrown when a param (personId/projectId/...) doesn't resolve to a real
 * entity of the expected type -- the route maps this to a 404. */
export class DashboardNotFoundError extends Error {}

/** Thrown for an unknown context or missing/invalid params -- the route
 * maps this to a 400. */
export class InvalidDashboardContextError extends Error {}

/**
 * generateDashboard({ context, params }) -> a validated dashboard schema
 * (see docs/dashboards.md), built by reading real calendar/tasks/memory data
 * relevant to `context`/`params` -- not one of a fixed set of pre-baked
 * objects.
 */
export function generateDashboard({ context, params = {} } = {}) {
  if (!SUPPORTED_CONTEXTS.has(context)) {
    throw new InvalidDashboardContextError(
      `Unknown dashboard context: ${JSON.stringify(context)}. Supported: ${[...SUPPORTED_CONTEXTS].join(', ')}`
    );
  }

  let schema;
  switch (context) {
    case 'morning':
      schema = buildMorningDashboard();
      break;
    case 'before-meeting':
      schema = buildBeforeMeetingDashboard(params);
      break;
    case 'project':
      schema = buildProjectDashboard(params);
      break;
    default:
      // Unreachable -- guarded by SUPPORTED_CONTEXTS above.
      throw new InvalidDashboardContextError(`Unknown dashboard context: ${context}`);
  }

  validateDashboard(schema);
  return schema;
}

function buildMorningDashboard() {
  const now = new Date();
  const today = now.toDateString();

  const calendarProvider = getProvider('calendar');
  const todaysEvents = calendarProvider.listEvents({}).filter((e) => new Date(e.start_at).toDateString() === today);
  const priorityTasks = tasksProvider.listTasks({ status: 'open' }).slice(0, 5);
  const pendingActions = listPendingActions();
  const recommendations = listRecommendations({ status: 'open' }).slice(0, 5).filter((recommendation) => {
    if (!recommendation.dashboard) return true;
    try { return validateDashboard(recommendation.dashboard); } catch { return false; }
  });

  return {
    title: 'Morning Briefing',
    layout: 'dashboard',
    components: [
      { type: 'schedule', source: 'calendar.today', data: { events: todaysEvents } },
      { type: 'task-list', source: 'tasks.priority', data: { tasks: priorityTasks } },
      { type: 'approval', source: 'actions.pending', data: { actions: pendingActions } },
      ...recommendations.map((recommendation) => ({
        type: 'recommendation',
        source: 'recommendations.open',
        data: { recommendationId: recommendation.id },
      })),
    ],
  };
}

function buildBeforeMeetingDashboard({ personId } = {}) {
  if (!personId) {
    throw new InvalidDashboardContextError('before-meeting dashboard requires params.personId');
  }
  const person = getEntity(personId);
  if (!person || person.type !== 'Person') {
    throw new DashboardNotFoundError(`No such person: ${personId}`);
  }

  const calendarProvider = getProvider('calendar');
  const eventsWithPerson = calendarProvider.listEvents({}).filter((event) => eventHasAttendeeNamed(event, person.name));
  const relevantEvents = pickRelevantEvents(eventsWithPerson, 3);

  const openTasks = tasksProvider.listTasks({ status: 'open' }).filter((t) => t.related_entity_id === person.id);

  const facts = getFacts(person.id);
  const relationships = getRelationships(person.id);

  const components = [];

  if (relevantEvents.length) {
    components.push({ type: 'schedule', source: 'calendar.upcoming', data: { events: relevantEvents } });
  } else {
    components.push({
      type: 'alert',
      data: { variant: 'info', message: `No upcoming meetings scheduled with ${person.name}.` },
    });
  }

  components.push({ type: 'task-list', source: 'tasks.all', data: { tasks: openTasks } });

  components.push({
    type: 'person',
    data: {
      id: person.id,
      name: person.name,
      relationship: summarizeRelationships(relationships, person),
      facts: facts.slice(0, 5).map((fact) => ({ key: fact.key, value: fact.value, source: fact.source, classification: fact.classification, inferred: Boolean(fact.inferred) })),
      recentActivity: relevantEvents.slice(0, 3).map((event) => ({ label: event.title, at: event.start_at, source: 'calendar' })),
      commitments: relationships.filter((rel) => rel.relation === 'promised').slice(0, 5).map((rel) => ({ description: describeRelationship(rel, person), source: rel.source })),
      upcomingInteractions: relevantEvents.map((event) => ({ title: event.title, at: event.start_at })),
      provenance: { entityId: person.id },
    },
  });

  return {
    title: `Before your meeting with ${person.name}`,
    layout: 'dashboard',
    components,
  };
}

function buildProjectDashboard({ projectId } = {}) {
  if (!projectId) {
    throw new InvalidDashboardContextError('project dashboard requires params.projectId');
  }
  const project = getEntity(projectId);
  if (!project || project.type !== 'Project') {
    throw new DashboardNotFoundError(`No such project: ${projectId}`);
  }

  const openTasks = tasksProvider.listTasks({ status: 'open' }).filter((t) => t.related_entity_id === project.id);
  const relationships = getRelationships(project.id);

  const peopleIds = new Set();
  for (const rel of relationships) {
    if (rel.from_entity_id === project.id && rel.to_entity_id) peopleIds.add(rel.to_entity_id);
    if (rel.to_entity_id === project.id && rel.from_entity_id) peopleIds.add(rel.from_entity_id);
  }
  const people = [...peopleIds].map((id) => getEntity(id)).filter((e) => e && e.type === 'Person');

  const calendarProvider = getProvider('calendar');
  const linkedEvents = calendarProvider
    .listEvents({})
    .filter((event) => eventMentionsTitle(event, project.name) || people.some((p) => eventHasAttendeeNamed(event, p.name)));
  const relevantEvents = pickRelevantEvents(linkedEvents, 5);

  const components = [{ type: 'task-list', source: 'tasks.all', data: { tasks: openTasks } }];

  if (relevantEvents.length) {
    components.push({ type: 'schedule', source: 'calendar.upcoming', data: { events: relevantEvents } });
  }

  components.push({
    type: 'project',
    data: {
      id: project.id,
      name: project.name,
      status: project.attributes?.status || 'unknown',
      recentActivity: relevantEvents.slice(0, 5).map((event) => ({ label: event.title, at: event.start_at, source: 'calendar' })),
      openTasks: openTasks.slice(0, 10).map((task) => ({ title: task.title, dueAt: task.due_at, status: task.status })),
      people: people.slice(0, 10).map((person) => ({ id: person.id, name: person.name })),
      deadlines: openTasks.filter((task) => task.due_at).slice(0, 10).map((task) => ({ label: task.title, at: task.due_at })),
      unresolvedDecisions: openTasks.filter((task) => /decid|review|choose|approve/i.test(task.title)).slice(0, 10).map((task) => ({ label: task.title })),
      relatedDocuments: [],
      provenance: { entityId: project.id },
    },
  });

  if (!openTasks.length && !relevantEvents.length) {
    components.push({
      type: 'alert',
      data: { variant: 'warning', message: `No open tasks or upcoming events found for ${project.name} yet.` },
    });
  }

  return {
    title: `${project.name} — project briefing`,
    layout: 'dashboard',
    components,
  };
}

// Prefers the next `limit` events that haven't started yet (chronological
// order); if none are still upcoming (e.g. today's meeting already started
// or finished by the time this runs), falls back to the most recent past
// ones instead of coming up empty -- "before a meeting" should still show
// today's meeting with this person/project even if "now" has ticked past
// its start time.
function pickRelevantEvents(events, limit) {
  const now = Date.now();
  const sorted = [...events].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const upcoming = sorted.filter((e) => new Date(e.start_at).getTime() >= now);
  if (upcoming.length) return upcoming.slice(0, limit);
  return sorted.filter((e) => new Date(e.start_at).getTime() < now).slice(-limit);
}

function eventHasAttendeeNamed(event, name) {
  if (!name) return false;
  const needle = name.toLowerCase();
  return (event.attendees || []).some((a) => {
    const attendeeName = (a?.name || '').toLowerCase();
    return attendeeName && (attendeeName.includes(needle) || needle.includes(attendeeName));
  });
}

function eventMentionsTitle(event, name) {
  if (!name) return false;
  return (event.title || '').toLowerCase().includes(name.toLowerCase());
}

function summarizeRelationships(relationships, person) {
  const descriptions = relationships.map((rel) => describeRelationship(rel, person)).filter(Boolean).slice(0, 3);
  return descriptions.length ? descriptions.join('; ') : 'No relationship context recorded yet.';
}

function describeRelationship(rel, person) {
  const otherId = rel.from_entity_id === person.id ? rel.to_entity_id : rel.from_entity_id;
  if (!otherId) return null;
  const other = getEntity(otherId);
  const label = other ? other.name : otherId;
  const verb = rel.from_entity_id === person.id ? rel.relation.replace(/_/g, ' ') : `is ${rel.relation.replace(/_/g, ' ')} by`;
  return `${verb} ${label}`;
}
