// Shared by global-setup.js (writer) and smoke.spec.js (reader): the
// dynamically-assigned port from `startServer({ port: 0 })` can't be known
// until global setup actually boots the server, and Playwright's own config
// module is evaluated before global setup runs -- so the resolved baseURL
// can't simply be a static `use.baseURL` value in playwright.config.js.
// Instead global setup writes it to this scratch file once the server is
// listening, and each test reads it back inside a test/hook body (which is
// always guaranteed to run after global setup has completed, unlike
// top-level module code in a spec file, which Playwright may evaluate
// during test discovery before global setup starts).
import os from 'node:os';
import path from 'node:path';

export const STATE_FILE = path.join(os.tmpdir(), 'u2os-playwright-e2e-state.json');
