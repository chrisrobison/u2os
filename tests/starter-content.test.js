import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoutines } from '../server/routines/routines.js';
import { getVaultDir, ensureVaultLayout } from '../server/vault/vault-dir.js';
import { STARTER_CONTENT, listStarterContent, installStarterContent } from '../server/vault/starter-content.js';
import { U2OS_ROOT } from '../server/mcp/config.js';

// Starter content (server/vault/starter-content.js) is first-run vault
// content, the same category as ensureVaultLayout()'s README.md and the
// policy loaders' default files: it copies example routines/skills into a
// live vault and never overwrites what the owner already has there.

const EXAMPLES_VAULT_DIR = path.join(U2OS_ROOT, 'examples', 'vault');
const NEW_TEMPLATE_IDS = ['morning-brief', 'meeting-prep', 'commitment-follow-up'];

function fixture() {
  const previous = process.env.U2OS_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-starter-content-'));
  process.env.U2OS_HOME = home;
  return { home, previous };
}

function cleanup({ home, previous }) {
  if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
}

test('the three new starter routine templates parse and validate with zero errors', () => {
  const routines = loadRoutines(EXAMPLES_VAULT_DIR);
  for (const id of NEW_TEMPLATE_IDS) {
    const routine = routines.find((entry) => entry.path === `routines/${id}.md`);
    assert.ok(routine, `expected routines/${id}.md to be loaded from ${EXAMPLES_VAULT_DIR}`);
    assert.equal(routine.error, null, `${id}: ${routine.error}`);
    assert.ok(routine.trigger, `${id} should have a valid trigger`);
    assert.ok(routine.enabled, `${id} should be enabled by default`);
    assert.ok(routine.instruction.length > 0, `${id} should have a non-empty instruction`);
  }
});

test('the starter content catalog covers all four starter items', () => {
  const list = listStarterContent();
  assert.deepEqual(list.map((item) => item.id).sort(), ['commitment-follow-up', 'job-hunting', 'meeting-prep', 'morning-brief']);
  for (const item of list) {
    assert.ok(item.label && item.label.length > 0);
    assert.ok(item.description && item.description.length > 0);
    assert.ok(Array.isArray(item.files) && item.files.length > 0);
  }
});

test('installStarterContent copies every catalog item into a fresh vault', () => {
  const ctx = fixture();
  try {
    const vaultDir = ensureVaultLayout(getVaultDir());
    for (const item of STARTER_CONTENT) {
      const result = installStarterContent(item.id, vaultDir);
      assert.equal(result.id, item.id);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.installed.slice().sort(), item.files.map((file) => file.to).sort());
      for (const file of item.files) {
        const dest = path.join(vaultDir, file.to);
        assert.ok(fs.existsSync(dest), `${dest} should have been installed`);
        assert.ok(fs.readFileSync(dest, 'utf8').trim().length > 0);
      }
    }
    // job-hunter's routine names the job-hunting skill: once both of
    // job-hunting's files are installed together, it should validate too.
    const routines = loadRoutines(vaultDir);
    const jobHunter = routines.find((entry) => entry.path === 'routines/job-hunter.md');
    assert.ok(jobHunter);
    assert.equal(jobHunter.error, null);
  } finally { cleanup(ctx); }
});

test('installStarterContent never overwrites a file the owner already edited', () => {
  const ctx = fixture();
  try {
    const vaultDir = ensureVaultLayout(getVaultDir());
    fs.mkdirSync(path.join(vaultDir, 'routines'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'routines', 'morning-brief.md'), 'owner-edited content, do not touch');
    const result = installStarterContent('morning-brief', vaultDir);
    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.skipped, ['routines/morning-brief.md']);
    assert.equal(fs.readFileSync(path.join(vaultDir, 'routines', 'morning-brief.md'), 'utf8'), 'owner-edited content, do not touch');
  } finally { cleanup(ctx); }
});

test('installStarterContent is idempotent across repeated installs', () => {
  const ctx = fixture();
  try {
    const vaultDir = ensureVaultLayout(getVaultDir());
    const first = installStarterContent('meeting-prep', vaultDir);
    assert.deepEqual(first.installed, ['routines/meeting-prep.md']);
    assert.deepEqual(first.skipped, []);
    const second = installStarterContent('meeting-prep', vaultDir);
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.skipped, ['routines/meeting-prep.md']);
  } finally { cleanup(ctx); }
});

test('installStarterContent rejects an unknown id and installs nothing', () => {
  const ctx = fixture();
  try {
    const vaultDir = ensureVaultLayout(getVaultDir());
    assert.throws(() => installStarterContent('does-not-exist', vaultDir), (error) => error.code === 'STARTER_CONTENT_UNKNOWN');
    assert.deepEqual(fs.readdirSync(path.join(vaultDir, 'routines')), []);
  } finally { cleanup(ctx); }
});
