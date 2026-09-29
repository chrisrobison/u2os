import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDedicatedServer } from './helpers.js';

// Issue #423: step 1 of the wizard can point U2OS at an existing vault.

const PASSPHRASE = 'onboarding vault fixture owner passphrase';

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

async function startWizard(page, baseURL) {
  await page.goto(baseURL);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('.workspace__subtitle')).toContainText('Step 1 of 7');
}

test.describe('wizard: use an existing vault (#423)', () => {
  test('an existing vault is summarized, adopted, untouched, and its me.md appears in step 2', async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-e2e-existing-vault-'));
    const vault = path.join(root, 'my-vault');
    const marker = path.join(root, 'tool-server-launched');
    const files = {
      'me.md': '---\nname: Existing Owner\nclassification: personal\n---\nMy real notes.\n',
      'people/alice.md': '---\nname: Alice Chen\n---\nA.\n',
      'people/bob.md': '---\nname: Bob Ng\n---\nB.\n',
      'routines/brief.md': '---\nwhen:\n  daily: "07:00"\n---\nBrief me.\n',
      'mcp.yaml': `servers:\n  probe:\n    command: node\n    args: ${JSON.stringify(['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`])}\n    tools:\n      ping: { read: true }\n`,
    };
    write(vault, files);
    try {
      await withDedicatedServer(page, {}, async ({ baseURL }) => {
        await startWizard(page, baseURL);
        await page.locator('u2-onboarding input[name="vaultDir"]').fill(vault);
        await page.getByRole('button', { name: 'Check folder', exact: true }).click();
        const result = page.locator('u2-onboarding [data-vault-result]');
        await expect(result).toContainText('Found an existing vault');
        await expect(result).toContainText('2 person files');
        await expect(result).toContainText('1 routine');
        await expect(result).toContainText('probe');
        // Nothing has changed yet, and the tool server has not been launched.
        expect(fs.existsSync(path.join(vault, 'README.md'))).toBe(false);
        await expect(page.locator('u2-onboarding [data-vault-start-tools]')).not.toBeChecked();
        await page.getByRole('button', { name: 'Use this vault', exact: true }).click();
        await expect(page.locator('u2-onboarding .onboarding-message')).toContainText(`Now using ${vault}`);
        await expect(page.locator('u2-onboarding [data-vault-current]')).toHaveText(vault);
        await page.waitForTimeout(300);
        expect(fs.existsSync(marker)).toBe(false);
        for (const [file, content] of Object.entries(files)) expect(fs.readFileSync(path.join(vault, file), 'utf8')).toBe(content);

        await page.locator('u2-onboarding [data-next]').click();
        await expect(page.locator('.workspace__subtitle')).toContainText('Step 2 of 7');
        await expect(page.locator('u2-onboarding textarea[name="content"]')).toHaveValue(files['me.md']);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a folder that is not a vault needs an explicit confirmation before it is used', async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-e2e-plain-folder-'));
    const folder = path.join(root, 'documents');
    write(folder, { 'taxes/return.txt': 'private', 'notes.md': 'hello' });
    try {
      await withDedicatedServer(page, {}, async ({ baseURL }) => {
        await startWizard(page, baseURL);
        await page.locator('u2-onboarding input[name="vaultDir"]').fill(folder);
        await page.getByRole('button', { name: 'Check folder', exact: true }).click();
        await expect(page.locator('u2-onboarding [data-vault-result]')).toContainText('does not look like a U2OS vault');
        const use = page.getByRole('button', { name: 'Use this folder', exact: true });
        await expect(use).toBeDisabled();
        expect(fs.existsSync(path.join(folder, 'people'))).toBe(false);
        await page.locator('u2-onboarding [data-vault-confirm]').check();
        await expect(use).toBeEnabled();
        await use.click();
        await expect(page.locator('u2-onboarding .onboarding-message')).toContainText(`Now using ${folder}`);
        expect(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('hello');
        expect(fs.readFileSync(path.join(folder, 'taxes', 'return.txt'), 'utf8')).toBe('private');
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a new folder and blank input behave sensibly', async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-e2e-new-folder-'));
    try {
      await withDedicatedServer(page, {}, async ({ baseURL }) => {
        await startWizard(page, baseURL);
        await page.getByRole('button', { name: 'Check folder', exact: true }).click();
        await expect(page.locator('u2-onboarding .onboarding-message')).toContainText('Enter a folder to check');
        const fresh = path.join(root, 'fresh-vault');
        await page.locator('u2-onboarding input[name="vaultDir"]').fill(fresh);
        await page.getByRole('button', { name: 'Check folder', exact: true }).click();
        await expect(page.locator('u2-onboarding [data-vault-result]')).toContainText('does not exist yet');
        await page.getByRole('button', { name: 'Create vault here', exact: true }).click();
        await expect(page.locator('u2-onboarding .onboarding-message')).toContainText(`Now using ${fresh}`);
        expect(fs.statSync(path.join(fresh, 'people')).isDirectory()).toBe(true);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
