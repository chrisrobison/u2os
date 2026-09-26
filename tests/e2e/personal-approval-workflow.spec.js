import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { withPersonalWorkflow, PERSONAL_FIXTURE_PASSPHRASE } from '../helpers/personal-workflow-fixture.js';
import { getDb } from '../../server/db/connection.js';
import { getQueuedActionByActionId, listActionAttempts, requeueAction } from '../../server/agent/action-queue-store.js';

const reads = (fixture) => ({ reasoning_summary: 'Read selected account evidence', continue: true, actions: [
  { tool: 'email.search', arguments: { folder: 'inbox', query: 'from:recruiter@example.test role' } },
  { tool: 'calendar.list', arguments: { from: fixture.from, to: fixture.to } },
] });
function plan(outcome) {
  return (payload, fixture) => {
    assert.doesNotMatch(JSON.stringify(payload), /fixture-primary-gmail|fixture-primary-refresh|fixture-other-gmail|vault_key/);
    if (!payload.tool_observations) return reads(fixture);
    if (fixture.modelRequests.length === 2) {
      const mail = payload.tool_observations.find((item) => item.tool === 'email.search');
      const calendar = payload.tool_observations.find((item) => item.tool === 'calendar.list');
      const latest = mail.items.map(({ data }, index) => ({ data, index })).sort((a, b) => Date.parse(b.data.received_at) - Date.parse(a.data.received_at))[0];
      assert.equal(latest.data.subject, 'Remote engineering role follow-up'); assert.equal(calendar.items[0].data.title, 'Fixture interview preparation');
      return { reasoning_summary: 'New follow-up grounded in observed evidence; not a threaded reply', continue: true,
        response: 'Follow-up proposed, not sent. Dependent draft waits for acknowledged delivery.', actions: [
          { tool: 'email.send', arguments: { to: 'placeholder', subject: 'Browser role follow-up', body: `I am busy until ${calendar.items[0].data.end_at}; please suggest a later time.` },
            resultRefs: { to: { stepIndex: 0, itemIndex: latest.index, path: 'from_addr' } } },
          { tool: 'email.draft', arguments: { to: latest.data.from_addr, subject: 'Browser dependent follow-up draft', body: 'Fixture draft only after acknowledged delivery.' }, dependsOn: [0] },
        ] };
    }
    assert.equal(outcome, 'accepted', 'rejection or uncertainty cannot continue planning'); assert.equal(fixture.modelRequests.length, 3);
    const sent = payload.tool_observations.find((item) => item.tool === 'email.send'), draft = payload.tool_observations.find((item) => item.tool === 'email.draft');
    assert.equal(sent.status, 'executed'); assert.equal(draft.status, 'executed'); assert.equal(sent.items[0].data.body, fixture.expectedApprovedSend.body);
    assert.equal(draft.items[0].data.folder, 'drafts'); assert.equal(draft.items[0].data.from_addr, '');
    return { reasoning_summary: 'Report observed acknowledgement and local draft, not objective completion', actions: [],
      response: `Provider acknowledged message ${sent.items[0].data.id}; saved draft ${draft.items[0].data.id}. Objective completion not independently verified.` };
  };
}
async function review(page) {
  await page.locator('u2-nav a[data-route="#/operations"]').click();
  await page.getByRole('button', { name: 'Review approval', exact: true }).click();
  const card = page.locator('.operation-review u2-approval'); await expect(card).toHaveAttribute('data-status', 'pending'); return card;
}
async function returnAfterRestart(page, fixture) {
  await page.goto('about:blank'); await fixture.restart(); await page.goto(`${fixture.baseURL}/#/operations`);
  await expect(page.locator('u2-operations')).toBeVisible();
}

for (const existing of [false, true]) for (const outcome of ['accepted', 'uncertain', 'rejected']) {
  test(`${existing ? 'existing' : 'fresh'} personal home: observed original-account browser approval ${outcome} survives restart without replay`, async ({ page }) => {
    await withPersonalWorkflow({ existing, simulatedGmailSend: outcome === 'rejected' ? undefined : outcome, modelPlan: plan(outcome), closeConnectionsForTests: false }, async (fixture) => {
      try {
        await page.goto(fixture.baseURL); await page.getByLabel('Passphrase').fill(PERSONAL_FIXTURE_PASSPHRASE); await page.locator('form button[type="submit"]').click();
        await expect(page.locator('.agent-panel__input')).toBeEnabled(); expect(fixture.modelRequests).toHaveLength(0);
        await page.locator('.agent-panel__input').fill('Find the latest recruiter message, check availability and propose a new follow-up. Require approval; draft another follow-up only after acknowledged delivery.');
        await page.locator('.agent-panel__composer button[type="submit"]').click();
        const inline = page.locator('.shell__agent u2-approval[data-status="pending"]'); await expect(inline).toHaveCount(1);
        const original = await inline.evaluate((element) => element.action);
        fixture.expectedApprovedSend = { to: 'recruiter@example.test', subject: 'Browser role follow-up', body: `I am busy until ${fixture.calendarEvent.end.dateTime}; please suggest a later time.` };
        expect(original.arguments).toEqual(fixture.expectedApprovedSend); expect(original.accountBinding.instanceId).toBe(fixture.primary.id);
        const runs = getDb().prepare('SELECT id FROM agent_runs').all(); expect(runs).toHaveLength(1); const runId = runs[0].id;
        expect(fixture.modelRequests).toHaveLength(2); expect(fixture.simulatedSends).toHaveLength(0);
        await fixture.api('/api/connectors/email/active', { connectorId: 'google', instanceId: fixture.other.id, providerId: 'gmail' });
        await page.reload(); let card = await review(page);
        await expect(card).toContainText('Selected fixture account (gmail)'); await expect(card).toContainText(fixture.expectedApprovedSend.to); await expect(card).toContainText(fixture.expectedApprovedSend.body);
        expect(await card.evaluate((element) => element.action.arguments)).toEqual(original.arguments);
        expect(await card.evaluate((element) => element.action.accountBinding)).toEqual(original.accountBinding);
        await expect(card).not.toContainText('Other fixture account'); await expect(card).not.toContainText('fixture-primary-gmail');
        await returnAfterRestart(page, fixture); await page.getByRole('button', { name: 'Review approval', exact: true }).click();
        card = page.locator('.operation-review u2-approval'); await expect(card).toHaveAttribute('data-status', 'pending');
        expect(await card.evaluate((element) => element.action.arguments)).toEqual(original.arguments); expect(await card.evaluate((element) => element.action.accountBinding)).toEqual(original.accountBinding);
        expect(fixture.modelRequests).toHaveLength(2); expect(fixture.simulatedSends).toHaveLength(0);
        await card.locator(`[data-action="${outcome === 'rejected' ? 'reject' : 'approve'}"]`).click();
        await expect(card.locator('.u2-approval__status')).toHaveText(outcome === 'accepted' ? 'Approved and done' : outcome === 'uncertain' ? 'Outcome uncertain' : 'Cancelled');
        await expect(card.locator('[data-action]')).toHaveCount(0);
        const result = await fixture.api(`/api/agent/runs/${runId}/result`); expect(result.objectiveStatus).toBe('unverified');
        const queue = getQueuedActionByActionId(original.id);
        if (outcome === 'accepted') {
          expect(fixture.simulatedSends).toHaveLength(1); expect(queue.status).toBe('completed'); expect(listActionAttempts(queue.id)).toHaveLength(1);
          expect(result.steps.map((step) => step.status)).toEqual(['executed', 'executed', 'executed', 'executed']); expect(result.status).toBe('completed');
          expect(result.response).toContain(`gmail_${fixture.primary.id}_fixture_send_receipt`); expect(result.response).toContain('not independently verified'); expect(fixture.modelRequests).toHaveLength(3);
          expect(getDb().prepare("SELECT count(*) n FROM emails WHERE folder='drafts'").get().n).toBe(1);
        } else if (outcome === 'uncertain') {
          expect(fixture.simulatedSends).toHaveLength(1); expect(queue.error_class).toBe('outcome_uncertain'); expect(listActionAttempts(queue.id)).toHaveLength(1);
          expect(result.steps.map((step) => step.status)).toEqual(['executed', 'executed', 'outcome_uncertain', 'waiting_dependency']); expect(result.status).toBe('needs_attention');
          expect(result.response).toContain('outcome uncertain'); await expect(card).toContainText('no automatic retry');
          await expect(page.locator('.operation-card[data-outcome="uncertain"]')).toContainText(fixture.primary.id);
          expect(() => requeueAction(queue.id)).toThrow(/uncertain/i);
        } else {
          expect(queue).toBeNull(); expect(fixture.simulatedSends).toHaveLength(0);
          expect(result.steps.map((step) => step.status)).toEqual(['executed', 'executed', 'rejected', 'skipped']); expect(result.status).toBe('failed');
        }
        if (outcome !== 'accepted') { expect(fixture.modelRequests).toHaveLength(2); expect(getDb().prepare("SELECT count(*) n FROM emails WHERE folder IN ('drafts','sent')").get().n).toBe(0); }
        await fixture.api(`/api/actions/${original.id}/approve`, {}, 400);
        const models = fixture.modelRequests.length, sends = fixture.simulatedSends.length;
        await returnAfterRestart(page, fixture); await fixture.processQueue(); await fixture.api(`/api/agent/runs/${runId}/resume`, {});
        expect(fixture.simulatedSends).toHaveLength(sends); expect(fixture.modelRequests).toHaveLength(models);
        const restored = await fixture.api(`/api/actions/${original.id}`); expect(restored.arguments).toEqual(original.arguments); expect(restored.accountBinding).toEqual(original.accountBinding);
        expect(JSON.stringify({ original, restored, result })).not.toMatch(/fixture-(?:primary|other)-(?:gmail|calendar|refresh)|vault_key|vaultKey|access_token|refresh_token/);
        if (queue) expect(listActionAttempts(queue.id)).toHaveLength(1);
        const modelPayloads = JSON.stringify(fixture.modelRequests); expect(modelPayloads).not.toMatch(/fixture-primary-gmail|fixture-primary-refresh|fixture-other-gmail|vault_key/);
      } finally { await page.goto('about:blank').catch(() => {}); }
    });
  });
}
