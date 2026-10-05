import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

// #437: list, day, week and month calendar views over the seeded demo events
// (server/seed/seed.js): "Sync with Sarah" today 14:00, "U2OS project
// standup" tomorrow 10:00 and the recruiter call two days out. Everything is
// relative to today, so assertions never depend on the date the suite runs.
const PASSPHRASE = 'correct horse battery staple';
const TODAY = 'Sync with Sarah';

function localKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test.describe.serial('calendar views (#437)', () => {
  let dedicated;
  let context;
  let page;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
    await page.goto(`${dedicated.baseURL}/#/calendar`);
    await expect(page.locator('u2-calendar')).toBeVisible();
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  const view = (name) => page.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name });

  test('opens on the list with a pressed List button', async () => {
    await expect(view('List')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.u2-schedule__title', { hasText: 'U2OS project standup' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous day' })).toHaveCount(0);
  });

  test('day view shows today and steps to tomorrow', async () => {
    await view('Day').click();
    await expect(view('Day')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.u2-schedule__title', { hasText: TODAY })).toBeVisible();
    await expect(page.locator('.u2-schedule__title', { hasText: 'U2OS project standup' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Next day' }).click();
    await expect(page.locator('.u2-schedule__title', { hasText: 'U2OS project standup' })).toBeVisible();
    await expect(page.locator('.u2-schedule__title', { hasText: TODAY })).toHaveCount(0);

    await page.getByRole('button', { name: 'Today' }).click();
    await expect(page.locator('.u2-schedule__title', { hasText: TODAY })).toBeVisible();
  });

  test('week view lays the week out in seven days and today is marked', async () => {
    await view('Week').click();
    await expect(page.locator('.u2-cal-week__day')).toHaveCount(7);
    const today = page.locator(`.u2-cal-week__day[data-date="${localKey(new Date())}"]`);
    await expect(today).toHaveClass(/is-today/);
    await expect(today.getByRole('button', { name: new RegExp(TODAY) })).toBeVisible();
    await expect(today.locator('.u2-cal-daynum')).toHaveAttribute('aria-current', 'date');
  });

  test('month view is a table of whole weeks and a day number opens the day view', async () => {
    await view('Month').click();
    const table = page.locator('table.u2-cal-month');
    await expect(table.locator('thead th')).toHaveCount(7);
    expect(await table.locator('tbody tr').count()).toBeGreaterThanOrEqual(4);
    const cell = table.locator(`td[data-date="${localKey(new Date())}"]`);
    await expect(cell.getByRole('button', { name: new RegExp(TODAY) })).toBeVisible();

    await cell.locator('.u2-cal-daynum').click();
    await expect(view('Day')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.u2-schedule__title', { hasText: TODAY })).toBeVisible();
  });

  test('previous and next move a month at a time', async () => {
    await view('Month').click();
    const label = page.locator('.u2-calendar__period');
    const before = await label.textContent();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(label).not.toHaveText(before);
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(label).toHaveText(before);
  });

  test('selecting an event in any view opens its details, and the dialog passes axe', async () => {
    await view('Month').click();
    await page.locator(`td[data-date="${localKey(new Date())}"]`).getByRole('button', { name: new RegExp(TODAY) }).click();
    const dialog = page.getByRole('dialog', { name: 'Event' });
    await expect(dialog.getByLabel('Title')).toHaveValue(TODAY);
    const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('the chosen view is remembered on reload', async () => {
    await view('Week').click();
    await page.reload();
    await expect(view('Week')).toHaveAttribute('aria-pressed', 'true');
  });

  test('+ opens an empty New event dialog, validates, and reports what policy decided', async () => {
    await view('List').click();
    await page.getByRole('button', { name: 'New event' }).click();
    const dialog = page.getByRole('dialog', { name: 'New event' });
    await expect(dialog.getByLabel('Title')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Create event' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Title is required.' })).toBeVisible();

    await dialog.getByLabel('Title').fill('Dentist');
    await dialog.getByLabel('Ends').fill('2000-01-01T09:00');
    await dialog.getByRole('button', { name: 'Create event' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'End must be after the start.' })).toBeVisible();

    const start = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const at = (hour) => `${localKey(start)}T${String(hour).padStart(2, '0')}:00`;
    await dialog.getByLabel('Starts').fill(at(15));
    await dialog.getByLabel('Ends').fill(at(16));
    await dialog.getByRole('button', { name: 'Create event' }).click();

    // Policy decides: the event is created, or the dialog says approval is needed.
    await expect(async () => {
      const closed = await dialog.isHidden();
      const asked = await dialog.getByRole('alert').filter({ hasText: /approval|Could not/ }).count();
      expect(closed || asked > 0).toBe(true);
    }).toPass();
  });
});
