#!/usr/bin/env node
import { listChats, readChat } from './imsg-helper.js';

try {
  const [operation, id, limitArg] = process.argv.slice(2);
  let result;
  if (operation === 'chats') result = await listChats({ limit: id === undefined ? undefined : Number(id) });
  else if (operation === 'history') result = await readChat({ chatId: id, limit: limitArg === undefined ? undefined : Number(limitArg) });
  else throw new Error('Usage: imsg:read chats [limit] | imsg:read history <chat-id> [limit]');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
