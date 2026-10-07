import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner, gotoNav } from './helpers.js';

// Issue #494: the app shell is fixed to the viewport and never scrolls; only
// the <u2-pane> containers (and the agent transcript inside its pane) scroll.
const PASSPHRASE = 'correct horse battery staple';
const ROUTES = ['#/home', '#/mail', '#/calendar', '#/tasks', '#/memory', '#/routines', '#/activity', '#/operations'];

test.describe.serial('fixed shell (#494)', () => {
  let dedicated;
  let context;
  let page;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    context = await browser.newContext({ viewport: { width: 1280, height: 600 } });
    page = await context.newPage();
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  const shellMetrics = () => page.evaluate(() => {
    const root = document.documentElement;
    const box = (selector) => {
      const el = document.querySelector(selector);
      return { overflowY: getComputedStyle(el).overflowY, tag: el.localName };
    };
    return {
      docOverflow: root.scrollHeight - innerHeight,
      bodyOverflow: document.body.scrollHeight - innerHeight,
      shellOverflow: document.querySelector('.shell').scrollHeight - document.querySelector('.shell').clientHeight,
      nav: box('.shell__nav'),
      main: box('.shell__main'),
      agent: box('.shell__agent'),
      header: box('.shell__header'),
    };
  });

  test('shell is built from components and never scrolls on any route', async () => {
    for (const route of ROUTES) {
      await gotoNav(page, route);
      const m = await shellMetrics();
      expect(m.docOverflow, `${route} document`).toBeLessThanOrEqual(0);
      expect(m.bodyOverflow, `${route} body`).toBeLessThanOrEqual(0);
      expect(m.shellOverflow, `${route} shell`).toBeLessThanOrEqual(0);
      expect([m.nav.tag, m.main.tag, m.agent.tag]).toEqual(['u2-pane', 'u2-pane', 'u2-pane']);
      expect(m.header.tag).toBe('u2-shell-header');
    }
  });

  test('wheel over a pane scrolls that pane, never the page', async () => {
    await gotoNav(page, '#/home');
    await page.evaluate(() => {
      const filler = document.createElement('div');
      filler.style.height = '3000px';
      filler.dataset.testFiller = '';
      document.querySelector('#workspace').appendChild(filler);
    });
    const main = page.locator('.shell__main');
    expect(await main.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await main.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const m = await shellMetrics();
    expect(m.docOverflow).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // The header stays put while the workspace scrolls.
    expect((await page.locator('.shell__header').boundingBox()).y).toBe(0);
  });

  test('agent pane keeps its composer in view while the transcript scrolls', async () => {
    await gotoNav(page, '#/home');
    await page.evaluate(() => {
      const transcript = document.querySelector('.agent-panel__transcript');
      for (let i = 0; i < 80; i += 1) {
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble is-agent';
        bubble.textContent = `filler message ${i}`;
        transcript.appendChild(bubble);
      }
    });
    const { composerBottom, viewport, agentOverflow, transcriptScrolls } = await page.evaluate(() => ({
      composerBottom: document.querySelector('.agent-panel__composer').getBoundingClientRect().bottom,
      viewport: innerHeight,
      agentOverflow: document.querySelector('.shell__agent').scrollHeight - document.querySelector('.shell__agent').clientHeight,
      transcriptScrolls: (() => { const t = document.querySelector('.agent-panel__transcript'); return t.scrollHeight > t.clientHeight; })(),
    }));
    expect(composerBottom).toBeLessThanOrEqual(viewport);
    expect(agentOverflow).toBeLessThanOrEqual(0);
    expect(transcriptScrolls).toBe(true);
  });

  test('stays fixed at drawer width', async () => {
    await page.setViewportSize({ width: 700, height: 600 });
    for (const route of ['#/home', '#/calendar']) {
      // The nav is an off-screen drawer here, so navigate by hash.
      await page.evaluate((hash) => { window.location.hash = hash; }, route);
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      await expect(page.locator('#workspace')).toBeVisible();
      const m = await shellMetrics();
      expect(m.docOverflow, route).toBeLessThanOrEqual(0);
      expect(m.shellOverflow, route).toBeLessThanOrEqual(0);
    }
  });
});
