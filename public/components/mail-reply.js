// Reply links for the mail dialog (#436). U2OS does not send these replies:
// the link opens the owner's own mail client with the message quoted, so no
// send capability or permission is involved. Pure functions, no DOM.

export const MAX_QUOTE_CHARS = 2000;

const GMAIL_COMPOSE = 'https://mail.google.com/mail/';

export function replySubject(subject) {
  const text = String(subject || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return 'Re:';
  return /^re:/i.test(text) ? text : `Re: ${text}`;
}

// "On <date>, <from> wrote:" followed by the original, each line prefixed
// with "> " and cut at MAX_QUOTE_CHARS so the link stays within what mail
// clients and browsers accept.
export function quoteMessage({ from, date, body }) {
  const when = date && !Number.isNaN(new Date(date).getTime()) ? new Date(date).toUTCString() : '';
  const who = String(from || 'the sender').replace(/[\r\n]+/g, ' ');
  const header = `On ${when ? `${when}, ` : ''}${who} wrote:`;
  let text = String(body || '').replace(/\r\n?/g, '\n').trim();
  let truncated = false;
  if (text.length > MAX_QUOTE_CHARS) {
    text = text.slice(0, MAX_QUOTE_CHARS);
    truncated = true;
  }
  const lines = text.split('\n').map((line) => `> ${line}`.trimEnd());
  if (truncated) lines.push('> […]');
  return `\n\n${header}\n${lines.join('\n')}\n`;
}

// Returns { url, kind } or null when there is no safe address to reply to.
// `email` is the object from GET /api/email/:id, whose `sender_address` is the
// server's conservative parse of the From header (never a guess).
export function buildReplyLink(email) {
  const to = email && email.sender_address;
  if (typeof to !== 'string' || !to) return null;
  const subject = replySubject(email.subject);
  const body = quoteMessage({ from: email.from_addr, date: email.received_at, body: email.body });
  const enc = encodeURIComponent;

  if (email.provider === 'gmail') {
    // `authuser` picks the Google account the message arrived in, so the
    // reply opens from the right mailbox when several are signed in.
    const account = Array.isArray(email.to_addr) ? email.to_addr.find((a) => typeof a === 'string' && /^[^\s<>@]+@[^\s<>@]+$/.test(a)) : null;
    const params = [`view=cm`, `fs=1`, `to=${enc(to)}`, `su=${enc(subject)}`, `body=${enc(body)}`];
    if (account) params.push(`authuser=${enc(account)}`);
    return { kind: 'gmail', url: `${GMAIL_COMPOSE}?${params.join('&')}` };
  }
  return { kind: 'mailto', url: `mailto:${enc(to).replace(/%40/g, '@')}?subject=${enc(subject)}&body=${enc(body)}` };
}
