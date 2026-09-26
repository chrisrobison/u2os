import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

// Presentation fixtures only: the approval response is intercepted and speech
// is collected in memory. No provider effect, microphone or real account.
async function withPage(browser, operation) {
  const dedicated = await startDedicatedServer(), context = await browser.newContext(), page = await context.newPage();
  try {
    await createOwner(dedicated.baseURL, 'fixture-only approval passphrase'); await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill('fixture-only approval passphrase'); await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.agent-panel__input')).toBeVisible();
    await page.evaluate(() => {
      const agent = document.querySelector('u2-agent'); window.fixtureSpeech = []; window.fixtureVoiceStates = [];
      agent._voiceMode = true; agent._pipeline = { setBusy: (state) => window.fixtureVoiceStates.push(state) };
      agent._speak = (sentence) => window.fixtureSpeech.push(sentence);
    });
    await operation(page);
  } finally { await context.close(); await stopDedicatedServer(null, dedicated); }
}
async function card(page, id, extra = {}) {
  await page.evaluate(({ id, extra }) => {
    const agent = document.querySelector('u2-agent'), element = document.createElement('u2-approval'); element.className = 'fixture-approval';
    element.action = { id, tool: 'email.send', status: 'pending', arguments: { to: 'recipient@example.test', subject: 'Fixture subject', body: 'Approved fixture body' },
      accountBinding: { providerId: 'gmail', instanceId: 'fixture_original', label: 'Original fixture account' }, ...extra };
    agent._transcript.appendChild(element); agent._pendingActionIds.add(id); window.fixtureSpeech = [];
  }, { id, extra });
  return page.locator('.fixture-approval').last();
}
test('uncertain approval keeps original preview and gives identical honest transcript/voice without private errors or retry controls', async ({ browser }) => withPage(browser, async (page) => {
  await page.route('**/api/actions/fixture_uncertain/approve', (route) => route.fulfill({ json: { status: 'failed', errorClass: 'outcome_uncertain',
    error: 'fixture-private-provider-error', result: { body: 'fixture-private-provider-body' } } }));
  const approval = await card(page, 'fixture_uncertain'); await expect(approval).toContainText('Original fixture account (gmail)'); await expect(approval).toContainText('recipient@example.test');
  await expect(approval).toContainText('Approved fixture body'); await approval.locator('[data-action="approve"]').click();
  await expect(approval.locator('.u2-approval__status')).toHaveText('Outcome uncertain');
  const sentence = 'Delivery outcome is uncertain. Check the originally approved account before a new proposal; no automatic retry.';
  await expect(approval.locator('.u2-approval__guidance')).toHaveText(sentence); await expect(page.locator('.chat-bubble.is-system').last()).toHaveText(sentence);
  expect(await page.evaluate(() => window.fixtureSpeech)).toEqual([sentence]); await expect(approval.locator('[data-action]')).toHaveCount(0);
  expect(await approval.textContent()).not.toMatch(/fixture-private|That didn't go through|Approved and done/);
}));
test('pending/stopped approval responses never speak completion while executed and rejected paths remain compatible', async ({ browser }) => withPage(browser, async (page) => {
  for (const [status, label, sentence] of [
    ...['approved', 'queued', 'leased', 'executing', 'retry_wait'].map((status) => [status, 'Approved; delivery pending', 'Approved; delivery is still pending.']),
    ...['failed', 'blocked', 'dead_letter'].map((status) => [status, 'Action stopped', 'Action stopped. Check Operations for the reason.']),
    ['executed', 'Approved and done', 'Done. Sent.'], ['rejected', 'Cancelled', 'Cancelled.'],
  ]) {
    const id = `fixture_${status}`; await page.route(`**/api/actions/${id}/approve`, (route) => route.fulfill({ json: { status, errorClass: 'fixture-private-class', error: 'fixture-private-error' } }));
    const approval = await card(page, id); await approval.locator('[data-action="approve"]').click();
    await expect(approval.locator('.u2-approval__status')).toHaveText(label); await expect(page.locator('.chat-bubble.is-system').last()).toHaveText(sentence);
    expect(await page.evaluate(() => window.fixtureSpeech)).toEqual([sentence]); expect(await approval.textContent()).not.toContain('fixture-private');
  }
}));
test('already-uncertain card cannot offer approval despite a contradictory pending status', async ({ browser }) => withPage(browser, async (page) => {
  const approval = await card(page, 'fixture_contradiction', { status: 'pending', errorClass: 'outcome_uncertain' });
  await expect(approval.locator('.u2-approval__status')).toHaveText('Outcome uncertain'); await expect(approval.locator('[data-action]')).toHaveCount(0);
  await expect(approval.locator('.u2-approval__guidance')).toContainText('no automatic retry');
}));
test('approval HTTP failure does not reflect private server text or speak success', async ({ browser }) => withPage(browser, async (page) => {
  await page.route('**/api/actions/fixture_http_failure/approve', (route) => route.fulfill({ status: 500, json: { error: 'fixture-private-provider-error-body' } }));
  const approval = await card(page, 'fixture_http_failure'); await approval.locator('[data-action="approve"]').click();
  await expect(approval.locator('.load-error')).toHaveText("Couldn't confirm approval. Delivery may still be pending; check Operations before trying again.");
  expect(await approval.textContent()).not.toContain('fixture-private'); expect(await page.evaluate(() => window.fixtureSpeech)).toEqual([]);
  await expect(approval.locator('.u2-approval__status')).toHaveCount(0); await expect(approval.locator('[data-action="approve"]')).toBeEnabled();
}));
