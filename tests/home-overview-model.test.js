import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  greetingFor, dateLabel, countLabel, describeEntry, summarizeJournal, summarizeRoutines, routineStatus, lastRunLabel,
  decisionCards, vaultTrust, policyTrust, modelTrust, integrationsTrust, JOURNAL_LIMIT,
} from '../public/components/home/home-model.js';

// #495: the pure helpers behind the Home overview. They must report only what the
// existing endpoints returned and say "unknown" otherwise.

const at = (h, m = 0, day = 7) => new Date(2026, 9, day, h, m);
const NOW = at(15, 30);
const entry = (type, date, data) => ({ ts: date.toISOString(), type, eventId: `${type}-${date.getTime()}`, ...(data ? { data } : {}) });

test('greeting follows the hour and uses only the first name when there is one', () => {
  assert.equal(greetingFor(at(8), 'Christopher Robison'), 'Good morning, Christopher');
  assert.equal(greetingFor(at(15), 'Christopher'), 'Good afternoon, Christopher');
  assert.equal(greetingFor(at(21), null), 'Good evening');
  assert.equal(greetingFor(at(9), '   '), 'Good morning');
  assert.equal(dateLabel(NOW), 'Wednesday, October 7');
});

test('countLabel never shows a number for a missing source and marks capped counts', () => {
  assert.equal(countLabel(12, false), '12');
  assert.equal(countLabel(500, true), '500+');
  assert.equal(countLabel(0, false), '0');
  assert.equal(countLabel(null, false), '—');
  assert.equal(countLabel(undefined, false), '—');
});

test('journal entries become readable timeline rows', () => {
  assert.deepEqual(describeEntry(entry('routine.completed', at(9), { routine: 'routines/daily-brief.md' })), { id: `routine.completed-${at(9).getTime()}`, time: '09:00', title: 'Routine completed', detail: 'daily-brief', tone: 'success' });
  const failed = describeEntry(entry('routine.failed', at(9, 5), { routine: 'routines/x.md', reason: 'MODEL_ERROR' }));
  assert.equal(failed.detail, 'x · model error');
  assert.equal(failed.tone, 'danger');
  assert.equal(describeEntry(entry('agent.action.approved', at(10), { tool: 'email.send' })).title, 'You approved: email send');
  assert.equal(describeEntry(entry('agent.action.completed', at(10), {})).title, 'Completed: an action');
  assert.equal(describeEntry(entry('something.new_type', at(10))).title, 'Something new type');
});

test('journal summary counts only today, oldest first, and flags a capped read', () => {
  const journal = { entries: [
    entry('agent.action.completed', at(14)), entry('agent.action.completed', at(12)), entry('routine.fired', at(9)),
    entry('agent.action.completed', at(23, 0, 6)), // yesterday
  ] };
  const day = summarizeJournal(journal, NOW);
  assert.equal(day.total, 3);
  assert.equal(day.completed, 2);
  assert.equal(day.capped, false);
  assert.deepEqual(day.items.map((i) => i.time), ['09:00', '12:00', '14:00']);
  assert.deepEqual(summarizeJournal({ entries: [] }, NOW), { total: 0, completed: 0, capped: false, items: [] });
  assert.deepEqual(summarizeJournal(null, NOW), { total: 0, completed: 0, capped: false, items: [] });
  const full = { entries: Array.from({ length: JOURNAL_LIMIT }, (_, i) => entry('agent.action.completed', at(14, i % 60))) };
  assert.equal(summarizeJournal(full, NOW).capped, true);
  const older = { entries: [...full.entries.slice(1), entry('x', at(1, 0, 3))] };
  assert.equal(summarizeJournal(older, NOW).capped, false);
});

test('routines: only enabled, valid ones are active, and status reflects the last run', () => {
  const base = { path: 'routines/a.md', name: 'A', enabled: true, error: null, schedule: 'Every day at 09:00', lastRun: null };
  assert.equal(routineStatus(base).label, 'Enabled');
  assert.equal(routineStatus({ ...base, lastRun: { status: 'started' } }).label, 'Running');
  assert.equal(routineStatus({ ...base, enabled: false }).label, 'Disabled');
  assert.equal(routineStatus({ ...base, error: 'bad' }).label, 'Needs fixing');
  assert.equal(lastRunLabel(null), 'Never run');
  const summary = summarizeRoutines({ routines: [base, { ...base, path: 'b', name: 'B', enabled: false }, { ...base, path: 'c', name: 'C', error: 'bad' }] });
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.inactiveCount, 2);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].schedule, 'Every day at 09:00');
  const many = summarizeRoutines({ routines: Array.from({ length: 9 }, (_, i) => ({ ...base, path: `r${i}`, name: `R${i}` })) });
  assert.equal(many.rows.length, 6);
  assert.equal(many.hidden, 3);
  assert.deepEqual(summarizeRoutines(undefined), { total: 0, activeCount: 0, inactiveCount: 0, rows: [], hidden: 0 });
});

test('decision cards are compact, truncated, and never carry action arguments', () => {
  const cards = decisionCards({ actions: [
    { id: 'act_1', tool: 'email.send', arguments: { to: 'secret@example.com' }, reasoning_summary: 'x'.repeat(400), policy_domain: 'email', policy_rule: 'confirm' },
    { id: 'act_2', tool: null, reasoning_summary: '' },
    { tool: 'no.id' },
  ] });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, 'U2OS wants to email send');
  assert.equal(cards[0].reason.length, 160);
  assert.equal(cards[0].policy, 'email · confirm');
  assert.equal(JSON.stringify(cards).includes('secret@example.com'), false);
  assert.equal(cards[1].title, 'U2OS wants to take an action');
  assert.deepEqual(decisionCards(null), []);
});

test('system trust reports only what the endpoints say, otherwise unknown', () => {
  assert.equal(vaultTrust({ lastIndex: null }).state, 'unknown');
  assert.deepEqual(vaultTrust({ lastIndex: { files: 1, errors: [] } }), { id: 'vault', label: 'Vault', state: 'ok', value: '1 file indexed' });
  assert.equal(vaultTrust({ lastIndex: { files: 4, errors: [{ path: 'a' }] } }).state, 'warn');
  assert.equal(policyTrust({}).state, 'unknown');
  assert.equal(policyTrust({ policy: { active: true, error: null } }).value, 'Your vault policy is in effect');
  assert.equal(policyTrust({ policy: { active: false, error: null } }).value, 'Home policy is in effect');
  assert.equal(policyTrust({ policy: { active: false, error: 'bad yaml' } }).state, 'warn');
  assert.equal(modelTrust({ plannerStatus: 'configured', runtimePlannerStatus: 'configured' }).state, 'ok');
  assert.equal(modelTrust({ plannerStatus: 'configured', runtimePlannerStatus: 'demo' }).value, 'Demo model only');
  assert.equal(modelTrust({ plannerStatus: 'configuration-required' }).value, 'Not configured');
  assert.equal(modelTrust({}).state, 'unknown');
  assert.equal(integrationsTrust({}).state, 'unknown');
  assert.equal(integrationsTrust({ connectors: [{ domain: 'email', active: 'mock', connected: true }] }).value, 'None connected');
  assert.deepEqual(integrationsTrust({ connectors: [{ domain: 'email', active: 'gmail', connected: true }, { domain: 'calendar', active: 'google', connected: false }] }), { id: 'integrations', label: 'Integrations', state: 'warn', value: '1 of 2 connected' });
});
