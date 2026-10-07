import crypto from 'node:crypto';

// Minimal, strict MIME composition for providers that take a raw RFC 5322
// message (Gmail). Headers are written by us from validated values only.

const wrap = (base64) => base64.replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');

/** RFC 2047 encoded-word for a header value that is not plain ASCII. */
export function encodeHeaderValue(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * A multipart/mixed message: one UTF-8 text part and the attachments, which
 * are `{ filename, contentType, content: Buffer }`. Filenames must already be
 * sanitised (server/tools/email-attachments.js safeFilename).
 */
export function buildMultipart({ to, subject, body, attachments }) {
  const boundary = `u2os-${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(body, 'utf8').toString('base64')),
  ];
  for (const item of attachments) {
    if (!/^[A-Za-z0-9._ -]{1,100}$/.test(item.filename) || /[\r\n";]/.test(item.contentType)) throw new Error('mime: unsafe attachment metadata');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${item.contentType}; name="${item.filename}"`,
      `Content-Disposition: attachment; filename="${item.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(item.content).toString('base64')),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}
