import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listChats, readChat } from '../server/integrations/imsg-helper.js';

test('imsg helper is disabled by default and never launches the CLI', async () => {
  let called = false;
  await assert.rejects(listChats({}, { enabled: false, exec: async () => { called = true; } }), /disabled/);
  assert.equal(called, false);
});

test('imsg helper uses fixed read-only argv and strips attachment paths', async () => {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: args[0] === 'chats'
      ? `${JSON.stringify({ id: 7, name: 'Project chat', service: 'iMessage', last_message_at: '2026-09-20T12:00:00Z', participants: ['alice@example.com'], account_login: 'secret' })}\n`
      : `${JSON.stringify({ id: 8, sender: 'alice@example.com', text: 'Discuss launch', created_at: '2026-09-20T12:00:00Z', attachments: [{ path: '/private/attachment' }] })}\n` };
  };
  const chats = await listChats({ limit: 2 }, { enabled: true, exec });
  const history = await readChat({ chatId: 7, limit: 3 }, { enabled: true, exec });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['imsg', ['chats', '--limit', '2', '--json']],
    ['imsg', ['history', '--chat-id', '7', '--limit', '3', '--json']],
  ]);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  assert.equal(chats[0].name, 'Project chat');
  assert.equal(history[0].text, 'Discuss launch');
  assert.equal(history[0].createdAt, '2026-09-20T12:00:00Z');
  assert.doesNotMatch(JSON.stringify({ chats, history }), /secret|attachment/);
});

test('imsg helper rejects unbounded and nonnumeric inputs before launching', async () => {
  const exec = async () => { throw new Error('must not run'); };
  await assert.rejects(listChats({ limit: 21 }, { enabled: true, exec }), /limit/);
  await assert.rejects(readChat({ chatId: '7; echo secret' }, { enabled: true, exec }), /chatId/);
  await assert.rejects(readChat({ chatId: 1, limit: 31 }, { enabled: true, exec }), /limit/);
});

test('imsg helper sanitizes subprocess failures', async () => {
  await assert.rejects(
    listChats({}, { enabled: true, exec: async () => { throw new Error('private message in stderr'); } }),
    (err) => !err.message.includes('private message') && /imsg read failed/.test(err.message)
  );
});
