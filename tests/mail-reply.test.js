import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyLink, quoteMessage, replySubject, MAX_QUOTE_CHARS } from '../public/components/mail-reply.js';

const base = {
  provider: 'gmail', sender_address: 'sarah@example.com', from_addr: 'Sarah Chen <sarah@example.com>',
  to_addr: ['chris@example.com'], subject: 'Sync tomorrow?', received_at: '2026-10-05T14:00:00Z', body: 'Can we talk at 2?\nBring the draft.',
};

test('subject gets one Re: prefix and loses line breaks', () => {
  assert.equal(replySubject('Hello'), 'Re: Hello');
  assert.equal(replySubject('RE: Hello'), 'RE: Hello');
  assert.equal(replySubject('re:Hello'), 're:Hello');
  assert.equal(replySubject('Hi\r\nBcc: x@evil.test'), 'Re: Hi Bcc: x@evil.test');
  assert.equal(replySubject(''), 'Re:');
  assert.equal(replySubject(null), 'Re:');
});

test('the original is quoted line by line under an attribution', () => {
  const quoted = quoteMessage({ from: 'Sarah <s@example.com>', date: '2026-10-05T14:00:00Z', body: 'one\r\n\r\ntwo' });
  assert.equal(quoted, '\n\nOn Mon, 05 Oct 2026 14:00:00 GMT, Sarah <s@example.com> wrote:\n> one\n>\n> two\n');
});

test('a long original is cut and marked, keeping the link bounded', () => {
  const quoted = quoteMessage({ from: 'a', body: 'x'.repeat(MAX_QUOTE_CHARS * 3) });
  assert.ok(quoted.includes('> […]'));
  assert.ok(quoted.length < MAX_QUOTE_CHARS + 200);
});

test('a Gmail message opens Gmail compose from the right account', () => {
  const { kind, url } = buildReplyLink(base);
  assert.equal(kind, 'gmail');
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://mail.google.com/mail/');
  assert.equal(parsed.searchParams.get('view'), 'cm');
  assert.equal(parsed.searchParams.get('fs'), '1');
  assert.equal(parsed.searchParams.get('to'), 'sarah@example.com');
  assert.equal(parsed.searchParams.get('su'), 'Re: Sync tomorrow?');
  assert.equal(parsed.searchParams.get('authuser'), 'chris@example.com');
  const body = parsed.searchParams.get('body');
  assert.match(body, /wrote:\n> Can we talk at 2\?\n> Bring the draft\./);
});

test('special characters survive encoding and cannot add parameters', () => {
  const evil = { ...base, subject: 'A&B=C #1 100% éè', body: '&to=attacker@evil.test&bcc=x\n#frag' };
  const parsed = new URL(buildReplyLink(evil).url);
  assert.equal(parsed.searchParams.get('su'), 'Re: A&B=C #1 100% éè');
  assert.deepEqual(parsed.searchParams.getAll('to'), ['sarah@example.com']);
  assert.equal(parsed.searchParams.get('bcc'), null);
  assert.match(parsed.searchParams.get('body'), /&to=attacker@evil\.test&bcc=x\n> #frag/);
  assert.equal(parsed.hash, '');
});

test('other accounts get a mailto link', () => {
  const { kind, url } = buildReplyLink({ ...base, provider: 'imap' });
  assert.equal(kind, 'mailto');
  assert.ok(url.startsWith('mailto:sarah@example.com?subject=Re%3A%20Sync%20tomorrow%3F&body='));
  assert.ok(!url.includes('mail.google.com'));
});

test('without a verified sender address there is no link', () => {
  assert.equal(buildReplyLink({ ...base, sender_address: null }), null);
  assert.equal(buildReplyLink({ ...base, sender_address: '' }), null);
  assert.equal(buildReplyLink(null), null);
});

test('a missing account or odd recipient list does not break the link', () => {
  assert.ok(!new URL(buildReplyLink({ ...base, to_addr: [] }).url).searchParams.has('authuser'));
  assert.ok(!new URL(buildReplyLink({ ...base, to_addr: 'chris@example.com' }).url).searchParams.has('authuser'));
  assert.ok(!new URL(buildReplyLink({ ...base, to_addr: ['not an address'] }).url).searchParams.has('authuser'));
});
