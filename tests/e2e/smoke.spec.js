import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { STATE_FILE } from './state-file.js';

// #13 acceptance: boot the real server, open the real first-run setup
// screen in a real browser, assert the shell/app root renders. No coverage
// of actual auth submission or navigation -- that's #14 onward.
test('first-run setup screen renders', async ({ page }) => {
  const { baseURL } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  await page.goto(baseURL);

  await expect(page.locator('u2-app')).toBeVisible();

  const passphrase = page.locator('input[name="passphrase"][type="password"]');
  await expect(passphrase).toBeVisible();
  await expect(passphrase).toHaveAttribute('minlength', '12');

  await expect(page.locator('form button[type="submit"]')).toHaveText('Create owner');
});
