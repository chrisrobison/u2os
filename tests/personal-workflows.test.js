import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withPersonalWorkflow } from './helpers/personal-workflow-fixture.js';
import { getDb } from '../server/db/connection.js';
import { getRun } from '../server/agent/run-store.js';
import { getAgentAction } from '../server/policy/policy-engine.js';
import { getQueuedActionByActionId, listActionAttempts, requeueAction } from '../server/agent/action-queue-store.js';
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
  for (const acknowledgement of ['accepted', 'uncertain']) {
    test(`${label}: approved simulated send ${acknowledgement} is account-bound, observed and never replayed after restart`, run({ existing, simulatedGmailSend: acknowledgement, modelPlan: (payload, fixture) => {
      if (!payload.tool_observations) return reads(fixture);
      if (fixture.modelRequests.length === 2) {
        const { mail, mailItemIndex, event } = observed(payload);
        return { reasoning_summary: 'Propose a new follow-up message from observed evidence, not a threaded reply', continue: true,
          response: 'Follow-up message proposed, not sent. Dependent draft waits for acknowledged delivery.', actions: [
            { tool: 'email.send', arguments: { to: 'placeholder', subject: 'Role discussion follow-up', body: `I am busy until ${event.end_at}; please suggest a later time.` },
              resultRefs: { to: { stepIndex: 0, itemIndex: mailItemIndex, path: 'from_addr' } } },
            { tool: 'email.draft', arguments: { to: mail.from_addr, subject: 'Follow-up after acknowledged delivery', body: 'Fixture draft, only after delivery.' }, dependsOn: [0] },
          ] };
      }
      assert.equal(acknowledgement, 'accepted', 'uncertain delivery must never resume model planning');
      assert.equal(fixture.modelRequests.length, 3);
      const sent = payload.tool_observations.find((item) => item.tool === 'email.send');
      const draft = payload.tool_observations.find((item) => item.tool === 'email.draft');
      assert.equal(sent.status, 'executed'); assert.equal(draft.status, 'executed');
      assert.equal(sent.items[0].data.id, `gmail_${fixture.primary.id}_fixture_send_receipt`);
      assert.equal(sent.items[0].data.body, fixture.expectedApprovedSend.body);
      assert.equal(draft.items[0].data.folder, 'drafts'); assert.equal(draft.items[0].data.from_addr, '');
      assert.doesNotMatch(JSON.stringify(payload), /fixture-primary-gmail|fixture-primary-refresh|fixture-other-gmail/);
      return { reasoning_summary: 'Report observed receipt and draft, not inferred objective completion', actions: [],
        response: `Provider acknowledged message ${sent.items[0].data.id}; saved follow-up draft ${draft.items[0].data.id}. Objective completion not independently verified.` };
    } }, async (fixture) => {
      const result = await fixture.api('/api/agent/message', { text: 'Find the recruiter latest message, check availability and propose a new follow-up message. Require approval; draft another follow-up only after acknowledged delivery.' });
      const send = result.actions.find((action) => action.tool === 'email.send'); assert.equal(send.status, 'pending');
      fixture.expectedApprovedSend = { to: 'recruiter@example.test', subject: 'Role discussion follow-up', body: `I am busy until ${fixture.calendarEvent.end.dateTime}; please suggest a later time.` };
      assert.deepEqual(send.arguments, fixture.expectedApprovedSend);
      assert.equal(send.accountBinding.instanceId, fixture.primary.id); assert.equal(send.accountBinding.label, 'Selected fixture account');
      const proposal = await fixture.api(`/api/actions/${send.id}`);
      const readsBefore = fixture.network.length;
      assert.equal(fixture.simulatedSends.length, 0); assert.equal(fixture.modelRequests.length, 2);
      await fixture.api('/api/connectors/email/active', { connectorId: 'google', instanceId: fixture.other.id, providerId: 'gmail' });
      await fixture.restart();
      const restored = await fixture.api(`/api/actions/${send.id}`);
      assert.deepEqual(restored.arguments, proposal.arguments); assert.deepEqual(restored.accountBinding, proposal.accountBinding);
      assert.equal(restored.status, 'pending'); assert.equal(fixture.network.length, readsBefore);
      const outcome = await fixture.api(`/api/actions/${send.id}/approve`, {});
      assert.equal(fixture.simulatedSends.length, 1);
      const queue = getQueuedActionByActionId(send.id); assert.equal(listActionAttempts(queue.id).length, 1);
      const completed = await fixture.api(`/api/agent/runs/${result.runId}/result`);
      assert.equal(completed.objectiveStatus, 'unverified');
      if (acknowledgement === 'accepted') {
        assert.equal(outcome.status, 'executed'); assert.equal(queue.status, 'completed');
        assert.equal(completed.status, 'completed'); assert.deepEqual(completed.steps.map((step) => step.status), ['executed', 'executed', 'executed', 'executed']);
        assert.match(completed.response, new RegExp(`gmail_${fixture.primary.id}_fixture_send_receipt`)); assert.match(completed.response, /draft.*not independently verified/);
        assert.equal(getDb().prepare("SELECT count(*) n FROM emails WHERE folder='drafts'").get().n, 1);
        const sent = getDb().prepare("SELECT * FROM emails WHERE folder='sent'").get();
        assert.equal(sent.id, `gmail_${fixture.primary.id}_fixture_send_receipt`); assert.equal(sent.subject, fixture.expectedApprovedSend.subject);
        assert.equal(sent.body, fixture.expectedApprovedSend.body); assert.deepEqual(JSON.parse(sent.to_addr), [fixture.expectedApprovedSend.to]);
        assert.equal(fixture.modelRequests.length, 3);
      } else {
        assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'outcome_uncertain'); assert.match(outcome.error, /outcome uncertain.*Sent mail.*no automatic retry/);
        assert.equal(queue.error_class, 'outcome_uncertain'); assert.equal(completed.status, 'needs_attention');
        assert.deepEqual(completed.steps.map((step) => step.status), ['executed', 'executed', 'outcome_uncertain', 'waiting_dependency']);
        assert.match(completed.response, /outcome uncertain/); assert.doesNotMatch(completed.response, /1 awaiting approval|0 failed or needing attention/); assert.equal(fixture.modelRequests.length, 2);
        assert.equal(getDb().prepare("SELECT count(*) n FROM emails WHERE folder IN ('drafts','sent')").get().n, 0);
        assert.throws(() => requeueAction(queue.id), /cannot be requeued/);
        const operations = await fixture.api('/api/actions/operations');
        const operation = operations.items.find((item) => item.actionId === send.id);
        assert.equal(operation.errorClass, 'outcome_uncertain');
        assert.deepEqual(operation.account, { label: 'Selected fixture account', providerId: 'gmail', instanceId: fixture.primary.id });
      }
      assert.doesNotMatch(JSON.stringify({ outcome, completed, restored }), /fixture-primary-gmail|fixture-primary-refresh|fixture-other-gmail/);
      await fixture.api(`/api/actions/${send.id}/approve`, {}, 400);
      const modelBefore = fixture.modelRequests.length;
      await fixture.api(`/api/agent/runs/${result.runId}/resume`, {}); await fixture.restart();
      await fixture.api(`/api/agent/runs/${result.runId}/resume`, {});
      const afterRestart = await fixture.api(`/api/agent/runs/${result.runId}/result`);
      assert.equal(afterRestart.status, completed.status); assert.equal(afterRestart.objectiveStatus, 'unverified');
      assert.deepEqual(afterRestart.steps.map((step) => step.status), completed.steps.map((step) => step.status));
      assert.equal(fixture.modelRequests.length, modelBefore); assert.equal(fixture.network.length, readsBefore);
      assert.equal(fixture.simulatedSends.length, 1); assert.equal(listActionAttempts(queue.id).length, 1);
      assert.deepEqual(fixture.externalWrites, []);
    }));
  }
  test(`${label}: exact personal send proposal survives account switch/restart and rejection blocks dependent work`, run({ existing, modelPlan: (payload, fixture) => {
    if (!payload.tool_observations) return reads(fixture);
    assert.equal(fixture.modelRequests.length, 2, 'pending/rejected proposal must not trigger further planning');
    const { mail, mailItemIndex, event } = observed(payload);
    return { reasoning_summary: 'Propose reply from observed mail and availability; wait for authorization', continue: true,
      response: 'Reply proposed for review, not sent. Follow-up drafting must wait for delivery.', actions: [
        { tool: 'email.send', arguments: { to: 'placeholder', subject: `Re: ${mail.subject}`, body: `I am busy until ${event.end_at}; please suggest a later time.`, inReplyTo: 'placeholder' },
          resultRefs: { to: { stepIndex: 0, itemIndex: mailItemIndex, path: 'from_addr' }, inReplyTo: { stepIndex: 0, itemIndex: mailItemIndex, path: 'id' } } },
        { tool: 'email.draft', arguments: { to: 'recruiter@example.test', subject: 'Follow-up after authorized reply', body: 'Fixture follow-up, only after delivery.' }, dependsOn: [0] },
      ] };
  } }, async (fixture) => {
    const result = await fixture.api('/api/agent/message', { text: 'Find the latest recruiter message, check availability and propose a reply. Require approval before sending; draft follow-up only after it is sent.' });
    const send = result.actions.find((action) => action.tool === 'email.send');
    assert.ok(send); assert.equal(send.status, 'pending');
    assert.equal(send.accountBinding.instanceId, fixture.primary.id); assert.equal(send.accountBinding.label, 'Selected fixture account');
    assert.equal(send.arguments.to, 'recruiter@example.test'); assert.equal(send.arguments.subject, 'Re: Remote engineering role follow-up');
    assert.equal(send.arguments.inReplyTo, `gmail_${fixture.primary.id}_latest`);
    assert.match(send.arguments.body, new RegExp(fixture.calendarEvent.end.dateTime));
    assert.equal(getRun(result.runId).status, 'waiting_for_approval'); assert.equal(getRun(result.runId).objectiveStatus, 'unverified');
    assert.deepEqual(getRun(result.runId).steps.map((step) => step.status), ['executed', 'executed', 'pending', 'waiting_dependency']);
    assert.match(result.response, /not sent|approval/i);
    const proposal = await fixture.api(`/api/actions/${send.id}`);
    const pending = await fixture.api('/api/actions/pending'); assert.ok(pending.actions.some((action) => action.id === send.id));
    assert.doesNotMatch(JSON.stringify({ proposal, pending }), /fixture-primary-gmail|fixture-primary-refresh|fixture-other-gmail|vault_key/);
    const networkBefore = fixture.network.length, modelBefore = fixture.modelRequests.length;
    await fixture.api('/api/connectors/email/active', { connectorId: 'google', instanceId: fixture.other.id, providerId: 'gmail' });
    await fixture.restart();
    const restored = await fixture.api(`/api/actions/${send.id}`);
    assert.deepEqual(restored.arguments, proposal.arguments); assert.deepEqual(restored.accountBinding, proposal.accountBinding); assert.equal(restored.status, 'pending');
    assert.equal((await fixture.api(`/api/agent/runs/${result.runId}`)).status, 'waiting_for_approval');
    assert.equal(fixture.network.length, networkBefore); assert.equal(fixture.modelRequests.length, modelBefore);
    assert.equal(getDb().prepare("SELECT count(*) n FROM action_queue WHERE tool='email.send'").get().n, 0);
    assert.equal(getDb().prepare("SELECT count(*) n FROM emails WHERE folder IN ('drafts','sent')").get().n, 0);
    const rejected = await fixture.api(`/api/actions/${send.id}/reject`, {}); assert.equal(rejected.status, 'rejected');
    const stopped = await fixture.api(`/api/agent/runs/${result.runId}`);
    assert.deepEqual(stopped.steps.map((step) => step.status), ['executed', 'executed', 'rejected', 'skipped']);
    assert.equal(stopped.status, 'failed'); assert.equal(stopped.objectiveStatus, 'unverified');
    assert.equal(getDb().prepare("SELECT count(*) n FROM agent_actions WHERE tool='email.draft'").get().n, 0);
    assert.equal(getDb().prepare("SELECT count(*) n FROM action_queue WHERE tool='email.send'").get().n, 0);
    assert.equal(getDb().prepare("SELECT count(*) n FROM emails WHERE folder IN ('drafts','sent')").get().n, 0);
    await fixture.restart();
    assert.equal((await fixture.api(`/api/actions/${send.id}`)).status, 'rejected');
    assert.equal((await fixture.api(`/api/agent/runs/${result.runId}`)).status, 'failed');
    assert.equal(fixture.network.length, networkBefore); assert.equal(fixture.modelRequests.length, 2); assert.deepEqual(fixture.externalWrites, []);
  }));
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
