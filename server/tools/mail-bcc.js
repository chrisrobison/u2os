import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/connection.js';

// The owner's own address, Bcc'd on every message U2OS sends, so the owner can see
// that mail really went out. It comes only from the owner's configuration
// (U2OS_MAIL_BCC, or `mailBcc` in config.json), never from tool arguments or model output.

const ADDRESS = /^[^\s@,<>"';]+@[^\s@,<>"';]+\.[^\s@,<>"';]+$/;

export function parseBcc(value) {
  if (value === undefined || value === null || value === '') return null;
  const address = String(value).trim();
  if (!ADDRESS.test(address) || address.length > 320) throw new Error('mail Bcc must be one valid email address');
  return address;
}

/** The configured Bcc address, or null. A malformed value is an error: mail is never sent with a silently wrong Bcc. */
export function ownerBcc({ env = process.env, dataDir = null } = {}) {
  if (env.U2OS_MAIL_BCC) return parseBcc(env.U2OS_MAIL_BCC);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(dataDir ?? getDataDir(), 'config', 'config.json'), 'utf8')); } catch { /* none */ }
  return parseBcc(config.mailBcc);
}
