import { defineConfig, devices } from '@playwright/test';

// Minimal Playwright harness (issue #13): no frontend build step, no
// `webServer` shelling out to `npm start` -- `globalSetup` boots the real
// server in-process (see global-setup.js) against a scratch U2OS_HOME, and
// each test reads the resulting baseURL back from tests/e2e/state-file.js.
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  globalSetup: './global-setup.js',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
