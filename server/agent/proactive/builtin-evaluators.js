// Built-in proactive evaluators, registered by default on every Agent
// (see agent.js). Moved out of Agent's central switch statement per
// PLAN.md's Agent-refactor phase -- behavior is unchanged from before the
// move; only the wiring (EvaluatorRegistry instead of a switch) changed.
//
// Each evaluate(event, context) receives:
//   context.correlationId, context.actor  -- request identity
//   context.eventBus                      -- for any direct event.publish
//   context.ownerEntityId                 -- the single local owner, or null
//   context.proposeAction(proposal)       -- routes through Agent's
//     policy-gated, audited evaluateAndMaybeExecute() pipeline. This is the
//     ONLY way an evaluator may cause a tool to run.
//   context.generateDashboard(args)       -- Agent.generateDashboard(),
//     reused rather than reimplemented.
import { getCachedCalendarEvent } from '../../integrations/calendar-store.js';
import { getDb } from '../../db/connection.js';
import { findEntities, getEntity } from '../../memory/entity-store.js';
import * as tasksProvider from '../../integrations/mock-tasks-provider.js';
import { scoreForSuggestion } from '../../feedback/prioritizer.js';
import { createRecommendation } from '../recommendation-store.js';

// email.received -> notify: recruiter/talent sender heuristic.
//
// Phase 7 / docs/feedback.md's named borderline case: once the heuristic
// matches, this is no longer a strict binary (notify or not) -- it's a
// three-way choice among notify/recommend/ignore, nudged by
// server/feedback/prioritizer.js's scoreForSuggestion() based on how the
// user has responded to past recruiter notifications. This ONLY changes
// which of notify/recommend/ignore is chosen; it never changes whether
// notifications.send itself is policy-gated -- proposeAction() below still
// runs it through the same policy engine as every other proposed action.
export async function evaluateEmailReceived(event, { correlationId, actor, eventBus, proposeAction }) {
  const from = String(event.data?.from || '').toLowerCase();
  const subject = String(event.data?.subject || '').toLowerCase();
  const looksLikeRecruiter = /recruiter|talent/.test(from) || /recruiter|talent/.test(subject);

  if (!looksLikeRecruiter) {
    return { decision: 'ignore', eventType: event.type, reason: 'Sender/subject does not match the recruiter/talent heuristic.' };
  }

  const feedbackAdjustment = scoreForSuggestion({ tool: 'notifications.send', domain: 'email', requestedBy: 'agent:evaluateEvent' });
  const reasoningSummary = `Sender/subject matched the recruiter/talent heuristic. Feedback adjustment: ${feedbackAdjustment.adjustment} (${feedbackAdjustment.reason})`;
  const notificationArgs = {
    title: 'Recruiter email',
    body: `New email from ${event.data?.from || 'unknown sender'}: ${event.data?.subject || '(no subject)'}`,
    priority: 'high',
  };

  // Repeated negative feedback on this domain suppresses the notification
  // entirely -- "quietly deprioritized toward ignore", per docs/feedback.md.
  if (feedbackAdjustment.adjustment <= -0.15) {
    return {
      decision: 'ignore',
      eventType: event.type,
      reason: `${reasoningSummary}. Suppressed: repeated negative feedback on this domain.`,
      feedbackAdjustment,
    };
  }

  // Mildly negative feedback downgrades notify -> a lower-urgency,
  // dismissible recommendation instead of an immediate notification.
  if (feedbackAdjustment.adjustment < 0) {
    const recommendation = createRecommendation({
      decision: 'recommend',
      eventType: event.type,
      tool: 'notifications.send',
      arguments: notificationArgs,
      reasoningSummary: `${reasoningSummary}. Downgraded from notify to a lower-urgency recommendation.`,
      correlationId,
    });
    eventBus.publish({
      type: 'agent.action.completed',
      source: 'agent',
      actor,
      subject: { type: 'recommendation', id: recommendation.id },
      data: { decision: 'recommend', eventType: event.type, recommendationId: recommendation.id, feedbackAdjustment },
      metadata: { correlationId, provenance: 'agent:evaluateEvent' },
    });
    return { decision: 'recommend', eventType: event.type, recommendation, feedbackAdjustment };
  }

  const outcome = await proposeAction({
    tool: 'notifications.send',
    arguments: notificationArgs,
    requestedBy: 'agent:evaluateEvent',
    requestText: `email.received from ${event.data?.from}`,
    reasoningSummary,
  });
  return { decision: 'notify', eventType: event.type, outcome, feedbackAdjustment };
}

// calendar.event_approaching -> prepare: generate a before-meeting
// dashboard (reusing the existing dashboard-planner, never reimplemented)
// and attach it to a dismissible recommendation.
export async function evaluateCalendarApproaching(event, { correlationId, actor, eventBus, generateDashboard }) {
  const eventId = event.data?.eventId || event.subject?.id;
  const calendarEvent = eventId ? getCachedCalendarEvent(eventId) : null;

  let dashboard = null;
  let personId = null;
  let reasoningSummary = `Meeting ${eventId} is approaching (${event.data?.minutesUntil ?? '?'} minute(s) out).`;

  if (calendarEvent) {
    const firstAttendee = (calendarEvent.attendees || [])[0];
    const attendeeName = typeof firstAttendee === 'string' ? firstAttendee : firstAttendee?.name;
    if (attendeeName) {
      const [person] = findEntities({ type: 'Person', query: attendeeName });
      if (person) personId = person.id;
    }
  }

  if (personId) {
    try {
      dashboard = generateDashboard({ context: 'before-meeting', params: { personId } });
      reasoningSummary += ' Generated a before-meeting dashboard.';
    } catch (err) {
      reasoningSummary += ` Could not generate a before-meeting dashboard: ${err.message}.`;
    }
  } else {
    reasoningSummary += ' No matching Person entity found for the meeting attendee; recommendation has no dashboard attached.';
  }

  const recommendation = createRecommendation({
    decision: 'prepare',
    eventType: event.type,
    eventId,
    reasoningSummary,
    dashboard,
    correlationId,
  });

  // No tool was called (dashboard generation isn't a tool), so this is the
  // bookkeeping event for this decision -- still visible in the activity
  // feed like everything else.
  eventBus.publish({
    type: 'agent.action.completed',
    source: 'agent',
    actor,
    subject: { type: 'recommendation', id: recommendation.id },
    data: { decision: 'prepare', eventType: event.type, recommendationId: recommendation.id },
    metadata: { correlationId, provenance: 'agent:evaluateEvent' },
  });

  return { decision: 'prepare', eventType: event.type, recommendation };
}

// calendar.event_changed -> notify only when the authoritative local calendar
// mirror shows a real interval overlap. This deliberately does not trust a
// model-authored category or make a provider network call during evaluation.
export async function evaluateCalendarChanged(event, { proposeAction }) {
  const eventId = event.subject?.id || event.data?.eventId;
  const changed = eventId ? getCachedCalendarEvent(eventId) : null;
  const candidate = changed || normalizeCalendarEvent(event.data?.after, eventId);
  if (!validInterval(candidate) || candidate.status === 'cancelled' || candidate.status === 'canceled') {
    return { decision: 'ignore', eventType: event.type, reason: 'Changed event has no active, valid interval.' };
  }

  const candidateStart = Date.parse(candidate.start_at);
  const candidateEnd = Date.parse(candidate.end_at);
  const conflicts = getDb().prepare('SELECT id, title, start_at, end_at, status FROM calendar_events WHERE id != ?').all(candidate.id || '')
    .filter((other) => other.status !== 'cancelled' && other.status !== 'canceled' && validInterval(other))
    .filter((other) => Date.parse(other.start_at) < candidateEnd && Date.parse(other.end_at) > candidateStart)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.id.localeCompare(b.id));
  if (!conflicts.length) {
    return { decision: 'ignore', eventType: event.type, reason: 'No overlapping active calendar event was found.' };
  }

  const titles = conflicts.slice(0, 3).map((conflict) => conflict.title || 'Untitled event').join(', ');
  const suffix = conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : '';
  const outcome = await proposeAction({
    tool: 'notifications.send',
    arguments: {
      title: 'Calendar conflict',
      body: `“${candidate.title || 'Changed event'}” overlaps with ${titles}${suffix}.`,
      priority: 'high',
    },
    requestedBy: 'agent:evaluateEvent',
    requestText: `calendar.event_changed: ${candidate.id}`,
    reasoningSummary: `Authoritative cached calendar intervals show ${conflicts.length} conflict(s) after the event changed.`,
  });
  return { decision: 'notify', eventType: event.type, conflicts: conflicts.map(({ id }) => id), outcome };
}

// subscription.renewing -> notify. Event data is descriptive context only:
// it cannot select a tool, policy domain, or authorization level.
export async function evaluateSubscriptionRenewing(event, { proposeAction }) {
  const name = boundedText(event.data?.subscriptionName || event.data?.name, 120);
  const renewalAt = Date.parse(boundedText(event.data?.renewalAt, 64));
  const status = boundedText(event.data?.status, 20).toLowerCase();
  if (!name || !Number.isFinite(renewalAt) || renewalAt <= Date.now() || status === 'cancelled' || status === 'canceled') {
    return { decision: 'ignore', eventType: event.type, reason: 'Renewal is malformed, cancelled, or no longer upcoming.' };
  }

  const rawAmount = event.data?.amount;
  const amount = typeof rawAmount === 'number'
    ? rawAmount
    : typeof rawAmount === 'string' && rawAmount.length <= 32 && rawAmount.trim() ? Number(rawAmount) : NaN;
  const currency = /^[A-Za-z]{3}$/.test(String(event.data?.currency || '')) ? String(event.data.currency).toUpperCase() : null;
  const price = Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000
    ? ` for ${currency ? `${currency} ` : ''}${amount.toFixed(2)}`
    : '';
  const date = new Date(renewalAt).toISOString().slice(0, 10);
  const outcome = await proposeAction({
    tool: 'notifications.send',
    arguments: { title: 'Upcoming subscription renewal', body: boundedText(`${name} renews on ${date}${price}.`, 500), priority: 'normal' },
    requestedBy: 'agent:evaluateEvent',
    requestText: `subscription.renewing: ${name}`,
    reasoningSummary: `A validated subscription renewal is scheduled for ${date}.`,
  });
  return { decision: 'notify', eventType: event.type, outcome };
}

// contact.birthday_approaching -> notify. The person's display name comes
// from authoritative local memory, never from event-supplied text.
export async function evaluateBirthdayApproaching(event, { proposeAction }) {
  const entityId = event.subject?.type === 'entity' ? event.subject.id : event.data?.entityId;
  const person = entityId ? getEntity(entityId) : null;
  const daysUntil = typeof event.data?.daysUntil === 'number' ? event.data.daysUntil : NaN;
  if (!person || person.type !== 'Person' || !Number.isInteger(daysUntil) || daysUntil < 0 || daysUntil > 366) {
    return { decision: 'ignore', eventType: event.type, reason: 'Birthday event has no active Person or valid days-until value.' };
  }

  const timing = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`;
  const outcome = await proposeAction({
    tool: 'notifications.send',
    arguments: { title: 'Birthday approaching', body: `${boundedText(person.name, 120) || 'A contact'}’s birthday is ${timing}.`, priority: 'normal' },
    requestedBy: 'agent:evaluateEvent',
    requestText: `contact.birthday_approaching: ${person.id}`,
    reasoningSummary: `The local birthday trigger reports ${daysUntil} day(s) until this contact's birthday.`,
  });
  return { decision: 'notify', eventType: event.type, outcome };
}

// message.received -> notify only for an explicitly direct, high-importance
// message. Payload text is descriptive and bounded; it cannot select the tool,
// policy domain, or authorization level.
export async function evaluateMessageReceived(event, { proposeAction }) {
  const importance = boundedText(event.data?.importance, 16).toLowerCase();
  const sender = boundedText(event.data?.sender, 120);
  const summary = boundedText(event.data?.subject || event.data?.preview, 240);
  if (event.data?.direct !== true || !['high', 'urgent'].includes(importance) || !sender || !summary) {
    return { decision: 'ignore', eventType: event.type, reason: 'Message is not a valid direct high/urgent message.' };
  }

  const messageId = event.subject?.type === 'message' ? boundedText(event.subject.id, 120) : '';
  const outcome = await proposeAction({
    tool: 'notifications.send',
    arguments: { title: 'Important message', body: boundedText(`Message from ${sender}: ${summary}`, 500), priority: 'high' },
    requestedBy: 'agent:evaluateEvent',
    requestText: `message.received${messageId ? `: ${messageId}` : ''}`,
    reasoningSummary: `A direct message carried an explicit ${importance} importance signal.`,
  });
  return { decision: 'notify', eventType: event.type, outcome };
}

// project.changed -> notify for actionable activity confirmed against the
// active local Project. Event text cannot override the project name/state.
export async function evaluateProjectChanged(event, { proposeAction }) {
  const entityId = event.subject?.type === 'entity' ? event.subject.id : event.data?.entityId;
  const project = entityId ? getEntity(entityId) : null;
  const change = boundedText(event.data?.change, 32).toLowerCase();
  if (!project || project.type !== 'Project') {
    return { decision: 'ignore', eventType: event.type, reason: 'Project event has no active local Project.' };
  }

  const projectName = boundedText(project.name, 120) || 'A project';
  let body;
  if (change === 'status' && boundedText(project.attributes?.status, 32).toLowerCase() === 'blocked') {
    body = `${projectName} is blocked and may need attention.`;
  } else if (change === 'deadline') {
    const deadline = boundedText(project.attributes?.deadline, 64);
    const deadlineAt = Date.parse(deadline);
    if (!deadline || !Number.isFinite(deadlineAt)) {
      return { decision: 'ignore', eventType: event.type, reason: 'Project has no valid locally stored deadline.' };
    }
    body = `${projectName} has a deadline change: ${new Date(deadlineAt).toISOString().slice(0, 10)}.`;
  } else {
    return { decision: 'ignore', eventType: event.type, reason: 'Project activity is not an actionable blocked-status or deadline change.' };
  }

  const outcome = await proposeAction({
    tool: 'notifications.send',
    arguments: { title: 'Project needs attention', body: boundedText(body, 500), priority: 'high' },
    requestedBy: 'agent:evaluateEvent',
    requestText: `project.changed: ${project.id}`,
    reasoningSummary: `The ${change} signal matches actionable state stored on the active local Project.`,
  });
  return { decision: 'notify', eventType: event.type, outcome };
}

function boundedText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeCalendarEvent(value = {}, id = null) {
  return { id, title: value?.title, start_at: value?.start_at || value?.startAt, end_at: value?.end_at || value?.endAt, status: value?.status };
}

function validInterval(event) {
  const start = Date.parse(event?.start_at);
  const end = Date.parse(event?.end_at);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

// task.overdue -> notify.
export async function evaluateTaskOverdue(event, { proposeAction }) {
  const title = event.data?.title || 'a task';
  const outcome = await proposeAction({
    tool: 'notifications.send',
    arguments: {
      title: 'Overdue task',
      body: `"${title}" was due ${event.data?.dueAt || 'earlier'} and is still open.`,
      priority: 'normal',
    },
    requestedBy: 'agent:evaluateEvent',
    requestText: `task.overdue: ${title}`,
    reasoningSummary: `Task "${title}" is overdue.`,
  });
  return { decision: 'notify', eventType: event.type, outcome };
}

// commitment.made -> act: auto-create the linked task (ties into
// memory/projector.js's detectAndRecordCommitment). Skips if a task
// already exists for this commitment (the seed trigger's own "IF no task
// exists" condition, enforced here since event_rule's `when` clause can't
// express a cross-table existence check).
export async function evaluateCommitmentMade(event, { proposeAction }) {
  const commitmentId = event.subject?.id;
  const description = event.data?.description;

  if (!description) {
    return { decision: 'ignore', eventType: event.type, reason: 'commitment.made event carried no description.' };
  }

  if (commitmentId) {
    const existingTasks = tasksProvider.listTasks({}).filter((t) => t.related_entity_id === commitmentId);
    if (existingTasks.length) {
      return {
        decision: 'ignore',
        eventType: event.type,
        reason: `A task already exists for this commitment (${existingTasks[0].id}).`,
      };
    }
  }

  // This is a PROPOSAL through the same policy-gated pipeline as everything
  // else -- the policy engine still decides whether tasks.create actually
  // executes autonomously or needs approval.
  const outcome = await proposeAction({
    tool: 'tasks.create',
    arguments: { title: description, relatedEntityId: commitmentId },
    requestedBy: 'agent:evaluateEvent',
    requestText: `commitment.made: ${description}`,
    reasoningSummary: `Auto-creating a task for the commitment "${description}".`,
  });
  return { decision: 'act', eventType: event.type, outcome };
}

/** Registers the built-in evaluators on the given registry. */
export function registerBuiltinEvaluators(registry) {
  registry.register({ eventPattern: 'email.received', evaluate: evaluateEmailReceived, name: 'builtin:email.received' });
  registry.register({ eventPattern: 'calendar.event_approaching', evaluate: evaluateCalendarApproaching, name: 'builtin:calendar.event_approaching' });
  registry.register({ eventPattern: 'calendar.event_changed', evaluate: evaluateCalendarChanged, name: 'builtin:calendar.event_changed' });
  registry.register({ eventPattern: 'subscription.renewing', evaluate: evaluateSubscriptionRenewing, name: 'builtin:subscription.renewing' });
  registry.register({ eventPattern: 'contact.birthday_approaching', evaluate: evaluateBirthdayApproaching, name: 'builtin:contact.birthday_approaching' });
  registry.register({ eventPattern: 'message.received', evaluate: evaluateMessageReceived, name: 'builtin:message.received' });
  registry.register({ eventPattern: 'project.changed', evaluate: evaluateProjectChanged, name: 'builtin:project.changed' });
  registry.register({ eventPattern: 'task.overdue', evaluate: evaluateTaskOverdue, name: 'builtin:task.overdue' });
  registry.register({ eventPattern: 'commitment.made', evaluate: evaluateCommitmentMade, name: 'builtin:commitment.made' });
  return registry;
}
