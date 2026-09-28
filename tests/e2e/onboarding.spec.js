import { test, expect } from '@playwright/test';
import { withDedicatedServer } from './helpers.js';

// Issue #413: a fresh install walks the owner through the 7-step onboarding
// wizard before reaching the dashboard; a second login for the same
// (now onboarded) owner goes straight to the dashboard, exactly like before
// the wizard existed. See docs/onboarding.md.

const PASSPHRASE = 'onboarding wizard fixture owner passphrase';

test.describe('onboarding wizard (#413)', () => {
  test('a fresh install walks all 7 steps to the dashboard, and a second login skips straight to it', async ({ page }) => {
    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      await page.goto(baseURL);

      // Real first-run setup form (not the createOwner() API shortcut, which
      // marks onboarding complete on the owner's behalf for every other spec).
      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();

      await expect(page.locator('u2-onboarding')).toBeVisible();
      await expect(page.locator('u2-nav')).toHaveCount(0);
      await expect(page.locator('.workspace__subtitle')).toContainText('Step 1 of 7');

      // Step 1: vault location -- leave blank, just move on.
      await expect(page.locator('u2-onboarding')).toContainText('Your vault is a folder of Markdown files');
      await page.locator('u2-onboarding [data-next]').click();

      // Step 2: me.md -- edit and save.
      await expect(page.locator('.workspace__subtitle')).toContainText('Step 2 of 7');
      const textarea = page.locator('u2-onboarding textarea[name="content"]');
      await expect(textarea).toBeVisible();
      await textarea.fill('---\nname: Fixture Owner\nclassification: personal\n---\nOnboarding e2e fixture.\n');
      await page.locator('u2-onboarding button', { hasText: 'Save me.md' }).click();
      await expect(page.locator('u2-onboarding .onboarding-message')).toHaveText('Saved.');
      await page.locator('u2-onboarding [data-next]').click();

      // Step 3: model -- the existing <u2-model> embed renders; skip filling it in.
      await expect(page.locator('.workspace__subtitle')).toContainText('Step 3 of 7');
      await expect(page.locator('u2-onboarding u2-model')).toBeVisible();
      await page.locator('u2-onboarding [data-next]').click();

      // Step 4: connect -- the embedded <u2-connectors> is filtered to just
      // Gmail/Calendar/Contacts (no Web Search / Notifications cards).
      await expect(page.locator('.workspace__subtitle')).toContainText('Step 4 of 7');
      await expect(page.locator('u2-onboarding u2-connectors')).toBeVisible();
      await expect(page.locator('u2-onboarding u2-card[title="Calendar"]')).toBeVisible();
      await expect(page.locator('u2-onboarding u2-card[title="Web Search"]')).toHaveCount(0);
      await page.locator('u2-onboarding [data-next]').click();

      // Step 5: starter routines -- install one.
      await expect(page.locator('.workspace__subtitle')).toContainText('Step 5 of 7');
      await page.locator('u2-onboarding input[type="checkbox"][value="morning-brief"]').check();
      await page.locator('u2-onboarding button', { hasText: 'Install selected' }).click();
      await expect(page.locator('u2-onboarding .onboarding-message')).toContainText('Installed: morning-brief');
      await page.locator('u2-onboarding [data-next]').click();

      // Step 6: review -- summarizes the installed routine and the policy it runs under.
      await expect(page.locator('.workspace__subtitle')).toContainText('Step 6 of 7');
      await expect(page.locator('u2-onboarding')).toContainText('Morning brief');
      await page.locator('u2-onboarding [data-next]').click();

      // Step 7: finish -- into the real dashboard shell.
      await expect(page.locator('.workspace__subtitle')).toContainText('Step 7 of 7');
      await page.locator('u2-onboarding button', { hasText: 'Go to my dashboard' }).click();

      await expect(page.locator('u2-nav')).toBeVisible();
      await expect(page.locator('u2-onboarding')).toHaveCount(0);

      // The installed routine actually shows up in the Routines view.
      await page.locator('u2-nav a[data-route="#/routines"]').click();
      await expect(page.locator('#workspace')).toContainText('morning-brief');

      // Reload: still straight to the dashboard, no wizard.
      await page.goto(baseURL);
      await expect(page.locator('u2-nav')).toBeVisible();
      await expect(page.locator('u2-onboarding')).toHaveCount(0);

      // Log out and log back in: same owner, onboarding already complete,
      // straight to the dashboard again -- not the wizard.
      await page.evaluate(() => import('/services/api.js').then((m) => m.logout()));
      await page.reload();
      await expect(page.locator('input[name="passphrase"]')).toBeVisible();
      await expect(page.locator('form button[type="submit"]')).toHaveText('Log in');

      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();
      await expect(page.locator('u2-nav')).toBeVisible();
      await expect(page.locator('u2-onboarding')).toHaveCount(0);
    });
  });

  test('the wizard can be reopened from the nav without re-gating an onboarded owner', async ({ page }) => {
    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      const { createOwner } = await import('./helpers.js');
      await createOwner(baseURL, PASSPHRASE);
      await page.goto(baseURL);
      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();
      await expect(page.locator('u2-nav')).toBeVisible();

      await page.locator('u2-nav a[data-route="#/onboarding"]').click();
      await expect(page.locator('u2-onboarding')).toBeVisible();
      // Reopened mid-app: the surrounding shell (nav) stays mounted, unlike
      // the full-page first-run takeover.
      await expect(page.locator('u2-nav')).toBeVisible();

      await page.locator('u2-onboarding [data-goto-step="6"]').click();
      await page.locator('u2-onboarding button', { hasText: 'Go to my dashboard' }).click();
      await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
    });
  });
});
