import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { DeviceRegistry } from '../../server/devices/device-registry.js';
import { MockDeviceAdapter } from '../../server/devices/adapters/mock-device-adapter.js';

for (const scenario of ['personal', 'demo', 'legacy']) test(`devices distinguish ${scenario} fixtures from current adapter availability`, async ({ page }) => {
  const dedicated = await startDedicatedServer({ mode: scenario === 'demo' ? 'demo' : 'personal' });
  try {
    if (scenario === 'legacy') {
      const fixture = new DeviceRegistry({ db: dedicated.handle.deviceRegistry.db });
      await fixture.registerAdapter(new MockDeviceAdapter());
      fixture.updateDevice('mock.display.livingroom', { name: 'Preserved owner display' });
      fixture.setTrust('mock.display.livingroom', 'revoked');
      await fixture.stopAll();
    }
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/devices"]').click();
    const devices = page.locator('u2-devices');
    await expect(devices.locator('.device-debug-status')).toBeVisible();
    const mocks = devices.locator('[data-device-row^="mock."]');
    await expect(mocks).toHaveCount(scenario === 'personal' ? 0 : 5);
    if (scenario !== 'personal') {
      const display = devices.locator('[data-device-row="mock.display.livingroom"]');
      await expect(display.locator('.device-availability')).toContainText(scenario === 'demo'
        ? 'Demo device · Adapter registered' : 'Demo device · Cached record: adapter unavailable');
      await expect(display.locator('.device-availability')).toContainText('last observed online');
      if (scenario === 'legacy') {
        await expect(display).toContainText('Preserved owner display');
        await expect(display).toContainText('Revoked');
      }
    }
    await page.reload();
    await expect(page.locator('u2-devices [data-device-row^="mock."]')).toHaveCount(scenario === 'personal' ? 0 : 5);
  } finally { await stopDedicatedServer(page, dedicated); }
});
