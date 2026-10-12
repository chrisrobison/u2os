import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addCustomAnswers, customFragment, loadAnswers, answersPath } from '../mcp/jobs/hunt/candidate/answers.js';
import { readJournal } from '../server/vault/journal.js';

// #568: answers entered in the app are saved under `custom:` in answers.yaml without disturbing the owner's file.

function vault(t, text = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-answers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'job-hunt'), { recursive: true });
  if (text !== null) fs.writeFileSync(answersPath(dir), text);
  return dir;
}
const OWNER_FILE = `# My standard answers
work_authorization_us: true       # I am a citizen

custom:                             # other questions
  "do you currently or have you previously worked for databricks": "No"
  # a comment between entries
  "country": "United States+1"

policy:
   accept_privacy_notices: true
`;

test('answers are added under custom without losing comments or other entries', (t) => {
  const dir = vault(t, OWNER_FILE);
  assert.deepEqual(addCustomAnswers(dir, [{ label: 'Do you have a security clearance?', value: 'No' }, { label: '  How many   years of Python?  ', value: '20+' }]), { saved: 2 });
  const text = fs.readFileSync(answersPath(dir), 'utf8');
  for (const keep of ['# My standard answers', '# I am a citizen', '# other questions', '# a comment between entries', 'policy:', 'accept_privacy_notices: true']) assert.ok(text.includes(keep), keep);
  const { custom } = loadAnswers(dir);
  assert.equal(custom['do you have a security clearance?'], 'No');
  assert.equal(custom['how many years of python?'], '20+');
  assert.equal(custom['country'], 'United States+1');
  assert.equal(custom['do you currently or have you previously worked for databricks'], 'No');
  assert.equal(loadAnswers(dir).work_authorization_us, true);
});

test('an answer to a question already in the file replaces it', (t) => {
  const dir = vault(t, OWNER_FILE);
  addCustomAnswers(dir, [{ label: 'Country', value: 'United States' }]);
  const text = fs.readFileSync(answersPath(dir), 'utf8');
  assert.equal((text.match(/"country"/g) ?? []).length, 1);
  assert.equal(loadAnswers(dir).custom.country, 'United States');
});

test('a file with no custom block, an empty one, or no file at all gets one', (t) => {
  const bare = vault(t, 'work_authorization_us: true\n');
  addCustomAnswers(bare, [{ label: 'Q one', value: 'A' }]);
  assert.equal(loadAnswers(bare).custom['q one'], 'A');
  assert.equal(loadAnswers(bare).work_authorization_us, true);

  const empty = vault(t, 'custom: {}\nstart_date: "now"\n');
  addCustomAnswers(empty, [{ label: 'Q two', value: 'B' }]);
  assert.equal(loadAnswers(empty).custom['q two'], 'B');
  assert.equal(loadAnswers(empty).start_date, 'now');

  const none = vault(t);
  addCustomAnswers(none, [{ label: 'Q three', value: 'C' }]);
  assert.equal(loadAnswers(none).custom['q three'], 'C');
});

test('hostile or awkward answers stay data: quotes, colons, newlines and yaml syntax round-trip', (t) => {
  const dir = vault(t, OWNER_FILE);
  const tricky = 'He said "no": yes\n- not a list\n# not a comment\n{a: b}';
  addCustomAnswers(dir, [{ label: 'Tell us: "anything"?', value: tricky }]);
  assert.equal(loadAnswers(dir).custom['tell us: "anything"?'], tricky);
});

test('empty, oversized and malformed answers are refused and change nothing', (t) => {
  const dir = vault(t, OWNER_FILE);
  const before = fs.readFileSync(answersPath(dir), 'utf8');
  assert.throws(() => addCustomAnswers(dir, [{ label: 'Q', value: '   ' }]), /empty/);
  assert.throws(() => addCustomAnswers(dir, [{ label: '', value: 'x' }]), /needs the question/);
  assert.throws(() => addCustomAnswers(dir, [{ label: 'Q', value: 'x'.repeat(2001) }]), /too long/);
  assert.throws(() => addCustomAnswers(dir, [{ label: 'Q', value: { nested: 1 } }]), /empty/);
  assert.equal(fs.readFileSync(answersPath(dir), 'utf8'), before);
  const damaged = vault(t, 'custom: [unclosed\n');
  assert.throws(() => addCustomAnswers(damaged, [{ label: 'Q', value: 'x' }]));
  assert.equal(fs.readFileSync(answersPath(damaged), 'utf8'), 'custom: [unclosed\n');
});

test('the change is logged with question text only, never the answer', (t) => {
  const dir = vault(t, OWNER_FILE);
  addCustomAnswers(dir, [{ label: 'Do you have a security clearance?', value: 'Secret-clearance-detail' }], { channel: 'api' });
  const entry = readJournal({ vaultDir: dir }).entries.find((item) => item.type === 'config.changed');
  assert.equal(entry.data.file, 'job-hunt/answers.yaml');
  assert.equal(entry.data.channel, 'api');
  assert.ok(entry.data.changes.some((change) => change.key.includes('security clearance')));
  assert.ok(!JSON.stringify(entry).includes('Secret-clearance-detail'));
  assert.equal(customFragment('  A   B '), 'a b');
});
