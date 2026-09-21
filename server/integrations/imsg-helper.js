// Explicit, local-only bridge to the installed imsg CLI. Deliberately not an
// agent tool: Messages content must not enter model context or the event log
// just because a model suggested a read.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CHATS = 20;
const MAX_MESSAGES = 30;
const MAX_TEXT = 4000;

function boundedCount(value, fallback, max) {
  const count = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > max) {
    throw new Error(`limit must be an integer between 1 and ${max}`);
  }
  return count;
}

function parseLines(stdout) {
  try {
    return String(stdout).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    throw new Error('imsg returned invalid JSON');
  }
}

async function run(args, { enabled = process.env.U2OS_ENABLE_IMSG_READ === '1', exec = execFileAsync } = {}) {
  if (!enabled) throw new Error('iMessage reads are disabled; set U2OS_ENABLE_IMSG_READ=1 for this command');
  try {
    const { stdout } = await exec('imsg', args, { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true });
    return parseLines(stdout);
  } catch (err) {
    if (err.message === 'imsg returned invalid JSON') throw err;
    // Never expose stderr: it can contain local paths or message content.
    throw new Error('imsg read failed; check installation and macOS Full Disk Access');
  }
}

export async function listChats({ limit = 10 } = {}, options = {}) {
  const count = boundedCount(limit, 10, MAX_CHATS);
  const rows = await run(['chats', '--limit', String(count), '--json'], options);
  return rows.slice(0, count).map((row) => ({
    id: row.id,
    name: String(row.name || '').slice(0, 200),
    service: String(row.service || '').slice(0, 30),
    lastMessageAt: row.last_message_at || null,
    isGroup: !!row.is_group,
    participants: Array.isArray(row.participants) ? row.participants.slice(0, 20).map((item) => String(item).slice(0, 200)) : [],
  }));
}

export async function readChat({ chatId, limit = 20 } = {}, options = {}) {
  const id = Number(chatId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('chatId must be a positive integer from imsg chats');
  const count = boundedCount(limit, 20, MAX_MESSAGES);
  const rows = await run(['history', '--chat-id', String(id), '--limit', String(count), '--json'], options);
  return rows.slice(0, count).map((row) => ({
    id: row.id ?? row.guid ?? null,
    text: String(row.text || '').slice(0, MAX_TEXT),
    createdAt: row.created_at || null,
    isFromMe: !!row.is_from_me,
    sender: String(row.sender || '').slice(0, 200),
  }));
}
