import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkExternalConfigChanges, diffConfig, lastConfigChange, readConfigValues, writeConfigFile } from '../server/vault/config-log.js';
import { journalPath, readJournal } from '../server/vault/journal.js';
import { setAutopilotSwitches } from '../mcp/jobs/hunt/autopilot/config.js';
import { setupAutopilot, revokeAutonomy } from '../mcp/jobs/hunt/autopilot/setup.js';
import { setFastModel } from '../mcp/jobs/hunt/llm/models.js';

function vault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-config-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = () => readJournal({ vaultDir: dir, limit: 500 }).entries.filter((entry) => entry.type === 'config.changed').reverse();
  const edit = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  return { dir, entries, edit };
}

test('switching the autopilot records the channel and the old and new values', (t) => {
  const { dir, entries } = vault(t);
  setAutopilotSwitches(dir, { enabled: true, mode: 'live' }, { channel: 'api' });
  setAutopilotSwitches(dir, { enabled: false }, { channel: 'cli' });
  const [first, second] = entries();
  assert.equal(first.type, 'config.changed');
  assert.equal(first.data.file, 'job-hunt/autopilot.yaml');
  assert.equal(first.data.channel, 'api');
  assert.deepEqual(first.data.changes, [{ key: 'enabled', to: 'true' }, { key: 'mode', to: 'live' }]);
  assert.equal(second.data.channel, 'cli');
  assert.deepEqual(second.data.changes, [{ key: 'enabled', from: 'true', to: 'false' }]);
  assert.equal(lastConfigChange(dir, 'job-hunt/autopilot.yaml').data.channel, 'cli');
  assert.equal(lastConfigChange(dir, 'policies.yaml'), null);
});

test('a write that changes nothing records nothing', (t) => {
  const { dir, entries } = vault(t);
  setAutopilotSwitches(dir, { enabled: false }, { channel: 'api' });
  setAutopilotSwitches(dir, { enabled: false }, { channel: 'api' });
  assert.equal(entries().length, 1);
});

test('an edit made outside U2OS is recorded as external, once', (t) => {
  const { dir, entries, edit } = vault(t);
  setAutopilotSwitches(dir, { enabled: true, mode: 'dry_run' }, { channel: 'api' });
  assert.equal(checkExternalConfigChanges(dir), 0);
  edit('job-hunt/autopilot.yaml', 'enabled: false\nmode: live\n');
  assert.equal(checkExternalConfigChanges(dir), 1);
  assert.equal(checkExternalConfigChanges(dir), 0);
  const last = entries().at(-1);
  assert.equal(last.data.channel, 'external');
  assert.deepEqual(last.data.changes, [{ key: 'enabled', from: 'true', to: 'false' }, { key: 'mode', from: 'dry_run', to: 'live' }]);
});

test('the first check only takes a baseline, and an external edit before an app write is not blamed on the app', (t) => {
  const { dir, entries, edit } = vault(t);
  edit('policies.yaml', 'jobs:\n  submit_application: confirm\n');
  assert.equal(checkExternalConfigChanges(dir), 0);
  assert.equal(entries().length, 0);
  edit('policies.yaml', 'jobs:\n  submit_application: autonomous\n');
  setupAutopilot(dir, { autonomous: true, channel: 'cli' });
  const policy = entries().filter((entry) => entry.data.file === 'policies.yaml');
  assert.deepEqual(policy.map((entry) => entry.data.channel), ['external', 'cli']);
  assert.deepEqual(policy[0].data.changes, [{ key: 'jobs.submit_application', from: 'confirm', to: 'autonomous' }]);
  assert.deepEqual(policy[1].data.changes, [{ key: 'jobs.send_application', to: 'autonomous' }]);
  assert.equal(entries().find((entry) => entry.data.file === 'mcp.yaml').data.channel, 'cli');
  assert.equal(revokeAutonomy(dir, { channel: 'cli' }), true);
  assert.deepEqual(entries().at(-1).data.changes, [
    { key: 'jobs.send_application', from: 'autonomous', to: 'confirm' },
    { key: 'jobs.submit_application', from: 'autonomous', to: 'confirm' },
  ]);
});

test('credential-like values are redacted and answers.yaml records key names only', (t) => {
  const { dir, entries, edit } = vault(t);
  edit('mcp.yaml', 'servers: {}\n');
  edit('job-hunt/answers.yaml', 'salary: 100\n');
  checkExternalConfigChanges(dir);
  edit('mcp.yaml', 'servers:\n  jobs:\n    command: node\n    env:\n      API_TOKEN: hunter2-secret\n');
  edit('job-hunt/answers.yaml', 'salary: 250000\nauthorized_to_work: true\n');
  checkExternalConfigChanges(dir);
  const text = fs.readFileSync(journalPath(Date.now(), dir), 'utf8');
  assert.ok(!text.includes('hunter2-secret'));
  assert.ok(!text.includes('250000'));
  const byFile = Object.fromEntries(entries().map((entry) => [entry.data.file, entry.data.changes]));
  assert.ok(byFile['mcp.yaml'].some((change) => change.key === 'servers.jobs.env.API_TOKEN' && change.to === '[redacted]'));
  assert.deepEqual(byFile['job-hunt/answers.yaml'], [{ key: 'authorized_to_work' }, { key: 'salary' }]);
});

test('setFastModel is logged', (t) => {
  const { dir, entries } = vault(t);
  setFastModel(dir, { base_url: 'http://127.0.0.1:1234', model: 'qwen', reasoning: 'off' });
  const [entry] = entries();
  assert.equal(entry.data.file, 'job-hunt/models.yaml');
  assert.equal(entry.data.channel, 'cli');
  assert.ok(entry.data.changes.some((change) => change.key === 'fast.model' && change.to === 'qwen'));
});

test('a damaged file is reported without throwing, and only watched files can be written', (t) => {
  const { dir, edit } = vault(t);
  edit('mcp.yaml', 'a: [unclosed\n');
  assert.deepEqual(readConfigValues(dir, 'mcp.yaml'), { '(file)': 'not valid YAML' });
  assert.equal(readConfigValues(dir, 'addons.yaml'), null);
  assert.throws(() => writeConfigFile(dir, 'me.md', 'x', { channel: 'api' }), /not a watched/);
  assert.throws(() => writeConfigFile(dir, 'mcp.yaml', 'a: 1\n', { channel: 'robot' }), /unknown config change channel/);
  assert.deepEqual(diffConfig({ a: '1' }, { a: '1' }), []);
});
