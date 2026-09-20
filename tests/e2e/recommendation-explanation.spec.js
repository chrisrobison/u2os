import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { getDb } from '../../server/db/connection.js';

const PASSPHRASE = 'correct horse battery staple';

test('a recommendation-derived dashboard explains its relevance from stored provenance', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const calendarEvent = getDb().prepare("SELECT * FROM calendar_events WHERE title = 'Sync with Sarah'").get();
    const result = await dedicated.handle.agent.evaluateEvent({
      type: 'calendar.event_approaching',
      data: { eventId: calendarEvent.id, minutesUntil: 45 },
      subject: { type: 'calendar_event', id: calendarEvent.id },
    });

    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    const card = page.locator('u2-card', { has: page.locator('u2-recommendation') });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Prepared for you');
    await expect(card.locator('u2-dashboard .workspace__title')).toContainText('Sarah');

    await card.locator('u2-why summary').click();
    await expect(card.locator('u2-why')).toContainText('Meeting');
    await expect(card.locator('u2-why')).toContainText('Calendar event approaching');
    await expect(card.locator('u2-why')).toContainText(calendarEvent.id);
    await expect(card.locator('u2-why')).toContainText('Before your meeting with Sarah');

    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(card.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
    const stored = await page.evaluate(async (id) => (await fetch(`/api/recommendations/${id}`)).json(), result.recommendation.id);
    expect(stored.status).toBe('dismissed');

    await page.locator('u2-nav a[data-route="#/activity"]').click();
    const event = page.locator('.u2-timeline__item', { hasText: 'Finished an action' }).first();
    await expect(event.locator('u2-why summary')).toBeVisible();
    await event.locator('u2-why summary').click();
    await expect(event.locator('u2-why')).toContainText('Calendar event approaching');
  } finally {
    await stopDedicatedServer(page, dedicated);
  }
});
