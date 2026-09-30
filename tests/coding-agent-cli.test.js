import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { closeAllForTests } from '../server/db/connection.js';
import { main } from '../server/coding-agent/cli.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-official-cli.js');
const real = (p) => fs.realpathSync(p);

function setup({ codex = true, claude = true, yaml = '' } = {}) {
  const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-cli-home-')));
  const bin = real(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-cli-bin-')));
  const project = real(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-cli-proj-')));
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${fs.readFileSync(FIXTURE, 'utf8')}`, { mode: 0o755 });
  const vault = path.join(home, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'coding-agents.yaml'), yaml || [
    'providers:',
    `  codex: { enabled: ${codex}, executable: ${path.join(bin, 'codex')} }`,
    `  claude-code: { enabled: ${claude}, executable: ${path.join(bin, 'claude')} }`,
  ].join('\n'));
  process.env.U2OS_HOME = home;
  const cleanup = () => { closeAllForTests(); delete process.env.U2OS_HOME; for (const d of [home, bin, project]) fs.rmSync(d, { recursive: true, force: true }); };
  return { home, bin, project, cleanup };
}

const capture = () => {
  const out = { lines: [], errors: [], log(text) { this.lines.push(String(text)); }, error(text) { this.errors.push(String(text)); } };
  return out;
};

test('providers lists each provider with its status', async () => {
  const { cleanup } = setup({ claude: false });
  try {
    const out = capture();
    assert.equal(await main(['providers'], out), 0);
    const text = out.lines.join('\n');
    assert.match(text, /PROVIDER\s+STATUS/);
    assert.match(text, /codex\s+available\s+codex-cli 9\.9\.9/);
    assert.match(text, /claude-code\s+unavailable\s+disabled in coding-agents\.yaml/);
    const json = capture();
    await main(['providers', '--json'], json);
    assert.deepEqual(JSON.parse(json.lines.join('')).map((p) => [p.id, p.available]), [['codex', true], ['claude-code', false]]);
  } finally { cleanup(); }
});

test('providers exits nonzero when nothing is available', async () => {
  const { cleanup } = setup({ codex: false, claude: false });
  try { assert.equal(await main(['providers'], capture()), 1); } finally { cleanup(); }
});

test('run --provider auto picks the first available by preference, streams output and records the run', async () => {
  const { project, cleanup } = setup();
  try {
    const out = capture();
    const code = await main(['run', '--provider', 'auto', '--cwd', project, 'explain the architecture'], out);
    assert.equal(code, 0, out.errors.join('\n'));
    assert.match(out.errors.join('\n'), /\[codex\] started in/);
    assert.ok(out.lines.some((line) => line.includes('$ npm test')), 'output is streamed to stdout');
    assert.match(out.errors.join('\n'), /completed — run cagent_\S+ \(codex, exit 0\)/);

    const runs = capture();
    await main(['runs'], runs);
    assert.match(runs.lines.join('\n'), /completed\s+codex/);
    const id = /run (cagent_\S+)/.exec(out.errors.join('\n'))[1];
    const shown = capture();
    assert.equal(await main(['show', id], shown), 0);
    assert.equal(JSON.parse(shown.lines.join('\n')).status, 'completed');
  } finally { cleanup(); }
});

test('run falls through to the next provider when the first is disabled, and honours --preference', async () => {
  const { project, cleanup } = setup({ codex: false });
  try {
    const out = capture();
    assert.equal(await main(['run', '--cwd', project, 'x'], out), 0);
    assert.match(out.errors.join('\n'), /\[claude-code\] started/);
    const explicit = capture();
    assert.equal(await main(['run', '--provider', 'codex', '--cwd', project, 'x'], explicit), 1);
    assert.match(explicit.errors.join('\n'), /disabled/);
  } finally { cleanup(); }
});

test('run maps permission flags, reads "-" from stdin, and --json prints the run', async () => {
  const { project, cleanup } = setup();
  try {
    const out = capture();
    const stdin = Readable.from(['task from stdin']);
    const code = await main(['run', '--provider', 'codex', '--cwd', project, '--write', '--network', '--json', '-'], out, { stdin });
    assert.equal(code, 0);
    const run = JSON.parse(out.lines.join('\n'));
    assert.equal(run.status, 'completed');
    assert.equal(run.task, 'task from stdin');
    assert.deepEqual(run.permissions, { filesystem: 'project', shell: false, network: true, git: false });
    assert.equal(out.errors.length, 0, '--json keeps stderr quiet');
  } finally { cleanup(); }
});

test('run requires --cwd and exactly one task, and rejects bad input with exit 1', async () => {
  const { project, cleanup } = setup();
  try {
    for (const argv of [['run', 'task'], ['run', '--cwd', project], ['run', '--cwd', project, 'a', 'b'], ['run', '--cwd', project, '--bogus', 'a'], ['run', '--cwd', path.join(project, 'missing'), 'a'], ['run', '--cwd', project, '--timeout', 'soon', 'a'], ['run', '--cwd', project, '--git', 'a'], ['nonsense']]) {
      const out = capture();
      assert.equal(await main(argv, out), 1, argv.join(' '));
      assert.ok(out.errors.length, argv.join(' '));
    }
  } finally { cleanup(); }
});

test('run with an unknown provider exits 1 with a clear error', async () => {
  const { project, cleanup } = setup();
  try {
    const failed = capture();
    assert.equal(await main(['run', '--provider', 'nope', '--cwd', project, 'x'], failed), 1);
    assert.match(failed.errors.join('\n'), /Unknown coding agent provider/);
  } finally { cleanup(); }
});
