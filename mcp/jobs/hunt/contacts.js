// Networking contacts tied to jobs (#537). Data lives in the hunt store
// (`job_contacts`); nothing references core people, so the job hunt stays
// extractable (no core people lookup by email exists today, so there is no
// link either).
//
// Seeding: every job's `contactEmails` (source `job_listing`) and every email
// recorded as sent (source `sent_email`, last contact = its latest sent time)
// becomes a contact the first time the dashboard is built. One contact per job
// and address, compared case-insensitively. Seeding is INSERT OR IGNORE under
// UNIQUE (job_id, email_key) and a unique source_key, so reads never duplicate;
// it never rewrites name, role, title or source of an existing row, only moves
// last_contact_at FORWARD. An owner delete keeps a dismissed row so the address
// is not seeded back.

export const ROLE_KINDS = ['recruiter', 'referral', 'hiring_manager', 'other'];
export const LIMITS = { name: 120, title: 120, email: 254 };
export const DASHBOARD_LIMIT = 50;

// One address, no display name, no comma/semicolon lists, nothing that could
// end a header line or add another recipient.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// Control characters, NEL, and the Unicode line and paragraph separators (code points 8232 and 8233).
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f\\x85${String.fromCharCode(8232, 8233)}]`);

const fail = (code, message) => Object.assign(new Error(message), { code });

export function validEmail(value) {
  return typeof value === 'string' && value.length <= LIMITS.email && EMAIL.test(value);
}

function text(value, name, max, { required = false } = {}) {
  if (value == null) {
    if (required) throw fail('BAD_INPUT', `${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw fail('BAD_INPUT', `${name} must be text`);
  const trimmed = value.trim();
  if (CONTROL.test(trimmed)) throw fail('BAD_INPUT', `${name} must be a single line of text`);
  if (!trimmed) {
    if (required) throw fail('BAD_INPUT', `${name} is required`);
    return null;
  }
  if (trimmed.length > max) throw fail('BAD_INPUT', `${name} must be at most ${max} characters`);
  return trimmed;
}

function email(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('BAD_INPUT', 'email is required');
  const trimmed = value.trim();
  if (!validEmail(trimmed)) throw fail('BAD_INPUT', 'email must be a single valid address, like jane@example.com');
  return trimmed;
}

function roleKind(value) {
  const kind = value ?? 'other';
  if (!ROLE_KINDS.includes(kind)) throw fail('BAD_INPUT', `roleKind must be one of ${ROLE_KINDS.join(', ')}`);
  return kind;
}

function requireJob(store, jobId) {
  const job = store.getJob(jobId);
  if (!job) throw fail('UNKNOWN_JOB', 'No such job');
  return job;
}

function requireContact(store, id) {
  const contact = store.getContact(id);
  if (!contact || contact.dismissedAt) throw fail('UNKNOWN_CONTACT', 'No such contact');
  return contact;
}

const visible = (contact) => ({
  id: contact.id, jobId: contact.jobId, name: contact.name, email: contact.email, roleKind: contact.roleKind, title: contact.title,
  source: contact.source, lastContactAt: contact.lastContactAt,
});

/** "jane.doe@x.co" -> "Jane Doe": a seeded contact has no name of its own. */
function nameFromEmail(address) {
  const words = address.split('@')[0].split(/[._+-]+/).filter(Boolean);
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return (name || address).slice(0, LIMITS.name);
}

export function addContact(store, jobId, input, now = new Date()) {
  const fields = { name: text(input?.name, 'name', LIMITS.name, { required: true }), email: email(input?.email), roleKind: roleKind(input?.roleKind), title: text(input?.title, 'title', LIMITS.title) };
  return store.transaction(() => {
    requireJob(store, jobId);
    const existing = store.findContact(jobId, fields.email);
    if (existing && !existing.dismissedAt) throw fail('CONFLICT', 'This job already has a contact with that email');
    // Adding back an address the owner removed revives its row with what they typed now.
    if (existing) return { contact: visible(store.updateContact(existing.id, { ...fields, dismissedAt: null }, now)) };
    return { contact: visible(store.addContact(jobId, { ...fields, source: 'manual' }, now)) };
  });
}

/** Edits name, roleKind and title. The address is the contact's identity: to change it, remove and add. */
export function updateContact(store, id, input, now = new Date()) {
  const body = input ?? {};
  if (Object.hasOwn(body, 'email') || Object.hasOwn(body, 'lastContactAt')) throw fail('BAD_INPUT', 'email and lastContactAt cannot be edited; remove the contact and add it again, or use "contacted"');
  const fields = {};
  if (Object.hasOwn(body, 'name')) fields.name = text(body.name, 'name', LIMITS.name, { required: true });
  if (Object.hasOwn(body, 'roleKind')) fields.roleKind = roleKind(body.roleKind);
  if (Object.hasOwn(body, 'title')) fields.title = text(body.title, 'title', LIMITS.title);
  return store.transaction(() => {
    requireContact(store, id);
    return { contact: visible(store.updateContact(id, fields, now)) };
  });
}

/** Idempotent: a missing contact answers removed: false. The row is kept dismissed, so nothing seeds the address back later. */
export function deleteContact(store, id, now = new Date()) {
  return store.transaction(() => {
    const contact = store.getContact(id);
    if (!contact || contact.dismissedAt) return { removed: false };
    store.updateContact(id, { dismissedAt: now.toISOString() }, now);
    return { removed: true };
  });
}

/** The owner reached out (or heard back) just now. Never moves the date backwards. */
export function markContacted(store, id, now = new Date()) {
  return store.transaction(() => {
    const contact = requireContact(store, id);
    const stamp = now.toISOString();
    if (contact.lastContactAt && contact.lastContactAt >= stamp) return { contact: visible(contact) };
    return { contact: visible(store.updateContact(id, { lastContactAt: stamp }, now)) };
  });
}

/** Creates the seeded contacts that do not exist yet and advances last contact from sent mail. Safe on every read. */
export function seedContacts(store, now = new Date()) {
  store.transaction(() => {
    const jobs = new Map(store.listJobs({ limit: 5000 }).map((job) => [job.id, job]));
    for (const job of jobs.values()) {
      for (const address of job.contactEmails ?? []) {
        if (!validEmail(address)) continue; // scraped text: skip anything that is not one clean address
        store.addContact(job.id, { name: nameFromEmail(address), email: address, source: 'job_listing', sourceKey: `job_listing:${job.id}:${address.toLowerCase()}` }, now);
      }
    }
    const latest = new Map();
    for (const mail of store.listEmails()) {
      if (mail.status !== 'sent' || !jobs.has(mail.jobId) || !validEmail(mail.to)) continue;
      const sentAt = typeof mail.detail?.sentAt === 'string' && !Number.isNaN(Date.parse(mail.detail.sentAt)) ? new Date(mail.detail.sentAt).toISOString() : mail.updatedAt;
      const key = `${mail.jobId}:${mail.to.toLowerCase()}`;
      const seen = latest.get(key);
      if (!seen || sentAt > seen.sentAt) latest.set(key, { jobId: mail.jobId, to: mail.to, sentAt });
    }
    for (const { jobId, to, sentAt } of latest.values()) {
      const contact = store.addContact(jobId, { name: nameFromEmail(to), email: to, source: 'sent_email', sourceKey: `sent_email:${jobId}:${to.toLowerCase()}`, lastContactAt: sentAt }, now);
      if (contact && (!contact.lastContactAt || contact.lastContactAt < sentAt)) store.updateContact(contact.id, { lastContactAt: sentAt }, now);
    }
  });
}

/** The dashboard's `contacts`: most recently contacted first (never contacted last), at most 50. */
export function dashboardContacts(store, now = new Date()) {
  seedContacts(store, now);
  const jobs = new Map(store.listJobs({ limit: 5000 }).map((job) => [job.id, job]));
  const rows = [];
  for (const contact of store.listContacts()) {
    const job = jobs.get(contact.jobId);
    if (!job || contact.dismissedAt) continue;
    rows.push({ id: contact.id, jobId: job.id, company: job.company, role: job.role, name: contact.name, email: contact.email, roleKind: contact.roleKind, title: contact.title, lastContactAt: contact.lastContactAt });
  }
  rows.sort((a, b) => (a.lastContactAt === b.lastContactAt ? a.id - b.id : a.lastContactAt == null ? 1 : b.lastContactAt == null ? -1 : a.lastContactAt < b.lastContactAt ? 1 : -1));
  return rows.slice(0, DASHBOARD_LIMIT);
}
