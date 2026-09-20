import { getDb } from '../db/connection.js';
import { findEntities, getEntity } from '../memory/entity-store.js';
import { getFacts } from '../memory/fact-store.js';
import { getRelationships } from '../memory/relationship-store.js';
import { listEvents } from '../events/log.js';
import { rankFactsHybrid } from '../memory/semantic-retrieval.js';
import { getEmail } from '../integrations/mock-email-provider.js';
import { getCachedCalendarEvent } from '../integrations/calendar-store.js';
import { getTask } from '../integrations/mock-tasks-provider.js';

const DEFAULTS = {
  maxChars: 6000,
  maxPeople: 5,
  maxFactsPerPerson: 5,
  maxCommitments: 10,
  maxRecentEvents: 15,
};

// Event types worth summarizing into "what's been happening" context. Kept
// as an explicit allowlist, not "everything in the log", so a provider
// never receives raw internal bookkeeping noise (agent_actions audit
// chatter) or an unbounded/undescribed event payload.
const CONTEXT_WORTHY_EVENT_TYPES = [
  'calendar.event_added',
  'calendar.event_changed',
  'calendar.event_approaching',
  'email.received',
  'email.sent',
  'task.created',
  'task.completed',
  'task.overdue',
  'commitment.made',
  'contact.birthday_approaching',
];

/**
 * ContextAssembler: gathers BOUNDED, RANKED, PROVENANCE-TAGGED personal
 * context for a single planning request, plus the minimal plumbing
 * (toolRegistry/eventBus/correlationId/actor) a ModelProvider needs.
 *
 * This deliberately does NOT dump the database into the prompt: it ranks
 * candidates with simple, explainable heuristics (does the objective
 * mention this person by name? how recently were they active? is this
 * commitment still open?) rather than semantic search -- true semantic
 * retrieval is later work (PLAN.md's embeddings/semantic-memory phase);
 * this assembler is written so that phase can slot in as an additional
 * ranking signal without changing its output shape.
 *
 * Every included item carries its own id (factId/entityId/relationshipId/
 * eventId) so a caller can explain "why was this included" later --
 * `provenanceRefs` collects them into one flat list for convenience.
 *
 * A token/character budget is enforced by dropping whole low-priority
 * items (never by truncating serialized JSON mid-string) until the
 * assembled context fits, per PLAN.md Phase 4's "prefer dropping
 * low-ranked context instead of truncating arbitrary serialized JSON."
 */
export class ContextAssembler {
  constructor({ toolRegistry, eventBus, ownerEntityId = null, embeddingProvider = null, ...options } = {}) {
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.ownerEntityId = ownerEntityId;
    // Optional (PLAN.md Phase 5): when configured, fact ranking within each
    // person blends semantic similarity in with confidence/recency/exact-word
    // overlap (server/memory/semantic-retrieval.js). Entirely absent by
    // default -- ranking then falls back to the Phase 4 confidence+recency
    // heuristic, unchanged.
    this.embeddingProvider = embeddingProvider;
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * @returns {Promise<{toolRegistry: object, eventBus: object, correlationId: string, actor: object, personalContext: object}>}
   */
  async assemble({ correlationId, actor, objective = '' } = {}) {
    return {
      toolRegistry: this.toolRegistry,
      eventBus: this.eventBus,
      correlationId,
      actor,
      personalContext: await this.assemblePersonalContext(objective),
    };
  }

  /**
   * The bounded personal-context object on its own, independent of the
   * toolRegistry/eventBus plumbing -- exposed separately so it can be
   * inspected/tested (and later reused by other model roles, e.g. a
   * classifier or summarizer, that don't need the planning plumbing).
   * Async because semantic fact ranking may call an embedding provider;
   * with none configured this still resolves promptly (no network calls).
   */
  async assemblePersonalContext(objective = '') {
    const objectiveLower = String(objective || '').toLowerCase();

    const context = {
      objective: String(objective || ''),
      currentTime: new Date().toISOString(),
      relevantPeople: await this._rankPeople(objectiveLower, objective),
      commitments: this._rankCommitments(objectiveLower),
      recentEvents: this._recentEvents(),
      truncated: false,
    };

    // provenanceRefs is derived from whatever survives budgeting below --
    // computed fresh each fit-loop iteration (see _fitBudget) so it never
    // claims an item as "used context" that was actually dropped for space,
    // and is recomputed once more for the final result.
    return this._fitBudget(context);
  }

  // --- people + facts + relationships -------------------------------------

  async _rankPeople(objectiveLower, objectiveRaw) {
    const people = findEntities({ type: 'Person' });
    const ranked = people
      .map((person) => {
        const nameLower = String(person.name || '').toLowerCase();
        // Match on any individual name word ("Sarah" out of "Sarah Chen"),
        // not just the full name -- people are usually referred to by first
        // name alone. Filters out 1-character words to avoid noise.
        const nameMentioned = nameLower.split(/\s+/).some((word) => word.length > 1 && objectiveLower.includes(word));
        const facts = getFacts(person.id);
        const relationships = getRelationships(person.id);
        const lastActivityAt = latestTimestamp([person.updated_at, ...facts.map((f) => f.created_at), ...relationships.map((r) => r.created_at)]);
        return { person, nameMentioned, facts, relationships, lastActivityAt };
      })
      .sort((a, b) => {
        if (a.nameMentioned !== b.nameMentioned) return a.nameMentioned ? -1 : 1;
        return (b.lastActivityAt || '').localeCompare(a.lastActivityAt || '');
      })
      .slice(0, this.options.maxPeople);

    const results = [];
    for (const { person, nameMentioned, facts, relationships } of ranked) {
      results.push({
        id: person.id,
        name: person.name,
        matchedOn: nameMentioned ? 'objective mentions this name' : 'recently active',
        facts: await this._rankFacts(facts, objectiveRaw),
        relationshipCount: relationships.length,
        classification: person.classification || 'personal',
      });
    }
    return results;
  }

  // Confidence+recency by default; blends in semantic similarity (and an
  // exact-word-overlap signal, and an inferred-fact penalty) when an
  // embeddingProvider is configured -- see server/memory/semantic-retrieval.js.
  async _rankFacts(facts, objectiveRaw) {
    const normalized = facts.map((f) => ({
      id: f.id,
      key: f.key,
      value: f.value,
      confidence: f.confidence,
      inferred: f.inferred,
      source: f.source,
      observedAt: f.observed_at,
      lastConfirmedAt: f.last_confirmed_at,
      classification: f.classification || 'personal',
    }));

    let ranked;
    let relevanceById = null;
    if (this.embeddingProvider) {
      const hybrid = await rankFactsHybrid({ facts: normalized, query: objectiveRaw, embeddingProvider: this.embeddingProvider });
      ranked = hybrid;
      relevanceById = new Map(hybrid.map((f) => [f.id, f._relevance]));
    } else {
      ranked = normalized.slice().sort((a, b) => b.confidence - a.confidence || (b.observedAt || '').localeCompare(a.observedAt || ''));
    }

    return ranked.slice(0, this.options.maxFactsPerPerson).map((f) => ({
      factId: f.id,
      key: f.key,
      value: f.value,
      confidence: f.confidence,
      inferred: f.inferred,
      source: f.source,
      observedAt: f.observedAt,
      lastConfirmedAt: f.lastConfirmedAt,
      classification: f.classification,
      ...(relevanceById ? { relevance: relevanceById.get(f.id) } : {}),
    }));
  }

  // --- commitments ----------------------------------------------------------

  _rankCommitments(objectiveLower) {
    if (!this.ownerEntityId) return [];
    const promises = getRelationships(this.ownerEntityId).filter((r) => r.relation === 'promised' && r.from_entity_id === this.ownerEntityId);

    const open = promises
      .map((rel) => {
        const commitment = rel.to_entity_id ? getEntity(rel.to_entity_id) : null;
        return commitment && commitment.attributes?.status === 'open' ? { commitment, rel } : null;
      })
      .filter(Boolean)
      .map(({ commitment, rel }) => {
        const description = String(commitment.attributes?.description || commitment.name || '');
        return {
          id: commitment.id,
          relationshipId: rel.id,
          description,
          mentioned: sharesASignificantWord(objectiveLower, description.toLowerCase()),
          createdAt: commitment.created_at,
          confidence: rel.confidence,
          inferred: rel.inferred,
          // Sourced from the `promised` relationship row itself (issue #3) --
          // commitments are relationships, not a separate table, so the
          // relationship's own classification column is the deterministic
          // source, never the model.
          classification: rel.classification || 'personal',
        };
      })
      .sort((a, b) => {
        if (a.mentioned !== b.mentioned) return a.mentioned ? -1 : 1;
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      })
      .slice(0, this.options.maxCommitments);

    return open.map(({ mentioned: _mentioned, ...rest }) => rest);
  }

  // --- recent events ----------------------------------------------------------

  _recentEvents() {
    const db = getDb();
    const events = [];
    for (const type of CONTEXT_WORTHY_EVENT_TYPES) {
      events.push(...listEvents(db, { type, limit: this.options.maxRecentEvents }));
    }
    return events
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      .slice(0, this.options.maxRecentEvents)
      .map((event) => ({
        eventId: event.id,
        type: event.type,
        timestamp: event.timestamp,
        summary: summarizeEvent(event),
        classification: classificationForEvent(event),
      }));
  }

  // --- budget -----------------------------------------------------------------

  _fitBudget(context) {
    let truncated = false;
    const sizeOf = () => JSON.stringify({ ...context, provenanceRefs: buildProvenanceRefs(context) }).length;
    const overBudget = () => sizeOf() > this.options.maxChars;

    while (overBudget()) {
      if (context.recentEvents.length > 1) {
        context.recentEvents.pop();
        truncated = true;
        continue;
      }
      const personWithSpareFacts = context.relevantPeople.find((p) => p.facts.length > 1);
      if (personWithSpareFacts) {
        personWithSpareFacts.facts.pop();
        truncated = true;
        continue;
      }
      if (context.relevantPeople.length > 1) {
        context.relevantPeople.pop();
        truncated = true;
        continue;
      }
      if (context.commitments.length > 1) {
        context.commitments.pop();
        truncated = true;
        continue;
      }
      break; // nothing left to drop without discarding the whole context
    }

    context.truncated = truncated;
    context.provenanceRefs = buildProvenanceRefs(context);
    return context;
  }
}

function buildProvenanceRefs(context) {
  const refs = [];
  for (const person of context.relevantPeople) {
    refs.push({ type: 'entity', id: person.id });
    for (const fact of person.facts) refs.push({ type: 'fact', id: fact.factId });
  }
  for (const commitment of context.commitments) {
    refs.push({ type: 'entity', id: commitment.id }, { type: 'relationship', id: commitment.relationshipId });
  }
  for (const event of context.recentEvents) refs.push({ type: 'event', id: event.eventId });
  return refs;
}

// Simple bidirectional word-overlap heuristic (no embeddings yet -- see
// PLAN.md's semantic-memory phase). "Significant" excludes short filler
// words so "the"/"and" don't count as a match.
function sharesASignificantWord(a, b) {
  const wordsOf = (s) => String(s || '').split(/\W+/).filter((w) => w.length > 3);
  const bWords = new Set(wordsOf(b));
  return wordsOf(a).some((word) => bWords.has(word));
}

function latestTimestamp(timestamps) {
  return timestamps.filter(Boolean).sort().at(-1) || null;
}

// Event types whose summary describes an email/calendar/task row, and can
// therefore inherit that row's classification (issue #3). Anything else
// (commitment.made, contact.birthday_approaching, etc.) has no single
// classified source row to point at, so it falls through to the same safe
// 'personal' default used everywhere else in this codebase -- never
// 'public', and never guessed from the event's free-text content.
const EMAIL_EVENT_TYPES = new Set(['email.received', 'email.sent']);
const CALENDAR_EVENT_TYPES = new Set(['calendar.event_added', 'calendar.event_changed', 'calendar.event_approaching']);
const TASK_EVENT_TYPES = new Set(['task.created', 'task.completed', 'task.overdue']);

/**
 * Sourced strictly from stored data, never from the event's free-text
 * summary or model output. Some publishers already embed the full
 * underlying row on the event (data.after) -- when that's already in hand,
 * this reads its classification directly rather than issuing a redundant DB
 * lookup. Otherwise it falls back to a lookup by the event's subject id
 * against the same store the row actually lives in.
 */
function classificationForEvent(event) {
  const data = event.data || {};
  const subjectId = event.subject?.id ?? null;

  if (EMAIL_EVENT_TYPES.has(event.type)) {
    if (data.after?.classification) return data.after.classification;
    const email = subjectId ? getEmail(subjectId) : null;
    return email?.classification || 'personal';
  }
  if (CALENDAR_EVENT_TYPES.has(event.type)) {
    if (data.after?.classification) return data.after.classification;
    const calendarEvent = subjectId ? getCachedCalendarEvent(subjectId) : null;
    return calendarEvent?.classification || 'personal';
  }
  if (TASK_EVENT_TYPES.has(event.type)) {
    if (data.after?.classification) return data.after.classification;
    const task = subjectId ? getTask(subjectId) : null;
    return task?.classification || 'personal';
  }
  return 'personal';
}

function summarizeEvent(event) {
  const data = event.data || {};
  switch (event.type) {
    case 'email.received':
      return `Email from ${data.from || 'unknown sender'}: ${data.subject || '(no subject)'}`;
    case 'email.sent':
      return `Email sent to ${data.to || 'unknown recipient'}: ${data.subject || '(no subject)'}`;
    case 'calendar.event_added':
    case 'calendar.event_changed':
      return `Calendar: ${data.title || data.after?.title || 'an event'} changed`;
    case 'calendar.event_approaching':
      return `Meeting approaching in ${data.minutesUntil ?? '?'} minute(s)`;
    case 'task.created':
      return `Task created: ${data.title || '(untitled)'}`;
    case 'task.completed':
      return `Task completed: ${data.title || '(untitled)'}`;
    case 'task.overdue':
      return `Task overdue: ${data.title || '(untitled)'}`;
    case 'commitment.made':
      return `Commitment made: ${data.description || '(no description)'}`;
    case 'contact.birthday_approaching':
      return 'A contact\'s birthday is approaching';
    default:
      return event.type;
  }
}
