// Memory projector: subscribes to the event bus and derives structured
// memory (facts/relationships) from raw events. Kept intentionally modest for
// Phase 1 -- enough to prove the events -> memory pipeline works end to end,
// not exhaustive (see docs/architecture.md).

import { findEntities, createEntity } from './entity-store.js';
import { recordFact } from './fact-store.js';
import { recordRelationship } from './relationship-store.js';

export function initProjector(eventBus) {
  eventBus.subscribe('calendar.event_changed', (event) => {
    try {
      applyCalendarEventProjection(event, eventBus);
    } catch (err) {
      console.error('[projector] failed to process calendar.event_changed', err);
    }
  });
  return eventBus;
}

export function projectCalendarEventChanged(event) {
  const attendees = event.data?.after?.attendees ?? event.data?.attendees ?? [];
  const eventId = event.subject?.id ?? event.data?.eventId ?? null;
  const newStartAt = event.data?.after?.startAt ?? event.data?.after?.start_at ?? null;
  const projections = [];

  for (const attendee of attendees) {
    const name = typeof attendee === 'string' ? attendee : attendee?.name;
    if (!name) continue;

    const matches = findEntities({ type: 'Person', query: name });
    for (const person of matches) {
      projections.push({
        entityId: person.id,
        key: 'last_meeting_change',
        value: { eventId, newStartAt },
        source: 'system:projector',
        inferred: true,
        confidence: 0.9,
        observedAt: event.timestamp,
        provenance: { projector: 'calendar.event_changed', sourceEventId: event.id },
      });
    }
  }
  return projections;
}

export function applyCalendarEventProjection(event, eventBus = null) {
  const projections = projectCalendarEventChanged(event);
  for (const projection of projections) {
    recordFact(projection);

    if (eventBus) {
      eventBus.publish({
        type: 'memory.fact_recorded',
        source: 'projector',
        actor: { type: 'system', id: 'memory-projector' },
        subject: { type: 'entity', id: projection.entityId },
        data: { key: 'last_meeting_change' },
        metadata: {
          correlationId: event.correlationId,
          causationId: event.id,
          provenance: 'projector:calendar.event_changed',
        },
      });
    }
  }
  return projections;
}

// Modest commitment detection. Phase 1 has no upstream event that represents
// "a commitment was spoken" (that would require real transcript/email
// ingestion, out of scope here), so rather than wiring this as another
// eventBus.subscribe(), the agent orchestrator calls this directly after
// handling a user message -- the only Phase 1 source of natural-language
// text. Exporting it as its own function keeps the seam obvious for a future
// phase where commitments could also be detected from email/meeting
// transcripts without touching the agent.
const COMMITMENT_PATTERN = /\bI(?:'ll|\s+will)\s+(.+)/i;

export function detectAndRecordCommitment({ text, ownerEntityId, eventBus, correlationId }) {
  const match = text.match(COMMITMENT_PATTERN);
  if (!match) return null;
  const description = match[1].trim().replace(/[.?!]+$/, '');
  if (!description) return null;

  const commitment = createEntity({
    type: 'Commitment',
    name: description,
    attributes: { description, status: 'open' },
  });

  recordRelationship({
    fromEntityId: ownerEntityId,
    relation: 'promised',
    toEntityId: commitment.id,
    source: 'system:projector',
    inferred: true,
    confidence: 0.8,
  });

  eventBus.publish({
    type: 'memory.relationship_recorded',
    source: 'projector',
    actor: { type: 'system', id: 'memory-projector' },
    subject: { type: 'entity', id: commitment.id },
    data: { relation: 'promised' },
    metadata: { correlationId, provenance: 'projector:commitment_detection' },
  });

  eventBus.publish({
    type: 'commitment.made',
    source: 'agent',
    actor: { type: 'agent', id: 'agent_default' },
    subject: { type: 'entity', id: commitment.id },
    data: { description },
    metadata: { correlationId, provenance: 'agent:commitment_detection' },
  });

  return commitment;
}
