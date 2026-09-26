import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withPersonalWorkflow } from './helpers/personal-workflow-fixture.js';
import { getDb } from '../server/db/connection.js';
import { getRun } from '../server/agent/run-store.js';
import { getAgentAction } from '../server/policy/policy-engine.js';
import { validateDashboard } from '../server/api/dashboard-schema.js';

const reads = (fixture) => ({ reasoning_summary: 'Read selected account evidence', continue: true, actions: [
  { tool: 'email.search', arguments: { folder: 'inbox', query: 'from:recruiter@example.test role' } },
  { tool: 'calendar.list', arguments: { from: fixture.from, to: fixture.to } },
] });
function observed(payload) {
  const mail = payload.tool_observations.find((item) => item.tool === 'email.search');
  const calendar = payload.tool_observations.find((item) => item.tool === 'calendar.list');
  const latest = mail.items.map((item, index) => ({ data: item.data, index })).sort((a, b) => Date.parse(b.data.received_at) - Date.parse(a.data.received_at))[0];
  assert.equal(latest.data.subject, 'Remote engineering role follow-up');
  assert.equal(calendar.items[0].data.title, 'Fixture interview preparation');
  return { mail: latest.data, mailItemIndex: latest.index, event: calendar.items[0].data };
}
async function sync(fixture) { await fixture.api('/api/connectors/email/sync', {}); await fixture.api('/api/connectors/calendar/sync', {}); }
const run = (options, operation) => async (context) => {
  // Freeze only Date: HTTP, deadlines and runtime shutdown retain real timers.
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 25, 6).getTime() });
  await withPersonalWorkflow(options, (fixture) => {
    fixture.advanceClock = (milliseconds) => context.mock.timers.tick(milliseconds);
    return operation(fixture);
  });
};

const researchDraft = { objective: 'Research suitable senior engineering opportunities',
  completionCriteria: ['Explain source-linked candidate fit and unverified availability'],
  constraints: ['Senior research engineer', 'Remote only', 'Research only. No applications or outreach.'],
  permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 2, maxModelCalls: 4, maxTokens: 1000 } };
function researchPlan(payload) {
  assert.match(payload.user_objective, /Remote only/); assert.match(payload.user_objective, /No applications or outreach/);
  if (!payload.tool_observations) return { reasoning_summary: 'Search saved criteria', continue: true,
    actions: [{ tool: 'web.search', arguments: { query: 'remote senior research engineer opportunities' } }] };
  const roles = payload.tool_observations.find((item) => item.tool === 'web.search').items[0].data.results;
  const reviews = (payload.prior_read_artifacts || []).flatMap((artifact) => artifact.ownerReviewContext?.reviews || []);
  return { reasoning_summary: 'Explain observed excerpts, not verified openings', actions: [], response: roles.map((role) => {
    const reviewed = reviews.find((item) => item.url === role.url && item.appliesToCurrentRevision);
    return `${role.title} (${role.url}): ${role.snippet} ${role.snippet.startsWith('Remote') ? 'Candidate fit; verify requirements.' : 'Does not meet remote-only constraint.'}${reviewed ? ` Prior owner review: ${reviewed.reviewStatus}; not a fresh discovery.` : ''}`;
  }).join('\n') + '\nCurrent availability not verified. No applications or outreach performed.' };
}

for (const existing of [false, true]) {
  const label = existing ? 'existing unmarked personal home' : 'fresh personal home';
  test(`${label}: personal research retains criteria/reviews, deduplicates across restart and obeys cumulative budgets/lifecycle`, run({ existing, research: true, modelPlan: researchPlan }, async (fixture) => {
    const goal = await fixture.api('/api/goals', researchDraft, 201);
    assert.equal(fixture.modelRequests.length, 0); assert.equal(fixture.network.length, 0);
    const first = await fixture.api(`/api/goals/${goal.id}/runs`, {});
    assert.match(first.response, /Candidate fit/); assert.match(first.response, /Does not meet remote-only constraint/);
    assert.match(first.response, /Current availability not verified/);
    const evidence = await fixture.api(`/api/goals/${goal.id}/runs/${first.runId}`);
    assert.equal(evidence.objectiveStatus, 'unverified'); assert.equal(evidence.researchUpdate.newCount, 2);
    assert.equal(evidence.researchUpdate.repeatedCount, 0);
    const findings = await fixture.api(`/api/goals/${goal.id}/findings`);
    const atlas = findings.findings.find((item) => item.url === fixture.roles[0].url);
    assert.ok(atlas);
    for (const finding of findings.findings) {
      assert.equal(finding.sources[0].account.instanceId, fixture.searchAccount.id);
      assert.equal(finding.sources[0].mock, false, 'real adapter on isolated HTTP fixtures, not demo fallback');
    }
    const reviewed = await fixture.api(`/api/goals/${goal.id}/findings/${atlas.id}`, { reviewStatus: 'relevant', expectedRevision: atlas.revision, expectedGoalRevision: goal.revision }, 200, 'PUT');
    const before = await fixture.api(`/api/goals/${goal.id}`), networkBefore = fixture.network.length, modelBefore = fixture.modelRequests.length;
    assert.equal(before.spent.runs, 1); assert.equal(before.spent.modelCalls, 2); assert.equal(before.spent.tokens, 240);
    assert.equal(before.spent.tokenUsageComplete, true); assert.equal(before.spent.monetaryCost.available, false);
    await fixture.restart();
    assert.deepEqual(await fixture.api(`/api/goals/${goal.id}`), before);
    assert.equal((await fixture.api(`/api/goals/${goal.id}/findings`)).findings.find((item) => item.id === atlas.id).reviewStatus, 'relevant');
    assert.equal(fixture.network.length, networkBefore); assert.equal(fixture.modelRequests.length, modelBefore);
    fixture.advanceClock(1000);
    const second = await fixture.api(`/api/goals/${goal.id}/runs`, {});
    assert.match(second.response, /Prior owner review: relevant; not a fresh discovery/);
    assert.match(second.response, /Fixture Cedar/);
    const next = await fixture.api(`/api/goals/${goal.id}/runs/${second.runId}`);
    assert.equal(next.objectiveStatus, 'unverified'); assert.equal(next.researchUpdate.newCount, 1); assert.equal(next.researchUpdate.repeatedCount, 1);
    const retained = (await fixture.api(`/api/goals/${goal.id}/findings`)).findings;
    assert.equal(retained.length, 3); assert.equal(retained.find((item) => item.id === atlas.id).revision, reviewed.revision);
    const spent = await fixture.api(`/api/goals/${goal.id}`);
    assert.equal(spent.spent.runs, 2); assert.equal(spent.spent.modelCalls, 4); assert.equal(spent.spent.tokens, 480);
    assert.equal(spent.manualRunAvailable, false); assert.equal(spent.status, 'active');
    await fixture.api(`/api/goals/${goal.id}/runs`, {}, 409);
    const paused = await fixture.api(`/api/goals/${goal.id}/control`, { operation: 'pause', expectedRevision: spent.revision });
    await fixture.restart(); assert.equal((await fixture.api(`/api/goals/${goal.id}`)).status, 'paused');
    await fixture.api(`/api/goals/${goal.id}/runs`, {}, 409);
    const cancelled = await fixture.api(`/api/goals/${goal.id}/control`, { operation: 'cancel', expectedRevision: paused.revision });
    assert.equal(cancelled.status, 'cancelled'); await fixture.api(`/api/goals/${goal.id}/runs`, {}, 409);
    // Also exercise lifecycle refusal with untouched budgets, so an
    // exhausted ledger cannot hide a broken pause/cancellation boundary.
    const untouched = await fixture.api('/api/goals', researchDraft, 201);
    const untouchedPaused = await fixture.api(`/api/goals/${untouched.id}/control`, { operation: 'pause', expectedRevision: untouched.revision });
    assert.equal(untouchedPaused.spent.runs, 0); await fixture.api(`/api/goals/${untouched.id}/runs`, {}, 409);
    const untouchedCancelled = await fixture.api(`/api/goals/${untouched.id}/control`, { operation: 'cancel', expectedRevision: untouchedPaused.revision });
    assert.equal(untouchedCancelled.spent.runs, 0); await fixture.api(`/api/goals/${untouched.id}/runs`, {}, 409);
    assert.equal(fixture.modelRequests.length, 4); assert.equal(fixture.searchPasses, 2); assert.equal(fixture.network.length, 2);
    assert.ok(!JSON.stringify({ spent, retained }).includes('fixture-search-api-key'));
    for (const action of getRun(second.runId).steps.filter((item) => item.actionId)) assert.equal(getAgentAction(action.actionId).accountBinding.instanceId, fixture.searchAccount.id);
  }));

  test(`${label}: personal research outage retains failed evidence and resumes only on explicit owner retry`, run({ existing, research: true, modelPlan: researchPlan }, async (fixture) => {
    const goal = await fixture.api('/api/goals', researchDraft, 201); fixture.searchDown = true;
    const failed = await fixture.api(`/api/goals/${goal.id}/runs`, {});
    assert.equal(getRun(failed.runId).status, 'failed'); assert.equal(getRun(failed.runId).objectiveStatus, 'unverified');
    assert.equal(failed.actions[0].status, 'failed'); assert.match(failed.actions[0].error, /unavailable/);
    assert.doesNotMatch(JSON.stringify(failed), /private-provider-fixture-body|all done/);
    assert.equal((await fixture.api(`/api/goals/${goal.id}/findings`)).findings.length, 0);
    const before = await fixture.api(`/api/goals/${goal.id}`);
    assert.equal(before.spent.runs, 1); assert.equal(before.spent.modelCalls, 1); assert.equal(before.spent.tokens, 120);
    await fixture.restart(); fixture.searchDown = false;
    assert.deepEqual(await fixture.api(`/api/goals/${goal.id}`), before);
    assert.equal(fixture.modelRequests.length, 1); assert.equal(fixture.network.length, 1);
    fixture.advanceClock(1000);
    const retry = await fixture.api(`/api/goals/${goal.id}/runs`, {});
    assert.equal(getRun(retry.runId).status, 'completed'); assert.equal(getRun(retry.runId).objectiveStatus, 'unverified');
    assert.equal((await fixture.api(`/api/goals/${goal.id}/findings`)).findings.length, 2);
    const after = await fixture.api(`/api/goals/${goal.id}`);
    assert.equal(after.spent.runs, 2); assert.equal(after.spent.modelCalls, 3); assert.equal(after.spent.tokens, 360);
    assert.equal(after.relatedRuns.length, 2); assert.equal(after.manualRunAvailable, false);
    await fixture.api(`/api/goals/${goal.id}/runs`, {}, 409);
    assert.equal(fixture.network.length, 2); assert.equal(fixture.modelRequests.length, 3);
  }));
  test(`${label}: morning brief is grounded in real provider-interface fixture observations and survives restart`, run({ existing, modelPlan: (payload, fixture) => {
    if (!payload.tool_observations) return reads(fixture);
    const { mail, event } = observed(payload);
    return { reasoning_summary: 'Summarize recorded sources', actions: [], response: `Observed ${mail.subject}; ${event.title} starts ${event.start_at}. This is a read-only brief.` };
  } }, async (fixture) => {
    await sync(fixture);
    const dashboard = await fixture.api('/api/dashboard/morning'); assert.doesNotThrow(() => validateDashboard(dashboard));
    assert.ok(JSON.stringify(dashboard).includes('Fixture interview preparation')); assert.ok(JSON.stringify(dashboard).includes('Remote engineering role follow-up'));
    assert.ok(dashboard.components.every((item) => item.provenance?.references));
    const result = await fixture.api('/api/agent/message', { text: 'Brief me on the selected account mail and calendar. Read only; take no consequential action.' });
    assert.match(result.response, /Remote engineering role follow-up/); assert.match(result.response, /Fixture interview preparation/);
    assert.deepEqual(result.actions.map((item) => item.status), ['executed', 'executed']);
    for (const action of result.actions) assert.equal(getAgentAction(action.id).accountBinding.instanceId, fixture.primary.id);
    assert.equal(getRun(result.runId).objectiveStatus, 'unverified'); assert.equal(getRun(result.runId).modelCalls, 2);
    assert.equal(getRun(result.runId).budget.tokens.input, 200);
    assert.equal(getRun(result.runId).budget.tokens.output, 40);
    assert.equal(getRun(result.runId).budget.tokens.complete, true);
    const networkBefore = fixture.network.length, modelBefore = fixture.modelRequests.length;
    await fixture.restart(); const persisted = await fixture.api(`/api/agent/runs/${result.runId}/result`);
    assert.match(JSON.stringify(persisted), /Remote engineering role follow-up/);
    assert.equal(fixture.network.length, networkBefore); assert.equal(fixture.modelRequests.length, modelBefore);
    const status = JSON.stringify(await fixture.api('/api/connectors'));
    assert.ok(!status.includes('fixture-primary-refresh')); assert.ok(!status.includes('fixture-primary-gmail'));
    const encrypted = fs.readFileSync(path.join(fixture.home, 'credentials', `${fixture.primary.vault_key}.enc.json`), 'utf8');
    assert.ok(!encrypted.includes('fixture-primary-gmail'));
  }));

  test(`${label}: grounded local reply uses validated earlier results with no fictional sender or delivery`, run({ existing, modelPlan: (payload, fixture) => {
    if (!payload.tool_observations) return reads(fixture);
    const { mail, mailItemIndex, event } = observed(payload);
    return { reasoning_summary: 'Draft from retrieved message and observed busy period', actions: [{ tool: 'email.draft',
      arguments: { to: 'placeholder', subject: `Re: ${mail.subject}`, body: `Thanks for the role discussion. I have an observed appointment ending ${event.end_at}; please suggest a time after that.`, inReplyTo: 'placeholder' },
      resultRefs: { to: { stepIndex: 0, itemIndex: mailItemIndex, path: 'from_addr' }, inReplyTo: { stepIndex: 0, itemIndex: mailItemIndex, path: 'id' } } }], response: 'Saved a local reply draft from retrieved evidence, not sent.' };
  } }, async (fixture) => {
    const result = await fixture.api('/api/agent/message', { text: 'Find the recruiter latest email, check calendar availability, and draft a reply only. Do not send.' });
    assert.deepEqual(result.actions.map((item) => item.status), ['executed', 'executed', 'executed']);
    const draft = result.actions.find((item) => item.tool === 'email.draft').result;
    assert.equal(draft.from_addr, ''); assert.deepEqual(draft.to_addr, ['recruiter@example.test']); assert.equal(draft.folder, 'drafts');
    assert.equal(draft.thread_id, result.actions[0].result.find((item) => item.subject === 'Remote engineering role follow-up').id);
    assert.ok(draft.body.includes(fixture.calendarEvent.end.dateTime));
    assert.match(result.response, /not sent/); assert.equal(fixture.modelRequests.length, 2);
    assert.ok(fixture.network.some((item) => item.query === 'in:inbox from:recruiter@example.test role'));
    assert.ok(JSON.stringify(fixture.modelRequests[1].payload.tool_observations).includes('secret-exfiltrate-fixture'));
    assert.ok(!fixture.modelRequests[1].system.includes('secret-exfiltrate-fixture'));
    assert.ok(!JSON.stringify(fixture.modelRequests).includes('fixture-primary-gmail'));
    await fixture.restart(); assert.equal(getDb().prepare('SELECT from_addr FROM emails WHERE id=?').get(draft.id).from_addr, '');
  }));

  test(`${label}: event-selected meeting preparation uses cached provider evidence and does not invent unknown contacts`, run({ existing, modelPlan: () => { throw new Error('Meeting dashboard needs no model call'); } }, async (fixture) => {
    await sync(fixture);
    const event = getDb().prepare("SELECT id FROM calendar_events WHERE title='Fixture interview preparation'").get();
    const before = getDb().prepare('SELECT count(*) n FROM entities').get().n;
    const dashboard = await fixture.api('/api/dashboard/generate', { context: 'before-meeting', params: { eventId: event.id } });
    assert.doesNotThrow(() => validateDashboard(dashboard)); assert.equal(dashboard.title, 'Before: Fixture interview preparation');
    const person = dashboard.components.find((item) => item.type === 'person' && item.data.id === fixture.person.id);
    assert.ok(person); assert.ok(person.data.facts.some((item) => item.key === 'prep_note'));
    assert.ok(person.provenance.references.some((item) => item.id === event.id));
    assert.ok(JSON.stringify(dashboard).includes('Unmatched Fixture Partner'));
    assert.equal(getDb().prepare('SELECT count(*) n FROM entities').get().n, before); assert.equal(fixture.modelRequests.length, 0);
  }));

  test(`${label}: provider outage stops continuation/drafting and distinguishes failure from completion`, run({ existing, modelPlan: (_payload, fixture) => {
    assert.equal(fixture.modelRequests.length, 1, 'failed prerequisite must not start another model call');
    return { ...reads(fixture), response: 'Incorrect fixture claim: all done.' };
  } }, async (fixture) => {
    fixture.calendarDown = true;
    const result = await fixture.api('/api/agent/message', { text: 'Find recruiter mail, check availability and draft only.' });
    assert.deepEqual(result.actions.map((item) => item.status), ['executed', 'failed']);
    assert.match(result.actions[1].error, /503/);
    assert.match(result.response, /Continuation stopped/); assert.doesNotMatch(result.response, /all done|private-provider-fixture-body/);
    assert.equal(getDb().prepare("SELECT count(*) n FROM emails WHERE folder='drafts'").get().n, 0);
    assert.equal(getRun(result.runId).status, 'failed'); assert.equal(getRun(result.runId).objectiveStatus, 'unverified');
    assert.equal(getRun(result.runId).modelCalls, 1); await fixture.restart();
    assert.equal(getRun(result.runId).status, 'failed'); assert.equal(fixture.modelRequests.length, 1);
  }));
}
