#!/usr/bin/env node
// Apple Mail send and draft with attachments, for the bundled Apple add-on.
// apple-mcp's own mail tool cannot attach files; this server can, using the
// same staged, hash-pinned attachment references as email.send
// (server/tools/email-attachments.js, docs/tools.md#email-attachments).
//
//   node addons/apple/mail-send/server.js --vault /path/to/vault [--sender "Name <me@example.com>"]
//
// Every call reaches this server through U2OS's action gate. The AppleScript
// is a fixed program: every value (recipient, subject, body, file paths) is
// passed as an argument to `osascript`, never interpolated into script text.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '../../../mcp/lib/stdio-server.js';
import { resolveAttachments, describeAttachments } from '../../../server/tools/email-attachments.js';

const SCRIPT = `on run argv
  set theMode to item 1 of argv
  set theSender to item 2 of argv
  set theTo to item 3 of argv
  set theSubject to item 4 of argv
  set theBody to item 5 of argv
  set thePaths to {}
  if (count of argv) > 5 then set thePaths to items 6 thru -1 of argv
  tell application "Mail"
    set theMessage to make new outgoing message with properties {subject:theSubject, content:theBody & return & return, visible:false}
    tell theMessage
      make new to recipient at end of to recipients with properties {address:theTo}
      if theSender is not "" then set sender to theSender
      repeat with thePath in thePaths
        make new attachment with properties {file name:(POSIX file (thePath as text))} at after the last paragraph
      end repeat
    end tell
    delay 1
    if theMode is "send" then
      send theMessage
      return "sent"
    else
      save theMessage
      return "saved"
    end if
  end tell
end run`;

const ADDRESS = /^[^\s@,<>"';]+@[^\s@,<>"';]+\.[^\s@,<>"';]+$/;
const SENDER = /^[^\r\n\0]{0,200}$/;
export const TIMEOUT_MS = 60_000;

function osascript(args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('osascript', ['-', ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' } }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stderr: String(stderr).slice(0, 500), timedOut: error.killed === true }));
      resolve(String(stdout).trim());
    });
    child.stdin.end(SCRIPT);
  });
}

/**
 * Builds the two handlers. `run(args)` runs the fixed AppleScript with the
 * given arguments and returns its output; it is injected in tests.
 */
export function createMailSender({ vaultDir, sender = '', run = osascript, tmpdir = os.tmpdir() } = {}) {
  if (!SENDER.test(sender)) throw new Error('mail_sender must be a single line');

  async function deliver(mode, args) {
    if (typeof args.to !== 'string' || !ADDRESS.test(args.to.trim()) || args.to.length > 320) throw new Error('to: exactly one valid email address is required');
    if (typeof args.subject !== 'string' || !args.subject.trim() || args.subject.length > 998 || /[\r\n\0]/.test(args.subject)) throw new Error('subject: one line, up to 998 characters');
    if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 100_000 || args.body.includes('\0')) throw new Error('body: required text, up to 100,000 characters');
    // Verify and snapshot the attachments before anything is attempted. Mail reads copies of the verified
    // bytes from a private directory, so the file cannot change between the check and the send.
    const resolved = args.attachments === undefined ? [] : resolveAttachments(vaultDir, args.attachments);
    let workdir = null;
    try {
      const paths = [];
      if (resolved.length) {
        workdir = fs.mkdtempSync(path.join(tmpdir, 'u2os-mail-'));
        fs.chmodSync(workdir, 0o700);
        for (const item of resolved) {
          const file = path.join(workdir, item.filename);
          fs.writeFileSync(file, item.content, { mode: 0o600, flag: 'wx' });
          paths.push(file);
        }
      }
      let output;
      try {
        output = await run([mode, sender, args.to.trim(), args.subject, args.body, ...paths]);
      } catch (error) {
        // After the script starts, failure does not prove nothing was sent (Mail may have queued it).
        if (error.timedOut || mode === 'send') {
          throw new Error(`apple_mail: send outcome uncertain${error.timedOut ? ' (Mail did not answer in time)' : ''}; check Mail's Sent and Outbox before sending again`);
        }
        throw new Error(`apple_mail: ${String(error.stderr || error.message).replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      if (output !== (mode === 'send' ? 'sent' : 'saved')) throw new Error(`apple_mail: unexpected result from Mail${mode === 'send' ? '; send outcome uncertain, check Sent and Outbox before sending again' : ''}`);
      return { status: mode === 'send' ? 'sent' : 'draft_saved', to: args.to.trim(), subject: args.subject, ...(resolved.length ? { attachments: describeAttachments(resolved) } : {}) };
    } finally {
      if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
    }
  }

  return { send: (args) => deliver('send', args), draft: (args) => deliver('draft', args) };
}

const schema = {
  type: 'object',
  properties: {
    to: { type: 'string', description: 'One recipient email address' },
    subject: { type: 'string' },
    body: { type: 'string', description: 'Plain text body' },
    attachments: { type: 'array', items: { type: 'string' }, description: '1-3 staged attachment references of the form outbox/<sha256>/<filename>, exactly as given to you. Never a file path.' },
  },
  required: ['to', 'subject', 'body'],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const flag = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
  const vaultDir = path.resolve(flag('--vault') ?? process.cwd());
  const sender = flag('--sender') ?? '';
  const mail = createMailSender({ vaultDir, sender });
  serveStdio({
    name: 'u2os-apple-mail',
    tools: {
      send: { description: 'Send an email through the Mail app on this Mac, from the owner\'s configured account, with optional staged attachments (resume, cover letter).', inputSchema: schema, handler: mail.send },
      draft: { description: 'Save an email as a draft in the Mail app (not sent), with optional staged attachments, for the owner to review.', inputSchema: schema, handler: mail.draft },
    },
  });
}
