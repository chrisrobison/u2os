import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

// #434: the shared section pattern. A data section opens on its list, the "+"
// button opens an empty modal, and selecting a row opens the same modal
// populated. Tasks is the first section to use it.
const PASSPHRASE = 'correct horse battery staple';

test.describe.serial('section pattern with record modal (#434)', () => {
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
    await page.goto(`${dedicated.baseURL}/#/tasks`);
    await expect(page.locator('u2-section .workspace__title', { hasText: 'Tasks' })).toBeVisible();
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  test('the plus button opens an empty modal and creating adds the task to the list', async () => {
    const add = page.getByRole('button', { name: 'New task' });
    await add.click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title')).toHaveValue('');
    await expect(dialog.getByLabel('Title')).toBeFocused();

    // Required field is validated inline and keeps the dialog open.
    await dialog.getByRole('button', { name: 'Create task' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Title is required.' })).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Title').fill('Book dentist appointment');
    await dialog.getByLabel('Due date').fill('2030-05-17');
    await dialog.getByRole('button', { name: 'Create task' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.u2-task__title', { hasText: 'Book dentist appointment' })).toBeVisible();
    await expect(add).toBeFocused();
  });

  test('selecting a row opens the modal populated and a task can be completed', async () => {
    await page.locator('button.u2-task--select', { hasText: 'Book dentist appointment' }).click();
    const dialog = page.getByRole('dialog', { name: 'Task' });
    await expect(dialog.getByLabel('Title')).toHaveValue('Book dentist appointment');
    await expect(dialog.getByLabel('Due date')).toHaveValue('2030-05-17');

    const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);

    await dialog.getByRole('button', { name: 'Mark complete' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.u2-task__title.is-completed', { hasText: 'Book dentist appointment' })).toBeVisible();
  });

  test('Escape closes a clean dialog and a dirty one asks before discarding', async () => {
    const add = page.getByRole('button', { name: 'New task' });
    await add.click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();

    await add.click();
    await dialog.getByLabel('Title').fill('Unsaved');
    page.once('dialog', (confirm) => confirm.dismiss());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    page.once('dialog', (confirm) => confirm.accept());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.u2-task__title', { hasText: 'Unsaved' })).toHaveCount(0);
  });

  test('dashboard task cards stay read-only', async () => {
    await page.goto(`${dedicated.baseURL}/#/home`);
    await expect(page.locator('u2-card[title="Tasks"] .u2-task').first()).toBeVisible();
    await expect(page.locator('u2-card[title="Tasks"] button.u2-task--select')).toHaveCount(0);
  });
});
