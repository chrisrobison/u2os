import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startDedicatedServer, stopDedicatedServer, createOwner, gotoNav } from './helpers.js';

const passphrase = 'fixture-only model connections owner';

test('owner builds an ordered list of CLI and API connections, reorders, saves and tests them', async ({ page }) => {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  try {
    const script = path.join(dedicated._dataDir, 'fake-model.js');
    fs.writeFileSync(script, "process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log(JSON.stringify({reasoning_summary:'ok',actions:[]})));");
    await createOwner(dedicated.baseURL, passphrase); await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(passphrase); await page.locator('form button[type="submit"]').click();
    await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
    await gotoNav(page, '#/model');
    const panel = page.locator('u2-model-connections');
    await expect(panel).toContainText('No connections yet');

    const add = async (kind, name, extra = async () => {}) => {
      await panel.getByRole('button', { name: 'Add a connection' }).click();
      await panel.locator('select[name="kind"]').selectOption(kind);
      await panel.locator('input[name="id"]').fill(name);
      await extra();
      await panel.getByRole('button', { name: 'Keep this connection' }).click();
    };
    await add('cli:claude', 'claude-sub');
    await add('cli:custom', 'fake', async () => {
      await panel.locator('input[name="executable"]').fill(process.execPath);
      await panel.locator('textarea[name="args"]').fill(script);
    });
    await add('anthropic', 'hosted', async () => {
      await panel.locator('input[name="model"]').fill('claude-fixture');
      await panel.locator('input[name="apiKey"]').fill('fixture-ui-connection-key');
    });
    const rows = panel.locator('li.model-connection');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('1. claude-sub');
    // move "fake" to the top
    await rows.nth(1).getByRole('button', { name: 'Up' }).click();
    await expect(rows.nth(0)).toContainText('1. fake');
    await expect(rows.nth(1)).toContainText('2. claude-sub');
    await panel.getByRole('button', { name: 'Save connections' }).click();
    await expect(panel.locator('.model-connections-status')).toContainText('Saved and applied');

    await page.reload();
    await expect(panel.locator('li.model-connection')).toHaveCount(3);
    await expect(panel.locator('li.model-connection').nth(0)).toContainText('1. fake');
    await expect(panel.locator('li.model-connection').nth(2)).toContainText('3. hosted');
    await expect(page.locator('u2-model .model-status')).toContainText('configured');
    const body = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/model')).json()));
    expect(body).not.toContain('fixture-ui-connection-key');

    await panel.locator('li.model-connection').nth(0).getByRole('button', { name: 'Send test prompt' }).click();
    await expect(panel.locator('li.model-connection').nth(0)).toContainText('OK: The tool answered a test prompt');
    expect(dedicated.handle.modelRouter.resolve('planner').id).toBe('cli:custom');
  } finally { await stopDedicatedServer(page, dedicated); }
});
