// Boots the real U2OS server in-process against a scratch U2OS_HOME, the
// same isolated-temp-dir pattern used by the Node test suite (see
// tests/helpers/authed-server.js and tests/auth.test.js) -- no `npm start`
// shell-out, no hardcoded port. Playwright's `globalSetup` may return a
// function, which it then treats as `globalTeardown`; using that (rather
// than a separate globalTeardown file) keeps the server handle in a single
// closure instead of trying to share it across two independently-loaded
// modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { closeAllForTests } from '../../server/db/connection.js';
import { STATE_FILE } from './state-file.js';

export default async function globalSetup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-e2e-'));
  process.env.U2OS_HOME = dataDir;

  const handle = await startServer({ port: 0, mode: 'demo' });
  const baseURL = `http://127.0.0.1:${handle.port}`;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ baseURL }));

  return async function globalTeardown() {
    await new Promise((resolve) => handle.server.close(resolve));
    await handle.closed;
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(STATE_FILE, { force: true });
  };
}
