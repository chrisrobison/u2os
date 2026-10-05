import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

// #438 and #439: projects and people open on their list, "+" creates a vault
// file, a row edits it, and tasks can be edited. Everything runs against a
// dedicated server with its own scratch vault.
const PASSPHRASE = 'correct horse battery staple';

test.describe.serial('projects, people and tasks (#438, #439)', () => {
  let dedicated;
  let context;
  let page;
  let vault;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
    vault = await page.evaluate(async () => (await (await fetch('/api/vault')).json()).vaultDir);
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  const dialog = (name) => page.getByRole('dialog', { name });

  test('+ creates a project as a vault file and it appears in the list', async () => {
    await page.goto(`${dedicated.baseURL}/#/projects`);
    await expect(page.locator('u2-section .workspace__title', { hasText: 'Projects' })).toBeVisible();
    await page.getByRole('button', { name: 'New project' }).click();
    const d = dialog('New project');
    await expect(d.getByLabel('Name')).toHaveValue('');

    await d.getByRole('button', { name: 'Create project' }).click();
    await expect(d.getByRole('alert').filter({ hasText: 'Name is required.' })).toBeVisible();

    await d.getByLabel('Name').fill('Replace roof');
    await d.getByLabel('Status').selectOption('planned');
    await d.getByLabel('Deadline').fill('2030-12-31');
    await d.getByLabel('Notes').fill('Get three quotes.');
    await d.getByRole('button', { name: 'Create project' }).click();
    await expect(d).toBeHidden();

    const row = page.locator('button.record-row', { hasText: 'Replace roof' });
    await expect(row).toContainText('planned');
    await expect(row).toContainText('Due 2030-12-31');
    await expect(page.getByRole('button', { name: 'New project' })).toBeFocused();

    const file = fs.readFileSync(path.join(vault, 'projects', 'replace-roof.md'), 'utf8');
    expect(file).toContain('name: Replace roof');
    expect(file).toContain('status: planned');
    expect(file).toContain('Get three quotes.');
  });

  test('a row opens the project filled from its file, and saving edits the file', async () => {
    await page.locator('button.record-row', { hasText: 'Replace roof' }).click();
    const d = dialog('Project');
    await expect(d.getByLabel('Name')).toHaveValue('Replace roof');
    await expect(d.getByLabel('Status')).toHaveValue('planned');
    await expect(d.getByLabel('Deadline')).toHaveValue('2030-12-31');
    await expect(d.getByLabel('Notes')).toHaveValue('Get three quotes.');

    const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);

    await d.getByLabel('Status').selectOption('blocked');
    await d.getByLabel('Deadline').fill('');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d).toBeHidden();
    await expect(page.locator('button.record-row', { hasText: 'Replace roof' })).toContainText('blocked');
    const file = fs.readFileSync(path.join(vault, 'projects', 'replace-roof.md'), 'utf8');
    expect(file).toContain('status: blocked');
    expect(file).not.toContain('deadline');
  });

  test('an edit made in the file shows up in the dialog (the file is the authority)', async () => {
    const file = path.join(vault, 'projects', 'replace-roof.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: blocked', 'status: done'));
    await page.locator('button.record-row', { hasText: 'Replace roof' }).click();
    await expect(dialog('Project').getByLabel('Status')).toHaveValue('done');
    await dialog('Project').getByRole('button', { name: 'Cancel' }).click();
  });

  test('a database-only project explains why it cannot be edited and links to details', async () => {
    await page.reload();
    await page.locator('button.record-row', { hasText: 'U2OS' }).first().click();
    const d = dialog('Project');
    await expect(d).toContainText('stored only in the database');
    await expect(d.getByLabel('Name')).not.toBeEditable();
    await expect(d.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await d.getByRole('button', { name: 'Open details' }).click();
    await expect(page).toHaveURL(/#\/projects\/ent_/);
  });

  test('People: add a person with a keep-in-touch cadence and see who is due', async () => {
    await page.goto(`${dedicated.baseURL}/#/people`);
    await expect(page.locator('u2-section .workspace__title', { hasText: 'People' })).toBeVisible();
    await expect(page.locator('button.record-row', { hasText: 'Chris' })).toHaveCount(0); // the owner is not a contact

    await page.getByRole('button', { name: 'New person' }).click();
    const d = dialog('New person');
    await d.getByLabel('Name').fill('Dana Reyes');
    await d.getByLabel('Relationship to you').fill('sister');
    await d.getByLabel('Email').fill('dana@example.com');
    await d.getByLabel('Keep in touch every (days)').fill('14');
    await d.getByLabel('Last contact').fill('2020-01-01');
    await d.getByRole('button', { name: 'Create person' }).click();
    await expect(d).toBeHidden();

    const row = page.locator('button.record-row', { hasText: 'Dana Reyes' });
    await expect(row).toContainText('sister');
    await expect(row.locator('.record-row__badge.is-due')).toContainText('Overdue by');
    expect(fs.readFileSync(path.join(vault, 'people', 'dana-reyes.md'), 'utf8')).toContain('keep_in_touch_days: 14');
  });

  test('People: search filters the list and clearing it restores everyone', async () => {
    const search = page.getByRole('searchbox', { name: 'Search people' });
    await search.fill('sister');
    await expect(page.locator('button.record-row')).toHaveCount(1);
    await search.fill('zzz');
    await expect(page.getByText('No one matches that search.')).toBeVisible();
    await search.fill('');
    expect(await page.locator('button.record-row').count()).toBeGreaterThan(1);
  });

  test('People: recording contact clears the overdue badge', async () => {
    await page.locator('button.record-row', { hasText: 'Dana Reyes' }).click();
    const d = dialog('Person');
    await expect(d.getByLabel('Last contact')).toHaveValue('2020-01-01');
    const today = await page.evaluate(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; });
    await d.getByLabel('Last contact').fill(today);
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d).toBeHidden();
    const row = page.locator('button.record-row', { hasText: 'Dana Reyes' });
    await expect(row.locator('.record-row__badge')).toContainText('Next in 14 days');
    await expect(row.locator('.record-row__badge.is-due')).toHaveCount(0);
  });

  test('a person whose file was made invalid is refused and left alone', async () => {
    const file = path.join(vault, 'people', 'dana-reyes.md');
    await page.locator('button.record-row', { hasText: 'Dana Reyes' }).click();
    const d = dialog('Person');
    // The dialog opens once the record has been read; only then break the file.
    await expect(d.getByLabel('Name')).toHaveValue('Dana Reyes');
    const broken = '---\nname: [unclosed\n---\nx\n';
    fs.writeFileSync(file, broken);
    await d.getByLabel('Relationship to you').fill('twin');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d.getByRole('alert').filter({ hasText: 'invalid frontmatter' })).toBeVisible();
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
    page.once('dialog', (confirm) => confirm.accept()); // discard the unsaved edit
    await d.getByRole('button', { name: 'Cancel' }).click();
    await expect(d).toBeHidden();
  });

  test('Tasks: a task can be edited, completed and reopened', async () => {
    await page.goto(`${dedicated.baseURL}/#/tasks`);
    await page.getByRole('button', { name: 'New task' }).click();
    await dialog('New task').getByLabel('Title').fill('Call the school');
    await dialog('New task').getByRole('button', { name: 'Create task' }).click();
    await expect(page.locator('.u2-task__title', { hasText: 'Call the school' })).toBeVisible();

    await page.locator('button.u2-task--select', { hasText: 'Call the school' }).click();
    const d = dialog('Task');
    await expect(d.getByLabel('Title')).toBeEditable();
    await d.getByLabel('Title').fill('Call the school office');
    await d.getByLabel('Due date').fill('2031-03-04');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d).toBeHidden();
    const task = page.locator('button.u2-task--select', { hasText: 'Call the school office' });
    await expect(task).toContainText('Mar 4');

    await task.click();
    await dialog('Task').getByRole('button', { name: 'Mark complete' }).click();
    await expect(page.locator('.u2-task__title.is-completed', { hasText: 'Call the school office' })).toBeVisible();

    await page.locator('button.u2-task--select', { hasText: 'Call the school office' }).click();
    await expect(dialog('Task')).toContainText('This task is completed.');
    await dialog('Task').getByRole('button', { name: 'Reopen' }).click();
    await expect(page.locator('.u2-task__title.is-completed', { hasText: 'Call the school office' })).toHaveCount(0);
  });
});

test('a record whose file cannot be read says so instead of showing an empty form', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
    const vault = await page.evaluate(async () => (await (await fetch('/api/vault')).json()).vaultDir);
    await page.goto(`${dedicated.baseURL}/#/people`);
    await page.getByRole('button', { name: 'New person' }).click();
    await page.getByRole('dialog', { name: 'New person' }).getByLabel('Name').fill('Erin');
    await page.getByRole('dialog', { name: 'New person' }).getByRole('button', { name: 'Create person' }).click();
    await expect(page.locator('button.record-row', { hasText: 'Erin' })).toBeVisible();
    fs.writeFileSync(path.join(vault, 'people', 'erin.md'), '---\nname: [unclosed\n---\nhi\n');
    await page.locator('button.record-row', { hasText: 'Erin' }).click();
    await expect(page.getByRole('dialog', { name: 'Person' })).toContainText("Couldn't open this record");
    await context.close();
  } finally {
    await stopDedicatedServer(null, dedicated);
  }
});
