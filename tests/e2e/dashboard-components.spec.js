import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('trusted dashboard cards render structured data without interpreting markup', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, 'correct horse battery staple');
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.evaluate(() => {
      const dashboard = document.createElement('u2-dashboard'); dashboard.id = 'structured-probe';
      const provenance = { reason: 'Relevant because <img src=x onerror="window.__unsafe = true">', references: [{ type: 'document', id: 'doc_1', label: '<script>source</script>' }] };
      dashboard.schema = { title: 'Structured cards', layout: 'dashboard', components: [
        { type: 'conversation', provenance, data: { thread: 'Jamie <img src=x onerror=alert(1)>', messages: [{ sender: 'Jamie', text: '<script>bad()</script>' }], summary: 'Follow-up', unresolvedQuestion: 'When?', nextStep: 'Reply' } },
        { type: 'document', provenance, data: { title: 'Budget <script>bad()</script>', type: 'PDF', source: 'local', excerpt: '<img src=x>', whyRelevant: 'Meeting tomorrow' } },
        { type: 'chart', provenance, data: { series: [{ label: 'Tasks', values: [{ label: 'Open', value: 3 }, { label: 'Done', value: 5 }] }] } },
        { type: 'map', provenance, data: { locations: [{ label: 'Home', latitude: 37.7, longitude: -122.4 }] } },
        { type: 'photo-grid', provenance, data: { photos: [{ src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', caption: '<script>caption</script>' }] } },
      ] };
      document.body.append(dashboard);
    });
    const probe = page.locator('#structured-probe');
    await expect(probe.locator('u2-conversation')).toContainText('<script>bad()</script>');
    await expect(probe.locator('u2-document')).toContainText('<img src=x>');
    await expect(probe.locator('u2-conversation script, u2-conversation img, u2-document script, u2-document img')).toHaveCount(0);
    await expect(probe.locator('u2-chart')).toContainText('Done');
    await expect(probe.locator('u2-map')).toContainText('Home (37.7, -122.4)');
    await expect(probe.locator('u2-photo-grid figcaption')).toHaveText('<script>caption</script>');
    await expect(probe.locator('u2-photo-grid script')).toHaveCount(0);
    await expect(probe.locator('u2-card > .u2-card__body > u2-why summary')).toHaveCount(5);
    await probe.locator('u2-card').first().locator('u2-why summary').click();
    await expect(probe.locator('u2-card').first().locator('u2-why')).toContainText('Relevant because <img');
    await expect(probe.locator('u2-why img, u2-why script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();
  } finally { await context.close(); await stopDedicatedServer(null, dedicated); }
});
