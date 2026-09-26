import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { getDb } from '../../server/db/connection.js';
import { createConnectionInstance } from '../../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../../server/integrations/connectors-config.js';

test('notification approval identifies the proposed named account without its webhook secret', async ({ page }) => {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    const first = createConnectionInstance(getDb(), { connectorId: 'webhook', label: 'Personal notifications',
      status: 'connected', credentials: { webhookUrl: 'https://notify.example.test/private-preview-token', format: 'json' }, dataDir: dedicated._dataDir });
    const second = createConnectionInstance(getDb(), { connectorId: 'webhook', label: 'Other notifications',
      status: 'connected', credentials: { webhookUrl: 'https://notify.example.test/other-private-token', format: 'json' }, dataDir: dedicated._dataDir });
    const config = loadConnectorsConfig(dedicated._dataDir);
    config.notifications = { ...config.notifications, active: 'webhook', activeInstanceId: first.id };
    saveConnectorsConfig(config, dedicated._dataDir);
    dedicated.handle.agent.policyEngine.policies.notifications.send = 'confirm';
    const action = await dedicated.handle.agent.evaluateAndMaybeExecute({ tool: 'notifications.send',
      arguments: { title: 'Research update', body: 'Review the new finding.' }, requestedBy: 'owner',
      requestText: 'Notify me', reasoningSummary: 'Fixture', correlationId: 'corr_preview', actor: { type: 'user', id: 'owner' } });
    expect(action.status).toBe('pending');
    config.notifications.activeInstanceId = second.id;
    saveConnectorsConfig(config, dedicated._dataDir);
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
    await page.evaluate(async (proposal) => {
      await import('/components/u2-approval.js');
      const card = document.createElement('u2-approval');
      card.id = 'notification-preview';
      card.action = proposal;
      document.querySelector('#workspace').append(card);
    }, action);
    const card = page.locator('#notification-preview');
    await expect(card).toContainText('Account: Personal notifications (webhook)');
    await expect(card).toContainText('Research update');
    await expect(card).toContainText('Review the new finding.');
    await expect(card).not.toContainText('private-preview-token');
    await expect(card).not.toContainText('Other notifications');
    await expect(card.locator('[data-action="approve"]')).toBeVisible();
    // No delivery is attempted; Node fixtures cover execution and invalidation.
  } finally { await stopDedicatedServer(page, dedicated); }
});
