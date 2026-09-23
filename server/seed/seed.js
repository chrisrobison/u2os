// Idempotent demo data seeding. Skips entirely if the entities table already
// has rows. Runs on explicit demo-mode startup, and is also callable by
// isolated test fixtures. The CLI refuses to seed a personal home.
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getDataDir } from '../db/connection.js';
import { ensureDefaultPolicies } from '../policy/policies-loader.js';
import { createEntity } from '../memory/entity-store.js';
import { recordFact } from '../memory/fact-store.js';
import { recordRelationship } from '../memory/relationship-store.js';
import * as calendarProvider from '../integrations/mock-calendar-provider.js';
import * as emailProvider from '../integrations/mock-email-provider.js';
import * as tasksProvider from '../integrations/mock-tasks-provider.js';
import { createTrigger } from '../triggers/trigger-engine.js';
import { ensureInstallationMode } from './installation-mode.js';

export function runSeed({ eventBus } = {}) {
  ensureDefaultPolicies();
  ensureConfigFile();

  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM entities').get();
  if (existing.n > 0) {
    const demoOwner = db.prepare("SELECT id FROM entities WHERE type = 'Person' AND json_extract(attributes, '$.role') = 'owner' ORDER BY created_at LIMIT 1").get();
    return demoOwner?.id || null;
  }

  console.log('[seed] no existing data found, seeding demo data...');

  const chris = createEntity({ type: 'Person', name: 'Chris', attributes: { role: 'owner' } });
  const sarah = createEntity({ type: 'Person', name: 'Sarah', attributes: { role: 'colleague' } });
  const recruiter = createEntity({
    type: 'Person',
    name: 'Jamie Alvarez',
    attributes: { role: 'recruiter', company: 'Northwind Talent' },
  });
  const dana = createEntity({ type: 'Person', name: 'Dana Osei', attributes: { role: 'friend' } });
  const marcus = createEntity({ type: 'Person', name: 'Marcus Lee', attributes: { role: 'colleague' } });

  const project = createEntity({ type: 'Project', name: 'U2OS', attributes: { status: 'active' } });

  recordFact({ entityId: sarah.id, key: 'prefers_morning_meetings', value: true, source: 'user:chris', confidence: 0.8, inferred: false });
  recordFact({ entityId: dana.id, key: 'birthday', value: '09-20', source: 'user:chris', confidence: 1.0, inferred: false });
  recordFact({ entityId: chris.id, key: 'prefers_morning_meetings', value: true, source: 'user:chris', confidence: 0.9, inferred: false });

  recordRelationship({ fromEntityId: chris.id, relation: 'works_on', toEntityId: project.id, source: 'user:chris', confidence: 1.0 });
  recordRelationship({ fromEntityId: chris.id, relation: 'knows', toEntityId: sarah.id, source: 'user:chris', confidence: 1.0 });
  recordRelationship({ fromEntityId: chris.id, relation: 'knows', toEntityId: dana.id, source: 'user:chris', confidence: 1.0 });
  recordRelationship({ fromEntityId: chris.id, relation: 'knows', toEntityId: marcus.id, source: 'user:chris', confidence: 1.0 });
  recordRelationship({ fromEntityId: sarah.id, relation: 'works_on', toEntityId: project.id, source: 'user:chris', confidence: 0.9, inferred: true });

  const now = new Date();

  // Today's "Sync with Sarah" at 2pm, category 'personal' -- this is the
  // event the vertical-slice scenario reschedules. See the note in
  // policies-loader.js for why category 'personal' resolves to `confirm`
  // (not `autonomous`) in the shipped seed policy.
  const today2pm = atHour(now, 0, 14, 0);
  const today230pm = atHour(now, 0, 14, 30);
  const syncWithSarah = calendarProvider.createEvent({
    title: 'Sync with Sarah',
    startAt: today2pm.toISOString(),
    endAt: today230pm.toISOString(),
    attendees: [{ name: 'Sarah' }],
    category: 'personal',
  });

  const tomorrow10am = atHour(now, 1, 10, 0);
  const tomorrow11am = atHour(now, 1, 11, 0);
  const standup = calendarProvider.createEvent({
    title: 'U2OS project standup',
    startAt: tomorrow10am.toISOString(),
    endAt: tomorrow11am.toISOString(),
    attendees: [{ name: 'Marcus Lee' }, { name: 'Sarah' }],
    category: 'personal',
  });

  const inTwoDays9am = atHour(now, 2, 9, 0);
  const inTwoDays930am = atHour(now, 2, 9, 30);
  const recruiterCall = calendarProvider.createEvent({
    title: 'Call with Jamie Alvarez (recruiter)',
    startAt: inTwoDays9am.toISOString(),
    endAt: inTwoDays930am.toISOString(),
    attendees: [{ name: 'Jamie Alvarez' }],
    category: 'interviews',
  });

  for (const event of [syncWithSarah, standup, recruiterCall]) {
    eventBus?.publish({
      type: 'calendar.event_added',
      source: 'mock-calendar',
      actor: { type: 'system', id: 'seed' },
      subject: { type: 'calendar_event', id: event.id },
      data: { after: event },
      metadata: { provenance: 'seed' },
    });
  }

  const recruiterEmail = emailProvider.receiveEmail({
    from: 'jamie.alvarez@northwindtalent.example',
    subject: 'Following up -- another conversation?',
    body: 'Hi Chris, great chatting last week. Would you be open to a follow-up call this week?',
    receivedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
  });
  const newsletterEmail = emailProvider.receiveEmail({
    from: 'newsletter@example.com',
    subject: 'This week in tech',
    body: 'Your weekly roundup...',
    receivedAt: new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString(),
    isRead: true,
  });
  const teamEmail = emailProvider.receiveEmail({
    from: 'marcus.lee@example.com',
    subject: 'Standup notes',
    body: 'Notes from today...',
    receivedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
  });
  emailProvider.sendEmail({
    to: 'sarah@example.com',
    subject: 'Re: Sync with Sarah',
    body: 'Sounds good, see you at 2pm.',
  });

  for (const email of [recruiterEmail, newsletterEmail, teamEmail]) {
    eventBus?.publish({
      type: 'email.received',
      source: 'mock-email',
      actor: { type: 'person', id: null },
      subject: { type: 'email', id: email.id },
      data: { from: email.from_addr, subject: email.subject },
      metadata: { provenance: 'seed' },
    });
  }

  const task1 = tasksProvider.createTask({
    title: 'Send proposal draft to Sarah',
    dueAt: atHour(now, 2, 17, 0).toISOString(),
    relatedEntityId: sarah.id,
    source: 'seed',
  });
  const task2 = tasksProvider.createTask({
    title: 'Prepare for recruiter call',
    dueAt: atHour(now, 2, 8, 0).toISOString(),
    relatedEntityId: recruiter.id,
    source: 'seed',
  });
  const task3 = tasksProvider.createTask({
    title: 'Review U2OS architecture doc',
    relatedEntityId: project.id,
    source: 'seed',
  });

  for (const task of [task1, task2, task3]) {
    eventBus?.publish({
      type: 'task.created',
      source: 'mock-tasks',
      actor: { type: 'system', id: 'seed' },
      subject: { type: 'task', id: task.id },
      data: { after: task },
      metadata: { provenance: 'seed' },
    });
  }

  // Phase 6 / PROMPT.md §9: three demo triggers matching PROMPT.md's own
  // worked examples verbatim (docs/automation.md's "Seed data" section):
  //
  //   WHEN email.received IF sender contains "recruiter"/"talent" THEN notify prominently
  //   WHEN calendar.event_approaching AT 60 minutes before THEN prepare a briefing
  //   WHEN commitment.made IF no task exists THEN create task
  //
  // Each uses action.kind: 'evaluate' so the actual decision logic lives in
  // one place -- agent.evaluateEvent()'s own event-type handlers -- rather
  // than being duplicated between a trigger's fixed action and the
  // proactive agent's heuristic for the same event type.
  createTrigger({
    name: 'Notify on recruiter/talent emails',
    kind: 'event_rule',
    config: {
      eventType: 'email.received',
      when: { path: 'data.from', matches: 'recruiter|talent' },
      action: { kind: 'evaluate' },
    },
    source: 'system',
  });

  createTrigger({
    name: 'Prepare a briefing before upcoming meetings',
    kind: 'condition_watch',
    config: {
      check: 'calendar_approaching',
      params: { leadMinutes: 60 },
      action: { kind: 'evaluate' },
    },
    source: 'system',
  });

  createTrigger({
    name: 'Auto-create a task when a commitment is made',
    kind: 'event_rule',
    config: {
      eventType: 'commitment.made',
      action: { kind: 'evaluate' },
    },
    source: 'system',
  });

  console.log('[seed] demo data created.');
  return chris.id;
}

function atHour(reference, dayOffset, hour, minute) {
  const d = new Date(reference);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function ensureConfigFile() {
  const dataDir = getDataDir();
  const configPath = path.join(dataDir, 'config', 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = { port: Number(process.env.PORT) || 4000, modelProvider: 'mock' };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (ensureInstallationMode() !== 'demo') throw new Error('Refusing to seed a personal home; use npm run demo with an isolated home');
  runSeed({});
  console.log('Seed complete.');
}
