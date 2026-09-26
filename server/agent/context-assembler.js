import { findEntities } from '../memory/entity-store.js';
import { getFacts } from '../memory/fact-store.js';
import { getRelationships } from '../memory/relationship-store.js';
import { rankFactsHybrid } from '../memory/semantic-retrieval.js';
import { selectMemoryCandidates, rankMemoryCandidates } from '../memory/candidate-retrieval.js';
import { getEmail } from '../integrations/mock-email-provider.js';
import { getCachedCalendarEvent } from '../integrations/calendar-store.js';
import { getTask } from '../integrations/mock-tasks-provider.js';
import { DataProcessingPolicy } from '../policy/data-processing-policy.js';

const DEFAULTS = {
  maxChars: 6000,
  maxPeople: 5,
  maxFactsPerPerson: 5,
  maxRelevantFacts: 10,
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
 * candidates with inspectable hybrid signals (semantic similarity when a
 * provider is configured, exact matches, recency, authority, confidence,
 * and structural relevance). Semantic retrieval remains optional and its
 * inputs pass through the data-processing policy before any remote
 * embedding endpoint is called.
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
  constructor({ toolRegistry, eventBus, ownerEntityId = null, embeddingProvider = null, dataProcessingPolicy = null, ...options } = {}) {
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.ownerEntityId = ownerEntityId;
    // Optional (PLAN.md Phase 5): when configured, fact ranking within each
    // person blends semantic similarity in with confidence/recency/exact-word
    // overlap (server/memory/semantic-retrieval.js). Entirely absent by
    // default -- ranking then falls back to the Phase 4 confidence+recency
    // heuristic, unchanged.
    this.embeddingProvider = embeddingProvider;
    this.dataProcessingPolicy = dataProcessingPolicy || new DataProcessingPolicy();
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * @returns {Promise<{toolRegistry: object, eventBus: object, correlationId: string, actor: object, personalContext: object}>}
   */
  async assemble({ correlationId, actor, objective = '', allowEmbeddings = true } = {}) {
    // Auxiliary embedding calls have no run/goal reservation or usage contract
    // yet. A bounded goal uses a request-local lexical assembler, never a
    // temporary mutation of the shared provider (other chats may overlap).
    const assembler = !allowEmbeddings && this.embeddingProvider ? new ContextAssembler({
      ...this.options,
      toolRegistry: this.toolRegistry,
      eventBus: this.eventBus,
      ownerEntityId: this.ownerEntityId,
      dataProcessingPolicy: this.dataProcessingPolicy,
      embeddingProvider: null,
    }) : this;
    return {
      toolRegistry: this.toolRegistry,
      eventBus: this.eventBus,
      correlationId,
      actor,
      personalContext: await assembler.assemblePersonalContext(objective, { correlationId, actor }),
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
  async assemblePersonalContext(objective = '', audit = {}) {
    const objectiveLower = String(objective || '').toLowerCase();
    const selected = selectMemoryCandidates({ objective, ownerEntityId: this.ownerEntityId, eventTypes: CONTEXT_WORTHY_EVENT_TYPES });
    selected.events = selected.events.map((item) => ({ ...item, classification: classificationForEvent(candidateRowToEvent(item)) }));
    const semanticOmitted = [];
    const semanticFilter = (item) => {
      const destination = this.embeddingProvider?.destination || 'configured_remote_model';
      const result = this.dataProcessingPolicy.evaluate({ classification: item.classification || 'personal', destination });
      if (result.decision === 'allow') return true;
      semanticOmitted.push({ type: item.subjectType, id: item.id, classification: item.classification || 'personal', destination, decision: result.decision, rule: result.rule });
      return false;
    };
    const candidates = await rankMemoryCandidates({ candidates: selected, objective, embeddingProvider: this.embeddingProvider, semanticFilter });

    const relevantPeople = await this._rankPeople(objectiveLower, objective, candidates, semanticOmitted);
    const context = {
      objective: String(objective || ''),
      currentTime: new Date().toISOString(),
      relevantPeople,
      relevantFacts: this._rankStandaloneFacts(candidates.facts, new Set(relevantPeople.map((person) => person.id))),
      commitments: this._rankCommitments(candidates.commitments),
      recentEvents: this._rankEvents(candidates.events),
      truncated: false,
    };
    if (semanticOmitted.length && this.eventBus) {
      this.eventBus.publish({ type: 'agent.context_restricted', source: 'agent', actor: audit.actor, data: { destination: this.embeddingProvider?.destination || 'configured_remote_model', providerId: this.embeddingProvider?.id, stage: 'embeddings', omitted: dedupeOmissions(semanticOmitted) }, metadata: { correlationId: audit.correlationId, provenance: 'context-assembler:data-processing-policy' } });
    }

    // provenanceRefs is derived from whatever survives budgeting below --
    // computed fresh each fit-loop iteration (see _fitBudget) so it never
    // claims an item as "used context" that was actually dropped for space,
    // and is recomputed once more for the final result.
    return this._fitBudget(context);
  }

  // --- people + facts + relationships -------------------------------------

  async _rankPeople(objectiveLower, objectiveRaw, candidates, semanticOmitted) {
    const candidateById = new Map(candidates.entities.map((item) => [item.id, item]));
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
        const retrievalCandidate = candidateById.get(person.id);
        return { person, nameMentioned, facts, relationships, lastActivityAt, retrievalCandidate };
      })
      .sort((a, b) => {
        const aScore = a.retrievalCandidate?._relevance.total || 0;
        const bScore = b.retrievalCandidate?._relevance.total || 0;
        if (aScore !== bScore) return bScore - aScore;
        if (a.nameMentioned !== b.nameMentioned) return a.nameMentioned ? -1 : 1;
        return (b.lastActivityAt || '').localeCompare(a.lastActivityAt || '');
      })
      .slice(0, this.options.maxPeople);

    const results = [];
    for (const { person, nameMentioned, facts, relationships, retrievalCandidate } of ranked) {
      results.push({
        id: person.id,
        name: person.name,
        matchedOn: nameMentioned
          ? 'objective mentions this name'
          : retrievalCandidate?.matchedFactIds?.length ? 'objective matches a current fact'
            : retrievalCandidate?._relevance.semantic > 0 ? 'hybrid semantic and structural relevance' : 'recently active',
        facts: await this._rankFacts(facts, objectiveRaw, semanticOmitted),
        relationshipCount: relationships.length,
        classification: person.classification || 'personal',
        ...(retrievalCandidate ? { relevance: compactRelevance(retrievalCandidate._relevance) } : {}),
      });
    }
    return results;
  }

  _rankStandaloneFacts(candidates, selectedPersonIds) {
    return candidates.filter((item) => item.entity_type !== 'Person' || !selectedPersonIds.has(item.entity_id))
      .slice(0, this.options.maxRelevantFacts)
      .map((item) => ({
        factId: item.id,
        entityId: item.entity_id,
        entityType: item.entity_type,
        entityName: item.entity_name,
        key: item.key,
        value: parseStoredJson(item.value),
        source: item.source,
        confidence: item.confidence,
        inferred: !!item.inferred,
        observedAt: item.observed_at,
        classification: item.classification || 'personal',
        relevance: compactRelevance(item._relevance),
      }));
  }

  // Confidence+recency by default; blends in semantic similarity (and an
  // exact-word-overlap signal, and an inferred-fact penalty) when an
  // embeddingProvider is configured -- see server/memory/semantic-retrieval.js.
  async _rankFacts(facts, objectiveRaw, semanticOmitted = []) {
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
      const hybrid = await rankFactsHybrid({ facts: normalized, query: objectiveRaw, embeddingProvider: this.embeddingProvider, semanticFilter: (fact) => this._semanticAllowed(fact, semanticOmitted) });
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

  _semanticAllowed(item, omitted) {
    if (!this.embeddingProvider) return false;
    const classification = item.classification || 'personal';
    const destination = this.embeddingProvider.destination || 'configured_remote_model';
    const result = this.dataProcessingPolicy.evaluate({ classification, destination });
    if (result.decision === 'allow') return true;
    omitted.push({ type: 'fact', id: item.id, classification, destination, decision: result.decision, rule: result.rule });
    return false;
  }

  // --- commitments ----------------------------------------------------------

  _rankCommitments(candidates) {
    return candidates.slice(0, this.options.maxCommitments).map((item) => {
      const attributes = parseStoredJson(item.attributes) || {};
      return {
        id: item.id,
        relationshipId: item.relationship_id,
        description: String(attributes.description || item.name || ''),
        createdAt: item.created_at,
        confidence: item.confidence,
        inferred: !!item.inferred,
        classification: item.classification || 'personal',
        relevance: compactRelevance(item._relevance),
      };
    });
  }

  // --- recent events ----------------------------------------------------------

  _rankEvents(candidates) {
    return candidates.slice(0, this.options.maxRecentEvents).map((item) => {
      const event = candidateRowToEvent(item);
      return {
        eventId: event.id,
        type: event.type,
        timestamp: event.timestamp,
        summary: summarizeEvent(event),
        classification: item.classification || 'personal',
        relevance: compactRelevance(item._relevance),
      };
    });
  }

  // --- budget -----------------------------------------------------------------

  _fitBudget(context) {
    let truncated = false;
    const sizeOf = () => JSON.stringify({ ...context, provenanceRefs: buildProvenanceRefs(context) }).length;
    const overBudget = () => sizeOf() > this.options.maxChars;

    while (overBudget()) {
      if (context.relevantFacts.length) {
        context.relevantFacts.pop();
        truncated = true;
        continue;
      }
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
  for (const fact of context.relevantFacts || []) {
    refs.push({ type: 'entity', id: fact.entityId }, { type: 'fact', id: fact.factId });
  }
  for (const commitment of context.commitments) {
    refs.push({ type: 'entity', id: commitment.id }, { type: 'relationship', id: commitment.relationshipId });
  }
  for (const event of context.recentEvents) refs.push({ type: 'event', id: event.eventId });
  return refs;
}

function candidateRowToEvent(row) {
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { /* malformed stored data stays conservatively personal */ }
  return { id: row.id, type: row.type, timestamp: row.timestamp, data, subject: row.subject_type ? { type: row.subject_type, id: row.subject_id } : null };
}

function dedupeOmissions(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}:${item.id}:${item.classification}:${item.destination}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function latestTimestamp(timestamps) {
  return timestamps.filter(Boolean).sort().at(-1) || null;
}

function parseStoredJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function compactRelevance(relevance = {}) {
  const result = {};
  for (const [key, value] of Object.entries(relevance)) {
    if (Array.isArray(value)) {
      if (value.length) result[key] = value;
    } else if (typeof value === 'number') {
      if (value !== 0 || key === 'total') result[key] = Number(value.toFixed(4));
    } else if (value) result[key] = value;
  }
  return result;
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
