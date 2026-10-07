import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailSender } from '../addons/apple/mail-send/server.js';
import { stageAttachment } from '../server/tools/email-attachments.js';
import { parseAddonYaml, validateAddonManifest } from '../server/addons/manifest.js';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-applemail-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  const source = path.join(dir, 'resume.pdf');
  fs.writeFileSync(source, PDF);
  return { dir, vault, ref: stageAttachment(vault, source, { name: 'Pat_Resume.pdf' }).ref };
}

test('send passes every value as an argument and gives Mail verified copies that are removed afterwards', async () => {
  const w = world();
  const seen = [];
  const mail = createMailSender({ vaultDir: w.vault, sender: 'Pat <pat@example.com>', tmpdir: w.dir, run: async (args) => {
    const files = args.slice(5);
    seen.push({ args: args.slice(0, 5), bytes: files.map((file) => fs.readFileSync(file)), names: files.map((file) => path.basename(file)), mode: fs.statSync(path.dirname(files[0])).mode & 0o777 });
    return 'sent';
  } });
  const result = await mail.send({ to: 'dylan@example.test', subject: 'Résumé "quoted" \\ & $(whoami)', body: 'Line one\n"two" `three` $HOME', attachments: [w.ref] });
  assert.deepEqual(seen[0].args, ['send', 'Pat <pat@example.com>', 'dylan@example.test', 'Résumé "quoted" \\ & $(whoami)', 'Line one\n"two" `three` $HOME']);
  assert.deepEqual(seen[0].bytes, [PDF]);
  assert.deepEqual(seen[0].names, ['Pat_Resume.pdf']);
  assert.equal(seen[0].mode, 0o700);
  assert.equal(result.status, 'sent');
  assert.equal(result.attachments[0].content, undefined);
  assert.deepEqual(fs.readdirSync(w.dir).filter((name) => name.startsWith('u2os-mail-')), [], 'temporary copies are gone');
});

test('draft saves without sending', async () => {
  const w = world();
  const mail = createMailSender({ vaultDir: w.vault, tmpdir: w.dir, run: async (args) => { assert.equal(args[0], 'draft'); return 'saved'; } });
  assert.equal((await mail.draft({ to: 'a@b.test', subject: 's', body: 'b' })).status, 'draft_saved');
});

test('nothing is attempted for an unstaged, changed or path-style attachment, or a bad recipient or subject', async () => {
  const w = world();
  let calls = 0;
  const mail = createMailSender({ vaultDir: w.vault, tmpdir: w.dir, run: async () => { calls += 1; return 'sent'; } });
  const base = { to: 'a@b.test', subject: 's', body: 'b' };
  await assert.rejects(mail.send({ ...base, attachments: ['/etc/passwd'] }), /file paths are not accepted/);
  await assert.rejects(mail.send({ ...base, attachments: [`outbox/${'a'.repeat(64)}/x.pdf`] }), /not staged/);
  fs.writeFileSync(path.join(w.vault, w.ref), 'swapped');
  await assert.rejects(mail.send({ ...base, attachments: [w.ref] }), /changed after it was staged/);
  for (const bad of [{ to: 'a@b.test, c@d.test' }, { to: 'not-an-address' }, { to: '"x"@y.test; do shell' }, { subject: 'one\nBcc: x@y.test' }, { subject: '' }, { body: '' }]) {
    await assert.rejects(mail.send({ ...base, ...bad }), /to:|subject:|body:/);
  }
  assert.equal(calls, 0);
  assert.throws(() => createMailSender({ vaultDir: w.vault, sender: 'a\nb' }), /single line/);
});

test('a failure or timeout while sending is an uncertain outcome; a failed draft is a plain error', async () => {
  const w = world();
  const failing = (over) => createMailSender({ vaultDir: w.vault, tmpdir: w.dir, run: async () => { throw Object.assign(new Error('boom'), over); } });
  await assert.rejects(failing({ timedOut: true }).send({ to: 'a@b.test', subject: 's', body: 'b' }), /outcome uncertain.*did not answer in time/);
  await assert.rejects(failing({ stderr: 'Mail got an error' }).send({ to: 'a@b.test', subject: 's', body: 'b' }), /outcome uncertain/);
  await assert.rejects(failing({ stderr: 'Mail got an error' }).draft({ to: 'a@b.test', subject: 's', body: 'b' }), (error) => /Mail got an error/.test(error.message) && !/uncertain/.test(error.message));
  const odd = createMailSender({ vaultDir: w.vault, tmpdir: w.dir, run: async () => 'who knows' });
  await assert.rejects(odd.send({ to: 'a@b.test', subject: 's', body: 'b' }), /uncertain/);
});

test('the Apple add-on manifest is valid and declares send and draft as unsuggested (confirm-by-default) tools', () => {
  const manifest = validateAddonManifest(parseAddonYaml(fs.readFileSync(new URL('../addons/apple/addon.yaml', import.meta.url), 'utf8')));
  const server = manifest.servers.find((entry) => entry.name === 'apple_mail');
  assert.ok(server);
  assert.deepEqual(server.tools.map((tool) => tool.name).sort(), ['draft', 'send']);
  assert.ok(server.tools.every((tool) => tool.suggestedRead === false));
  assert.equal(manifest.settings.mail_sender.type, 'string');
});
