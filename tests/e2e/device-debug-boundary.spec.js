import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

for (const scenario of [
  { name: 'normal', developmentMode: false },
  { name: 'development', developmentMode: true },
  { name: 'unknown metadata', developmentMode: true, omitFlag: true },
]) test(`device UI keeps raw tests ${scenario.name === 'development' ? 'explicitly development-only' : 'disabled'} in ${scenario.name} mode`, async ({ page }) => {
  const dedicated = await startDedicatedServer({ developmentMode: scenario.developmentMode });
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    if (scenario.omitFlag) await page.route('**/api/devices', async (route) => {
      const response = await route.fetch();
      const body = await response.json(); delete body.debugActionsEnabled;
      await route.fulfill({ response, json: body });
    });
    let tests = 0;
    page.on('request', (request) => { if (request.url().endsWith('/test')) tests++; });
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/devices"]').click();
    const devices = page.locator('u2-devices');
    const sensor = devices.locator('[data-device-row="mock.sensor.temperature.office"]');
    await sensor.locator('[data-toggle-device]').click();
    const chip = sensor.locator('[data-test-capability="temperature.read"]');
    if (scenario.name === 'development') {
      await expect(devices.locator('.device-debug-status')).toContainText('bypass normal action policy and audit');
      await expect(chip).toBeEnabled();
      await chip.click();
      await expect(sensor.locator('.device-message')).toContainText('celsius');
      expect(tests).toBe(1);
    } else {
      await expect(chip).toBeDisabled();
      await expect(devices.locator('.device-debug-status')).toContainText('Direct device tests are disabled');
      await devices.evaluate((element) => element._testCapability('mock.sensor.temperature.office', 'temperature.read'));
      expect(tests).toBe(0);
    }
  } finally { await stopDedicatedServer(page, dedicated); }
});
