import { validatePlan } from './plan-validator.js';

const ID_ARGUMENTS = {
  'email.read': ['id'],
  'email.draft': ['inReplyTo'],
  'email.send': ['inReplyTo', 'draftId'],
  'calendar.reschedule': ['eventId'],
  'tasks.complete': ['id'],
};
const REFERENCE_SOURCES = {
  'email.read': { id: ['email.search', 'email.read'] },
  'email.draft': { to: ['email.search', 'email.read'], inReplyTo: ['email.search', 'email.read'] },
  'email.send': { inReplyTo: ['email.search', 'email.read'], draftId: ['email.draft'] },
  'calendar.reschedule': { eventId: ['calendar.list'] },
  'tasks.complete': { id: ['tasks.list'] },
};

/** Resolve only explicit references to items the chosen model destination
 * actually saw. Never look up an unfiltered raw result on the model's behalf. */
export function resolveActionReferences(action, allowedObservations, registry, { continuation = false } = {}) {
  const args = { ...action.arguments };
  for (const [argument, ref] of Object.entries(action.resultRefs || {})) {
    const observation = allowedObservations.find((item) => item.stepIndex === ref.stepIndex && item.status === 'executed');
    const acceptedSources = REFERENCE_SOURCES[action.tool]?.[argument];
    if (acceptedSources && !acceptedSources.includes(observation?.tool)) throw clarificationError();
    const resultItem = observation?.items.find((item) => item.index === ref.itemIndex);
    let value = resultItem?.data;
    for (const part of ref.path.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) throw clarificationError();
      value = value[part];
    }
    if (value === undefined || value === null || typeof value === 'object') throw clarificationError();
    args[argument] = value;
  }
  if (continuation) {
    for (const argument of ID_ARGUMENTS[action.tool] || []) {
      const literal = args[argument];
      if (literal !== undefined && !action.resultRefs?.[argument]) throw clarificationError();
    }
  }
  validatePlan({ reasoning_summary: '', actions: [{ tool: action.tool, arguments: args }] }, registry);
  return { ...action, arguments: args };
}

function clarificationError() {
  const error = new Error('A result reference could not be verified from the available observations; ask the owner to clarify');
  error.status = 422;
  error.code = 'UNVERIFIED_RESULT_REFERENCE';
  return error;
}
