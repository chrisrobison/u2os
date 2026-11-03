import path from 'node:path';
import { expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { seedPolishStore } from '../helpers/job-hunt-polish-seed.js';

// Shared by the job-hunt polish and journey specs (#653): one real server seeded through the hunt store (no stubbed
// endpoints), one sign-in, and a page factory that takes a viewport, a theme and touch.

export const PASSPHRASE = 'correct horse battery staple';

export async function startSeededServer(options = {}) {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const ids = seedPolishStore(path.join(dedicated._dataDir, 'vault'), options);
  return { dedicated, ids, baseURL: dedicated.baseURL, stop: () => stopDedicatedServer(null, dedicated) };
}

/** Signs in once and returns the storage state later pages reuse (the login route rate-limits repeated sign-ins). */
export async function signInState(browser, baseURL) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/#/job-hunt`);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('input[name="passphrase"]')).toHaveCount(0);
  await expect(page.locator('u2-nav')).toBeVisible();
  const state = await context.storageState();
  await context.close();
  return state;
}

/** A signed-in page at `hash`. `theme` is 'light' or 'dark'; `touch` emulates a coarse pointer. */
export async function openPage(browser, { baseURL, state, hash = '#/job-hunt', width = 1280, height = 900, theme = 'light', touch = false, reducedMotion = 'no-preference' }) {
  const context = await browser.newContext({ storageState: state, viewport: { width, height }, hasTouch: touch, reducedMotion });
  const page = await context.newPage();
  await page.goto(`${baseURL}/${hash}`);
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  return { context, page };
}

/** Waits until the view for `kind` has drawn real data. */
export async function ready(page, kind) {
  kind = { readyPage: 'page', readyPanel: 'panel' }[kind] ?? kind;
  const selector = {
    overview: 'u2-job-overview jh-summary-card .jh-summary-card__value',
    opportunities: 'u2-job-opportunities tr[data-job]',
    panel: 'u2-job-detail-panel [data-part="heading"]',
    operations: 'u2-job-operations .jh-ov__top h1',
    page: 'u2-job-page .jh-details__role',
  }[kind];
  await expect(page.locator(selector).first()).toBeVisible();
  if (kind === 'overview') await expect(page.locator('u2-job-dashboard .jh-col').first()).toBeVisible();
  if (kind === 'panel') await expect(page.locator('tr[data-job]').first()).toBeVisible();
  // let a settled layout and any first-render focus move finish
  await page.waitForTimeout(150);
}

export const noPageScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

export const viewHash = (ids) => ({
  overview: '#/job-hunt',
  opportunities: '#/job-hunt/opportunities',
  panel: `#/job-hunt/opportunities?job=${ids['needs-1']}`,
  operations: '#/job-hunt/operations',
  page: `#/job-hunt/jobs/${ids['needs-1']}`,
  readyPage: `#/job-hunt/jobs/${ids['ready-1']}`,
  readyPanel: `#/job-hunt/opportunities?job=${ids['ready-1']}`,
});

export { stopDedicatedServer };
