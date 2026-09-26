import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withOfflineHome } from '../server/runtime/offline-home.js';
import { acquireHomeGuard } from '../server/runtime/home-guard.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { startServer } from '../server/index.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';

const exec = promisify(execFile);
const cliPath = (relative) => fileURLToPath(new URL(`../server/${relative}`, import.meta.url));
const commands = ['security/setup-owner-cli.js', 'seed/seed.js', 'events/maintenance-cli.js'];
async function cli(relative, home, args = []) {
  try { return { code: 0, ...await exec(process.execPath, [cliPath(relative), ...args], { env: { ...process.env, U2OS_HOME: home }, timeout: 10000 }) }; }
  catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-offline-'));
  const previous = process.env.U2OS_HOME; process.env.U2OS_HOME = dir;
  try { await run(dir); }
  finally {
    closeAllForTests();
    if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('offline CLIs fail before application storage or initialization under another owner', () => fixture(async (dir) => {
  const guard = acquireHomeGuard(dir);
  try {
    for (const command of commands) {
      const result = await cli(command, dir);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /already in use; stop the other runtime/);
      assert.equal(result.stdout, '');
      assert.equal(fs.existsSync(path.join(dir, 'db')), false);
      assert.equal(fs.existsSync(path.join(dir, 'config')), false);
      assert.equal(fs.existsSync(path.join(dir, 'credentials')), false);
    }
  } finally { guard.release(); }
}));

test('offline CLIs cannot mutate an active runtime, including a directory alias', () => fixture(async (dir) => {
  const handle = await startServer({ port: 0 });
  try {
    const db = getDb();
    const before = db.prepare('SELECT * FROM events ORDER BY id').all();
    const installation = fs.readFileSync(path.join(dir, 'config', 'installation.json'));
    const key = fs.readFileSync(path.join(dir, 'credentials', 'master.key'));
    const alias = path.join(dir, 'home-alias'); fs.symlinkSync(dir, alias, 'dir');
    for (const command of commands) {
      const result = await cli(command, alias, command.includes('maintenance') ? ['--apply', '--retention-days', '1', '--replay-projections'] : []);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /already in use/);
    }
    assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM entities').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM owners').get().n, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'config', 'installation.json')), installation);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'credentials', 'master.key')), key);
  } finally { await handle.shutdown(); }
  assert.equal((await cli('events/maintenance-cli.js', dir)).code, 0);
}));

test('offline ownership holds through asynchronous failure and releases only after settlement', () => fixture(async (dir) => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const failure = withOfflineHome(async () => { await barrier; throw new Error('fixture failure'); });
  assert.throws(() => acquireHomeGuard(dir), { code: 'HOME_IN_USE' });
  assert.equal((await cli('events/maintenance-cli.js', dir)).code, 1);
  release();
  await assert.rejects(failure, /fixture failure/);
  assert.equal(await withOfflineHome(async () => 'settled'), 'settled');
  const guard = acquireHomeGuard(dir); guard.release(); guard.release();
}));

test('offline maintenance creates fresh storage and preserves upgraded records', () => fixture(async (dir) => {
  const fresh = await cli('events/maintenance-cli.js', dir);
  assert.equal(fresh.code, 0);
  assert.equal(JSON.parse(fresh.stdout).integrity.ok, true);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO tasks (id, title, status, source, created_at, updated_at) VALUES ('fixture_real_task', 'Keep my real task', 'open', 'owner', ?, ?)").run(now, now);
  closeAllForTests();
  const upgraded = await cli('events/maintenance-cli.js', dir, ['--replay-projections']);
  assert.equal(upgraded.code, 0);
  assert.equal(JSON.parse(upgraded.stdout).integrity.ok, true);
  assert.equal(getDb().prepare("SELECT title FROM tasks WHERE id = 'fixture_real_task'").get().title, 'Keep my real task');
}));

test('offline seeding refuses personal homes and remains explicit and idempotent for demo homes', () => fixture(async (dir) => {
  const personal = await cli('seed/seed.js', dir);
  assert.equal(personal.code, 1);
  assert.match(personal.stderr, /Refusing to seed a personal home/);
  assert.equal(fs.existsSync(path.join(dir, 'db')), false);
  const demo = path.join(dir, 'isolated-demo');
  process.env.U2OS_HOME = demo;
  ensureInstallationMode('demo');
  assert.equal((await cli('seed/seed.js', demo)).code, 0);
  const count = getDb().prepare('SELECT COUNT(*) n FROM entities').get().n;
  assert.ok(count > 1);
  assert.equal((await cli('seed/seed.js', demo)).code, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM entities').get().n, count);
}));

test('offline owner setup creates the same owner without echoing fixture passphrases and releases on refusal', () => fixture(async (dir) => {
  const child = spawn(process.execPath, [cliPath('security/setup-owner-cli.js')], { env: { ...process.env, U2OS_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', supplied = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const passphrase = 'fixture-only correct horse battery staple';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (supplied === 0 && stdout.includes('New owner passphrase')) { supplied = 1; child.stdin.write(`${passphrase}\n`); }
    if (supplied === 1 && stdout.includes('Confirm passphrase')) { supplied = 2; child.stdin.end(`${passphrase}\n`); }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Owner created/);
  assert.ok(!`${stdout}${stderr}`.includes(passphrase));
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM owners').get().n, 1);
  const refused = await cli('security/setup-owner-cli.js', dir);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /already complete/);
  const guard = acquireHomeGuard(dir); guard.release();
}));
