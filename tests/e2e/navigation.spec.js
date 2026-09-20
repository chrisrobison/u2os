import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

// Issue #15: real-browser coverage of the hash-router-driven navigation
// shell (public/components/u2-app.js's _route(), public/components/u2-nav.js's
// route table) across all eleven sections, plus the router/nav mechanics
// themselves (active-link highlighting, browser back/forward).
//
// One dedicated server + one logged-in page is shared across every test in
// this file (via test.describe.serial + beforeAll/afterAll) rather than
// booting a fresh server per route: navigating around the shell is
// read-mostly and idempotent against the seeded demo data (server/seed/seed.js),
// so there's no isolation reason to pay for 12+ separate server boots, and
// sharing one page also lets the back/forward test build on real prior
// navigation history instead of contriving one.
//
// Content assertions below are deliberately picked to be time-of-day
// independent where the underlying route logic filters on time. In
// particular: server/api/routes/calendar.js's `range=upcoming` filter
// excludes anything more than an hour in the past, and seed.js's
// "Sync with Sarah" event is pinned to *today* at 14:00 -- depending on
// what time this suite actually runs, that event may or may not still
// count as "upcoming" by the time #/calendar's fetch happens. The
// dashboard's "today" filter (server/agent/dashboard-planner.js's
// buildMorningDashboard) has no such issue (it's date-only), so "Sync with
// Sarah" is asserted on the dashboard routes; #/calendar instead asserts on
// "U2OS project standup" (tomorrow) and the recruiter call (two days out),
// both always "upcoming" regardless of run time.
const PASSPHRASE = 'correct horse battery staple';

test.describe.serial('navigation shell (#15)', () => {
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
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  function navLink(hash) {
    return page.locator(`u2-nav a[data-route="${hash}"]`);
  }

  async function goViaNav(hash) {
    await navLink(hash).click();
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
  }

  // hashchange (and therefore u2-app's _route()) fires asynchronously after
  // the URL updates, so a plain, unfiltered `.workspace__title` locator can
  // momentarily still match the PREVIOUS route's title element(s) right
  // after goViaNav()'s URL assertion resolves. This is especially visible
  // coming from #/dashboards, which (uniquely) renders two `.workspace__title`
  // elements at once ("Dashboards" + the generated "Morning Briefing"); a
  // bare `.workspace__title` locator hitting that transient state is a
  // strict-mode violation, which -- unlike a plain text mismatch -- fails
  // immediately rather than retrying. Filtering by the expected title's own
  // text sidesteps this: stale elements that don't match are excluded from
  // the resolved set, so Playwright's normal auto-retry just waits out the
  // real re-render instead of tripping over it.
  function workspaceTitle(text) {
    return page.locator('.workspace__title', { hasText: text });
  }

  // ---- 1. per-route root content, sourced from real seed data / real
  // static structure (see file header for the per-route reasoning). ----

  const ROUTE_CASES = [
    {
      hash: '#/home',
      async assert() {
        await expect(workspaceTitle('Morning Briefing')).toBeVisible();
        await expect(page.locator('u2-card[title="Schedule"] .u2-schedule__title', { hasText: 'Sync with Sarah' })).toBeVisible();
        await expect(page.locator('u2-card[title="Tasks"] .u2-task__title', { hasText: 'Send proposal draft to Sarah' })).toBeVisible();
        await expect(page.locator('u2-card[title="Tasks"] .u2-task__title', { hasText: 'Prepare for recruiter call' })).toBeVisible();
        await expect(page.locator('u2-card[title="Tasks"] .u2-task__title', { hasText: 'Review U2OS architecture doc' })).toBeVisible();
      },
    },
    {
      // #12/#15: #/briefing maps to the exact same dashboard render as
      // #/home -- same assertions confirm that, not just a status code.
      hash: '#/briefing',
      async assert() {
        await expect(workspaceTitle('Morning Briefing')).toBeVisible();
        await expect(page.locator('u2-card[title="Schedule"] .u2-schedule__title', { hasText: 'Sync with Sarah' })).toBeVisible();
      },
    },
    {
      hash: '#/dashboards',
      async assert() {
        await expect(page.locator('.workspace__title', { hasText: 'Dashboards' })).toBeVisible();
        const morningBtn = page.locator('.folder-toggle button', { hasText: 'Morning' });
        await expect(morningBtn).toHaveClass(/is-active/);
        await expect(page.locator('.folder-toggle button', { hasText: 'Before a meeting' })).toBeVisible();
        await expect(page.locator('.folder-toggle button', { hasText: 'Project' })).toBeVisible();
        // Default context is 'morning' -- same generated dashboard as
        // #/home, rendered inside this page's own body.
        await expect(page.locator('.workspace__title', { hasText: 'Morning Briefing' })).toBeVisible();
        await expect(page.locator('u2-card[title="Schedule"] .u2-schedule__title', { hasText: 'Sync with Sarah' })).toBeVisible();
      },
    },
    {
      hash: '#/activity',
      async assert() {
        await expect(workspaceTitle('Activity')).toBeVisible();
        await expect(page.locator('u2-timeline .u2-timeline__item').first()).toBeVisible();
        // Seed publishes calendar/email/task events -- at least one
        // recognizable humanized label should show up somewhere in the feed.
        await expect(
          page.locator('u2-timeline .u2-timeline__label', { hasText: /Added a calendar event|Received an email|Created a task/ }).first()
        ).toBeVisible();
      },
    },
    {
      hash: '#/memory',
      async assert() {
        await expect(workspaceTitle('Memory')).toBeVisible();
        await expect(page.locator('.entity-row__name', { hasText: 'Chris' })).toBeVisible();
        await expect(page.locator('.entity-row__name', { hasText: 'Sarah' })).toBeVisible();
        await expect(page.locator('.entity-row__name', { hasText: 'U2OS' })).toBeVisible();
      },
    },
    {
      hash: '#/projects',
      async assert() {
        await expect(workspaceTitle('Projects')).toBeVisible();
        await expect(page.locator('.entity-row__name', { hasText: 'U2OS' })).toBeVisible();
        await expect(page.locator('.entity-row__type', { hasText: 'Project' })).toBeVisible();
      },
    },
    {
      hash: '#/mail',
      async assert() {
        await expect(workspaceTitle('Mail')).toBeVisible();
        await expect(page.locator('.folder-toggle button', { hasText: 'Inbox' })).toHaveClass(/is-active/);
        await expect(page.locator('.folder-toggle button', { hasText: 'Sent' })).toBeVisible();
        // Inbox: seeded recruiter email is a real, known subject line.
        await expect(page.locator('.u2-email__subject', { hasText: 'Following up -- another conversation?' })).toBeVisible();

        // Toggle to Sent and confirm the seeded outgoing email shows up,
        // driven through the real toggle button (not a direct hash write).
        await page.locator('.folder-toggle button', { hasText: 'Sent' }).click();
        await expect(page).toHaveURL(/#\/mail\?folder=sent$/);
        await expect(page.locator('.folder-toggle button', { hasText: 'Sent' })).toHaveClass(/is-active/);
        await expect(page.locator('.u2-email__subject', { hasText: 'Re: Sync with Sarah' })).toBeVisible();
      },
    },
    {
      hash: '#/calendar',
      async assert() {
        await expect(workspaceTitle('Calendar')).toBeVisible();
        await expect(page.locator('.u2-schedule__title', { hasText: 'U2OS project standup' })).toBeVisible();
        await expect(page.locator('.u2-schedule__title', { hasText: 'Call with Jamie Alvarez (recruiter)' })).toBeVisible();
      },
    },
    {
      hash: '#/tasks',
      async assert() {
        await expect(workspaceTitle('Tasks')).toBeVisible();
        await expect(page.locator('.u2-task__title', { hasText: 'Send proposal draft to Sarah' })).toBeVisible();
        await expect(page.locator('.u2-task__title', { hasText: 'Prepare for recruiter call' })).toBeVisible();
        await expect(page.locator('.u2-task__title', { hasText: 'Review U2OS architecture doc' })).toBeVisible();
      },
    },
    {
      hash: '#/connectors',
      async assert() {
        await expect(workspaceTitle('Connectors')).toBeVisible();
        // Real static structure: one card per domain from
        // server/integrations/connectors-config.js's DOMAINS list, all
        // defaulting to the mock provider until a real one is connected.
        for (const label of ['Calendar', 'Email', 'Contacts', 'Web Search', 'Notifications']) {
          await expect(page.locator(`.connectors__grid u2-card[title="${label}"]`)).toBeVisible();
        }
        await expect(page.locator('u2-card[title="Google"]')).toBeVisible();
        await expect(page.locator('u2-card[title="Brave Search"]')).toBeVisible();
      },
    },
    {
      hash: '#/devices',
      async assert() {
        await expect(workspaceTitle('Devices')).toBeVisible();
        // Device count is timing-dependent (this browser tab registers
        // itself asynchronously over a WebSocket -- see
        // public/services/device-client.js), so assert the always-present,
        // real static structure rather than a specific count.
        await expect(page.locator('.workspace__subtitle')).toHaveText(/^\d+ known devices?$/);
      },
    },
    {
      hash: '#/voice',
      async assert() {
        await expect(workspaceTitle('Voice')).toBeVisible();
        await expect(page.locator('u2-card[title="Enrollment status"]')).toBeVisible();
        await expect(page.locator('.connector-status', { hasText: 'Not enrolled' })).toBeVisible();
        await expect(page.locator('button[data-action="enroll"]')).toHaveText('Enroll my voice');
      },
    },
  ];

  for (const { hash, assert } of ROUTE_CASES) {
    test(`${hash} renders its expected root content`, async () => {
      await goViaNav(hash);
      await assert();
    });
  }

  // ---- 2. active-link highlighting tracks navigation ----

  test('active-link highlighting tracks the current route', async () => {
    const checkOnly = async (activeHash) => {
      for (const [hash] of [
        ['#/home'], ['#/briefing'], ['#/memory'], ['#/mail'], ['#/calendar'], ['#/tasks'],
        ['#/projects'], ['#/dashboards'], ['#/activity'], ['#/connectors'], ['#/devices'], ['#/voice'],
      ]) {
        const link = navLink(hash);
        if (hash === activeHash) await expect(link).toHaveClass(/is-active/);
        else await expect(link).not.toHaveClass(/is-active/);
      }
    };

    await goViaNav('#/mail');
    await checkOnly('#/mail');

    await goViaNav('#/calendar');
    await checkOnly('#/calendar');

    await goViaNav('#/tasks');
    await checkOnly('#/tasks');
  });

  // ---- 3. browser back/forward works correctly with the hash router ----

  test('browser back/forward navigates the hash router correctly', async () => {
    await goViaNav('#/home');
    await goViaNav('#/mail');
    await goViaNav('#/calendar');

    // Back: #/calendar -> #/mail -> #/home, each landing on the right
    // rendered content and the right active nav link.
    await page.goBack();
    await expect(page).toHaveURL(/#\/mail$/);
    await expect(workspaceTitle('Mail')).toBeVisible();
    await expect(navLink('#/mail')).toHaveClass(/is-active/);

    await page.goBack();
    await expect(page).toHaveURL(/#\/home$/);
    await expect(workspaceTitle('Morning Briefing')).toBeVisible();
    await expect(navLink('#/home')).toHaveClass(/is-active/);

    // Forward: #/home -> #/mail -> #/calendar, landing correctly again.
    await page.goForward();
    await expect(page).toHaveURL(/#\/mail$/);
    await expect(workspaceTitle('Mail')).toBeVisible();
    await expect(navLink('#/mail')).toHaveClass(/is-active/);

    await page.goForward();
    await expect(page).toHaveURL(/#\/calendar$/);
    await expect(workspaceTitle('Calendar')).toBeVisible();
    await expect(navLink('#/calendar')).toHaveClass(/is-active/);
  });
});
