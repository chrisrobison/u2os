// Composes dashboard schemas from live data (calendar/tasks/memory) for a
// requested context, instead of returning a fixed pre-baked payload per
// context. Every schema this module builds is run through
// validateDashboard() before generateDashboard() returns it -- per
// docs/dashboards.md, that is the one hard security boundary that must hold
// for every context, not just "morning".
//
// Named component sources are resolved server-side from bounded local stores
// through dashboard-source-resolver.js. Browser clients only render the
// validated data embedded in the schema.
import { getEntity } from '../memory/entity-store.js';
import { getFacts } from '../memory/fact-store.js';
import { getRelationships } from '../memory/relationship-store.js';
import { validateDashboard } from '../api/dashboard-schema.js';
import { resolveDashboardSource } from './dashboard-source-resolver.js';

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
  const todaysEvents = resolveDashboardSource('calendar.today');
  const priorityTasks = resolveDashboardSource('tasks.priority');
  const pendingActions = resolveDashboardSource('actions.pending');
  const recommendations = resolveDashboardSource('recommendations.open', { limit: 5 }).filter((recommendation) => {
    if (!recommendation.dashboard) return true;
    try { return validateDashboard(recommendation.dashboard); } catch { return false; }
  });

  return {
    title: 'Morning Briefing',
    layout: 'dashboard',
    components: [
      withProvenance({ type: 'schedule', source: 'calendar.today', data: { events: todaysEvents } },
        'Shows calendar events scheduled for today.', sourceReferences('calendar.today', 'calendar_event', todaysEvents)),
      withProvenance({ type: 'task-list', source: 'tasks.priority', data: { tasks: priorityTasks } },
        'Shows the highest-priority open tasks.', sourceReferences('tasks.priority', 'task', priorityTasks)),
      withProvenance({ type: 'approval', source: 'actions.pending', data: { actions: pendingActions } },
        'Shows consequential actions waiting for owner approval.', sourceReferences('actions.pending', 'action', pendingActions)),
      ...recommendations.map((recommendation) => ({
        type: 'recommendation',
        source: 'recommendations.open',
        data: { recommendationId: recommendation.id },
        provenance: {
          reason: 'Shows an open recommendation prepared by the agent.',
          references: [{ type: 'recommendation', id: recommendation.id, label: boundedLabel(recommendation.reasoning_summary || recommendation.decision) }],
        },
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

  const eventsWithPerson = resolveDashboardSource('calendar.upcoming', {
    filter: (event) => eventHasAttendeeNamed(event, person.name),
  });
  const relevantEvents = pickRelevantEvents(eventsWithPerson, 3);

  const openTasks = resolveDashboardSource('tasks.all', { filter: (task) => task.related_entity_id === person.id });

  const facts = getFacts(person.id);
  const relationships = getRelationships(person.id);

  const components = [];

  if (relevantEvents.length) {
    components.push(withProvenance({ type: 'schedule', source: 'calendar.upcoming', data: { events: relevantEvents } },
      `Shows meetings whose attendee list includes ${person.name}.`, sourceReferences('calendar.upcoming', 'calendar_event', relevantEvents)));
  } else {
    components.push(withProvenance({
      type: 'alert',
      data: { variant: 'info', message: `No upcoming meetings scheduled with ${person.name}.` },
    }, `No matching calendar event was found for ${person.name}.`, [{ type: 'entity', id: person.id, label: person.name }]));
  }

  components.push(withProvenance({ type: 'task-list', source: 'tasks.all', data: { tasks: openTasks } },
    `Shows open tasks linked to ${person.name}.`, sourceReferences('tasks.all', 'task', openTasks, [{ type: 'entity', id: person.id, label: person.name }])));

  components.push(withProvenance({
    type: 'person',
    data: {
      id: person.id,
      name: person.name,
      relationship: summarizeRelationships(relationships, person),
      facts: facts.slice(0, 5).map((fact) => ({ key: fact.key, value: fact.value, source: fact.source, classification: fact.classification, inferred: Boolean(fact.inferred) })),
      recentActivity: relevantEvents.slice(0, 3).map((event) => ({ label: event.title, at: event.start_at, source: 'calendar' })),
      commitments: relationships.filter((rel) => rel.relation === 'promised').slice(0, 5).map((rel) => ({ description: describeRelationship(rel, person), source: rel.source })),
      upcomingInteractions: relevantEvents.map((event) => ({ title: event.title, at: event.start_at })),
    },
  }, `Summarizes stored context relevant to ${person.name}.`, [
    { type: 'entity', id: person.id, label: person.name },
    ...facts.slice(0, 5).map((fact) => ({ type: 'fact', id: fact.id, label: fact.key })),
    ...relationships.slice(0, 4).map((relationship) => ({ type: 'relationship', id: relationship.id, label: relationship.relation })),
  ]));

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

  const openTasks = resolveDashboardSource('tasks.all', { filter: (task) => task.related_entity_id === project.id });
  const relationships = getRelationships(project.id);

  const peopleIds = new Set();
  for (const rel of relationships) {
    if (rel.from_entity_id === project.id && rel.to_entity_id) peopleIds.add(rel.to_entity_id);
    if (rel.to_entity_id === project.id && rel.from_entity_id) peopleIds.add(rel.from_entity_id);
  }
  const people = [...peopleIds].map((id) => getEntity(id)).filter((e) => e && e.type === 'Person');

  const linkedEvents = resolveDashboardSource('calendar.upcoming', {
    filter: (event) => eventMentionsTitle(event, project.name) || people.some((p) => eventHasAttendeeNamed(event, p.name)),
  });
  const relevantEvents = pickRelevantEvents(linkedEvents, 5);

  const components = [withProvenance({ type: 'task-list', source: 'tasks.all', data: { tasks: openTasks } },
    `Shows open tasks linked to ${project.name}.`, sourceReferences('tasks.all', 'task', openTasks, [{ type: 'entity', id: project.id, label: project.name }]))];

  if (relevantEvents.length) {
    components.push(withProvenance({ type: 'schedule', source: 'calendar.upcoming', data: { events: relevantEvents } },
      `Shows meetings that mention ${project.name} or include linked people.`, sourceReferences('calendar.upcoming', 'calendar_event', relevantEvents, [{ type: 'entity', id: project.id, label: project.name }])));
  }

  components.push(withProvenance({
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
    },
  }, `Summarizes stored work and relationships for ${project.name}.`, [
    { type: 'entity', id: project.id, label: project.name },
    ...relationships.slice(0, 5).map((relationship) => ({ type: 'relationship', id: relationship.id, label: relationship.relation })),
    ...people.slice(0, 4).map((person) => ({ type: 'entity', id: person.id, label: person.name })),
  ]));

  if (!openTasks.length && !relevantEvents.length) {
    components.push(withProvenance({
      type: 'alert',
      data: { variant: 'warning', message: `No open tasks or upcoming events found for ${project.name} yet.` },
    }, `No matching task or calendar records were found for ${project.name}.`, [{ type: 'entity', id: project.id, label: project.name }]));
  }

  return {
    title: `${project.name} — project briefing`,
    layout: 'dashboard',
    components,
  };
}

function withProvenance(component, reason, references) {
  return { ...component, provenance: { reason, references: references.slice(0, 10) } };
}

function sourceReferences(source, type, records, additional = []) {
  return [
    { type: 'source', id: source, label: source },
    ...additional,
    ...records.map((record) => ({ type, id: record.id, label: boundedLabel(record.title || record.subject || record.tool || record.id) })),
  ].slice(0, 10);
}

function boundedLabel(value) {
  return String(value || '').slice(0, 500);
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
