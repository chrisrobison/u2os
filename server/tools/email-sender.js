// Deliberately narrower than RFC 5322: never repair or choose among mailboxes.
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const MAILBOX = new RegExp(`^${ATOM}(?:\\.${ATOM})*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`);

export function observedSenderAddress(header) {
  if (typeof header !== 'string' || header.length > 2048 || /[\x00-\x1f\x7f]/.test(header)) return null;
  const source = header.trim();
  if (MAILBOX.test(source)) return source;
  const match = /^([^<>]*)<([^<>]+)>$/.exec(source);
  if (!match || !MAILBOX.test(match[2].trim())) return null;
  const display = match[1].trim();
  // One quoted display name may contain a comma. Unquoted names cannot
  // contain list/group/comment/quote delimiters or another mailbox.
  if (display.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\[\x20-\x7e])*"$/.test(display)) return null;
  } else if (/[",:;()\\@]/.test(display)) return null;
  return match[2].trim();
}

export function withObservedSender(email) {
  if (!email || typeof email !== 'object' || Array.isArray(email)) return email;
  const { sender_address: _ignored, ...original } = email;
  // Keep the derived field inside the existing bounded observation prefix.
  return { sender_address: observedSenderAddress(original.from_addr), ...original };
}
