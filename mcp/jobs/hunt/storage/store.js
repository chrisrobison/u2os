import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { identityKeys, normalizeCompany, normalizeRole } from '../jobs/normalize.js';
import { JOB_HUNT_DIR } from '../../profile.js';

// The job hunter's runtime store: opportunities (jobs), every sighting of
// them (job_sources) and the event history. SQLite is an index and runtime
// store (ADR 0007); consequential applications are additionally recorded as
// vault files by the existing ledger so the owner always has the record.

const SCHEMA_VERSION = 7;

const MIGRATIONS = [
  `CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     company TEXT NOT NULL, company_key TEXT NOT NULL,
     role TEXT, role_key TEXT,
     locations TEXT NOT NULL DEFAULT '[]', remote INTEGER,
     salary TEXT, equity TEXT, visa TEXT,
     technologies TEXT NOT NULL DEFAULT '[]',
     description TEXT NOT NULL DEFAULT '',
     contact_emails TEXT NOT NULL DEFAULT '[]',
     application_urls TEXT NOT NULL DEFAULT '[]',
     company_url TEXT,
     status TEXT NOT NULL DEFAULT 'discovered',
     first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX jobs_status ON jobs(status);
   CREATE TABLE job_keys (key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id));
   CREATE TABLE job_sources (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     source TEXT NOT NULL, source_thread TEXT, source_comment TEXT, source_key TEXT NOT NULL UNIQUE,
     source_url TEXT, author TEXT, raw_text TEXT NOT NULL, parse_quality TEXT,
     data TEXT NOT NULL, posted_at TEXT, discovered_at TEXT NOT NULL
   );
   CREATE INDEX job_sources_job ON job_sources(job_id);
   CREATE TABLE application_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
     from_status TEXT, to_status TEXT, detail TEXT NOT NULL DEFAULT '{}'
   );
   CREATE INDEX application_events_job ON application_events(job_id, id);`,
  `CREATE TABLE job_scores (
     job_id TEXT PRIMARY KEY REFERENCES jobs(id),
     score INTEGER NOT NULL, confidence REAL NOT NULL, label TEXT NOT NULL,
     dimensions TEXT NOT NULL, reasons TEXT NOT NULL, concerns TEXT NOT NULL,
     narrative TEXT NOT NULL, projects TEXT NOT NULL, flags TEXT NOT NULL,
     degraded INTEGER NOT NULL DEFAULT 0, model TEXT, scored_at TEXT NOT NULL
   );
   CREATE INDEX job_scores_score ON job_scores(score);`,
  `CREATE TABLE artifacts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL, path TEXT NOT NULL,
     sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
   );
   CREATE INDEX artifacts_job ON artifacts(job_id, kind, id);`,
  `CREATE TABLE emails (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     kind TEXT NOT NULL DEFAULT 'application',
     to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]',
     action_id TEXT, status TEXT NOT NULL,
     idempotency_key TEXT NOT NULL UNIQUE,
     detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX emails_job ON emails(job_id, id);`,
  `CREATE TABLE applications (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     kind TEXT NOT NULL DEFAULT 'form',
     url TEXT NOT NULL, status TEXT NOT NULL,
     plan TEXT NOT NULL, plan_hash TEXT NOT NULL,
     idempotency_key TEXT NOT NULL UNIQUE,
     result TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX applications_job ON applications(job_id, id);`,
  `CREATE TABLE reviews (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     kind TEXT NOT NULL,
     decision TEXT NOT NULL, content_hash TEXT NOT NULL,
     checks TEXT NOT NULL, concerns TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
     model TEXT, created_at TEXT NOT NULL
   );
   CREATE INDEX reviews_job ON reviews(job_id, kind, id);`,
  // Interviews and tasks tied to jobs (#536). Additive: no existing table changes.
  // job_tasks.source_key is set only on generated follow-ups, so materializing
  // them is idempotent (INSERT OR IGNORE on the unique key).
  `CREATE TABLE interviews (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     at TEXT NOT NULL, ends_at TEXT, kind TEXT NOT NULL DEFAULT 'video', round TEXT,
     location_or_link TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     UNIQUE (job_id, at)
   );
   CREATE INDEX interviews_at ON interviews(at);
   CREATE TABLE job_tasks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     title TEXT NOT NULL, due_at TEXT, done_at TEXT, kind TEXT NOT NULL DEFAULT 'task', snoozed_until TEXT,
     source_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX job_tasks_job ON job_tasks(job_id, id);
   CREATE INDEX job_tasks_open ON job_tasks(done_at, due_at);`,
];

export const JOB_STATUSES = ['discovered', 'scored', 'researching', 'qualified', 'materials_generated', 'applying', 'applied', 'contacted', 'needs_input', 'followup_due', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'closed', 'skipped', 'error', 'uncertain'];

export function huntDbPath(vaultDir) {
  return path.join(vaultDir, JOB_HUNT_DIR, 'state', 'hunt.sqlite');
}

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };

export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  let version = db.prepare('PRAGMA user_version').get().user_version;
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    version += 1;
  }
  if (version > SCHEMA_VERSION) throw new Error(`hunt store is newer (v${version}) than this software (v${SCHEMA_VERSION})`);
  return new Store(db);
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id, company: row.company, role: row.role,
    locations: parse(row.locations, []), remote: row.remote == null ? null : Boolean(row.remote),
    salary: parse(row.salary), equity: row.equity, visa: row.visa,
    technologies: parse(row.technologies, []), description: row.description,
    contactEmails: parse(row.contact_emails, []), applicationUrls: parse(row.application_urls, []),
    companyUrl: row.company_url, status: row.status, firstSeenAt: row.first_seen_at, updatedAt: row.updated_at,
  };
}

function rowToInterview(row) {
  return row ? { id: row.id, jobId: row.job_id, at: row.at, endsAt: row.ends_at, kind: row.kind, round: row.round, locationOrLink: row.location_or_link, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function rowToTask(row) {
  return row ? { id: row.id, jobId: row.job_id, title: row.title, dueAt: row.due_at, doneAt: row.done_at, kind: row.kind, snoozedUntil: row.snoozed_until, sourceKey: row.source_key, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

const mergeList = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];

class Store {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }

  // Transactions nest: an inner call joins the outer one through a savepoint.
  transaction(fn) {
    const nested = this.db.isTransaction;
    const name = `sp_${(this._depth = (this._depth ?? 0) + 1)}`;
    this.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
      throw error;
    } finally { this._depth -= 1; }
  }

  /**
   * Records a sighting of a job. Several sightings of the same opportunity
   * (HN comment, Greenhouse posting, careers page, next month's repost) merge
   * into one job through any shared identity key. Idempotent: the same
   * sighting twice changes nothing.
   * Returns { job, created, duplicate }.
   */
  upsertSighting(sighting, now = new Date()) {
    const at = now.toISOString();
    const keys = identityKeys({ company: sighting.company, role: sighting.role, applicationUrls: sighting.applicationUrls, sourceKey: sighting.sourceKey });
    return this.transaction(() => {
      const seen = this.db.prepare('SELECT job_id FROM job_sources WHERE source_key = ?').get(sighting.sourceKey);
      if (seen) return { job: this.getJob(seen.job_id), created: false, duplicate: true };

      let jobId = null;
      for (const key of keys) {
        const hit = this.db.prepare('SELECT job_id FROM job_keys WHERE key = ?').get(key);
        if (hit) { jobId = hit.job_id; break; }
      }
      const created = !jobId;
      if (created) {
        jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
        this.db.prepare(`INSERT INTO jobs (id, company, company_key, role, role_key, locations, remote, salary, equity, visa, technologies, description, contact_emails, application_urls, company_url, status, first_seen_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)`).run(
          jobId, sighting.company, normalizeCompany(sighting.company), sighting.role ?? null, normalizeRole(sighting.role) || null,
          json(sighting.locations ?? []), sighting.remote == null ? null : Number(sighting.remote), sighting.salary ? json(sighting.salary) : null,
          sighting.equity ?? null, sighting.visa ?? null, json(sighting.technologies ?? []), sighting.description ?? '',
          json(sighting.contactEmails ?? []), json(sighting.applicationUrls ?? []), sighting.companyUrl ?? null, at, at);
        this.recordEvent(jobId, 'discovered', { toStatus: 'discovered', detail: { source: sighting.source, sourceKey: sighting.sourceKey, author: sighting.author } }, now);
      } else {
        // Another source for a known job: only fill what is missing, and
        // never change a job that has moved on in the pipeline.
        const current = this.getJob(jobId);
        this.db.prepare(`UPDATE jobs SET locations = ?, remote = COALESCE(remote, ?), salary = COALESCE(salary, ?), equity = COALESCE(equity, ?), visa = COALESCE(visa, ?),
          technologies = ?, contact_emails = ?, application_urls = ?, company_url = COALESCE(company_url, ?), updated_at = ? WHERE id = ?`).run(
          json(mergeList(current.locations, sighting.locations)), sighting.remote == null ? null : Number(sighting.remote), sighting.salary ? json(sighting.salary) : null,
          sighting.equity ?? null, sighting.visa ?? null, json(mergeList(current.technologies, sighting.technologies)),
          json(mergeList(current.contactEmails, sighting.contactEmails)), json(mergeList(current.applicationUrls, sighting.applicationUrls)),
          sighting.companyUrl ?? null, at, jobId);
        this.recordEvent(jobId, 'source_added', { detail: { source: sighting.source, sourceKey: sighting.sourceKey } }, now);
      }
      this.db.prepare(`INSERT INTO job_sources (job_id, source, source_thread, source_comment, source_key, source_url, author, raw_text, parse_quality, data, posted_at, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, sighting.source, sighting.sourceThread ?? null, sighting.sourceComment ?? null, sighting.sourceKey,
        sighting.sourceUrl ?? null, sighting.author ?? null, sighting.rawText ?? '', sighting.parseQuality ?? null, json(sighting), sighting.postedAt ?? null, at);
      // The new identities (the ATS id this source revealed, say) now point at the job too.
      for (const key of keys) this.db.prepare('INSERT OR IGNORE INTO job_keys (key, job_id) VALUES (?, ?)').run(key, jobId);
      return { job: this.getJob(jobId), created, duplicate: false };
    });
  }

  /** Replaces a job's contact emails (a corrected parse of its original text). */
  setContactEmails(jobId, emails, now = new Date()) {
    this.db.prepare('UPDATE jobs SET contact_emails = ?, updated_at = ? WHERE id = ?').run(json(emails), now.toISOString(), jobId);
  }

  /** Corrects a job's company (the employer behind a portfolio board) and its company+role identity key. */
  setCompany(jobId, company, now = new Date()) {
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || job.company === company) return;
      const row = this.db.prepare('SELECT role_key FROM jobs WHERE id = ?').get(jobId);
      this.db.prepare('DELETE FROM job_keys WHERE job_id = ? AND key LIKE ?').run(jobId, 'role:%');
      this.db.prepare('UPDATE jobs SET company = ?, company_key = ?, updated_at = ? WHERE id = ?').run(company, normalizeCompany(company), now.toISOString(), jobId);
      const key = `role:${normalizeCompany(company)}|${row.role_key}`;
      if (row.role_key && !this.db.prepare('SELECT 1 FROM job_keys WHERE key = ?').get(key)) this.db.prepare('INSERT INTO job_keys (key, job_id) VALUES (?, ?)').run(key, jobId);
      this.recordEvent(jobId, 'company_corrected', { detail: { from: job.company, to: company } }, now);
    });
  }

  getJob(id) { return rowToJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)); }

  listJobs({ status = null, company = null, limit = 500 } = {}) {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY first_seen_at DESC, id LIMIT ?').all(Math.min(limit, 5000));
    return rows.map(rowToJob).filter((job) => (!status || job.status === status) && (!company || normalizeCompany(job.company).includes(normalizeCompany(company))));
  }

  listSources(jobId) {
    return this.db.prepare('SELECT * FROM job_sources WHERE job_id = ? ORDER BY id').all(jobId).map((row) => ({
      source: row.source, sourceKey: row.source_key, sourceThread: row.source_thread, sourceComment: row.source_comment, sourceUrl: row.source_url,
      author: row.author, rawText: row.raw_text, parseQuality: row.parse_quality, postedAt: row.posted_at, discoveredAt: row.discovered_at,
    }));
  }

  /** Every status change is an event (spec: "every transition should be recorded"). */
  transition(jobId, toStatus, detail = {}, now = new Date()) {
    if (!JOB_STATUSES.includes(toStatus)) throw new Error(`Unknown job status "${toStatus}"`);
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new Error(`Unknown job ${jobId}`);
      if (job.status === toStatus) return job;
      this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, now.toISOString(), jobId);
      this.recordEvent(jobId, 'status', { fromStatus: job.status, toStatus, detail }, now);
      return this.getJob(jobId);
    });
  }

  recordEvent(jobId, type, { fromStatus = null, toStatus = null, detail = {} } = {}, now = new Date()) {
    this.db.prepare('INSERT INTO application_events (job_id, at, type, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?)').run(jobId, now.toISOString(), type, fromStatus, toStatus, json(detail));
  }

  listEvents(jobId) {
    return this.db.prepare('SELECT * FROM application_events WHERE job_id = ? ORDER BY id').all(jobId).map((row) => ({
      id: row.id, at: row.at, type: row.type, fromStatus: row.from_status, toStatus: row.to_status, detail: parse(row.detail, {}),
    }));
  }

  /** Every status change across all jobs, oldest first (the dashboard derives its analytics from these). */
  listStatusEvents() {
    return this.db.prepare("SELECT id, job_id, at, from_status, to_status FROM application_events WHERE type = 'status' ORDER BY id").all()
      .map((row) => ({ id: row.id, jobId: row.job_id, at: row.at, fromStatus: row.from_status, toStatus: row.to_status }));
  }

  /** All artifacts of the given kinds, newest first, with their job. */
  listArtifactsByKind(kinds) {
    const marks = kinds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM artifacts WHERE kind IN (${marks}) ORDER BY id DESC`).all(...kinds)
      .map((row) => ({ id: row.id, jobId: row.job_id, kind: row.kind, path: row.path, sha256: row.sha256, bytes: row.bytes, createdAt: row.created_at }));
  }

  /** Stores the latest score for a job and moves it to `scored` (unless it has moved further on). */
  saveScore(jobId, result, now = new Date()) {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new Error(`Unknown job ${jobId}`);
      this.db.prepare(`INSERT OR REPLACE INTO job_scores (job_id, score, confidence, label, dimensions, reasons, concerns, narrative, projects, flags, degraded, model, scored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, result.score, result.confidence, result.label, json(result.dimensions), json(result.reasons), json(result.concerns),
        result.recommendedNarrative, json(result.projects), json(result.flags ?? []), result.degraded ? 1 : 0, result.model ?? null, now.toISOString());
      this.recordEvent(jobId, 'scored', { detail: { score: result.score, label: result.label, degraded: Boolean(result.degraded), model: result.model ?? null, narrative: result.recommendedNarrative } }, now);
      if (job.status === 'discovered') this.transition(jobId, 'scored', { score: result.score }, now);
      return this.getScore(jobId);
    });
  }

  getScore(jobId) {
    const row = this.db.prepare('SELECT * FROM job_scores WHERE job_id = ?').get(jobId);
    if (!row) return null;
    return {
      jobId: row.job_id, score: row.score, confidence: row.confidence, label: row.label, dimensions: parse(row.dimensions, {}),
      reasons: parse(row.reasons, []), concerns: parse(row.concerns, []), recommendedNarrative: row.narrative,
      projects: parse(row.projects, []), flags: parse(row.flags, []), degraded: Boolean(row.degraded), model: row.model, scoredAt: row.scored_at,
    };
  }

  /** Jobs with their scores, best first. Unscored jobs sort last. */
  listScored({ minScore = null, limit = 500 } = {}) {
    return this.db.prepare('SELECT job_id FROM job_scores ORDER BY score DESC, scored_at DESC LIMIT ?').all(Math.min(limit, 5000))
      .map((row) => ({ job: this.getJob(row.job_id), score: this.getScore(row.job_id) }))
      .filter((entry) => minScore == null || entry.score.score >= minScore);
  }

  /** Records a generated file. The latest artifact of a kind for a job is the current one. */
  addArtifact(jobId, kind, file, meta = {}, now = new Date()) {
    const data = fs.readFileSync(file);
    this.db.prepare('INSERT INTO artifacts (job_id, kind, path, sha256, bytes, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, kind, file, crypto.createHash('sha256').update(data).digest('hex'), data.length, json(meta), now.toISOString());
  }

  /** Current artifact per kind: { resume_pdf: { path, sha256, ... } }. */
  getArtifacts(jobId) {
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY id').all(jobId);
    return Object.fromEntries(rows.map((row) => [row.kind, { path: row.path, sha256: row.sha256, bytes: row.bytes, meta: parse(row.meta, {}), createdAt: row.created_at }]));
  }

  /**
   * Records a proposed outbound email. The idempotency key makes a second
   * identical proposal impossible: it throws DUPLICATE_EMAIL instead of
   * inserting.
   */
  addEmail(jobId, email, now = new Date()) {
    try {
      this.db.prepare(`INSERT INTO emails (job_id, kind, to_addr, subject, body, attachments, action_id, status, idempotency_key, detail, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, email.kind ?? 'application', email.to, email.subject, email.body, json(email.attachments ?? []), email.actionId ?? null,
        email.status ?? 'proposed', email.idempotencyKey, json(email.detail ?? {}), now.toISOString(), now.toISOString());
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) { const duplicate = new Error('This email was already proposed'); duplicate.code = 'DUPLICATE_EMAIL'; throw duplicate; }
      throw error;
    }
    return this.listEmails(jobId).at(-1);
  }

  updateEmail(id, { status, actionId, detail }, now = new Date()) {
    const row = this.db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
    if (!row) throw new Error(`Unknown email ${id}`);
    this.db.prepare('UPDATE emails SET status = ?, action_id = ?, detail = ?, updated_at = ? WHERE id = ?')
      .run(status ?? row.status, actionId ?? row.action_id, json({ ...parse(row.detail, {}), ...(detail ?? {}) }), now.toISOString(), id);
  }

  findEmailByKey(key) { return this.listEmails().find((entry) => entry.idempotencyKey === key) ?? null; }

  listEmails(jobId = null) {
    const rows = jobId ? this.db.prepare('SELECT * FROM emails WHERE job_id = ? ORDER BY id').all(jobId) : this.db.prepare('SELECT * FROM emails ORDER BY id').all();
    return rows.map((row) => ({
      id: row.id, jobId: row.job_id, kind: row.kind, to: row.to_addr, subject: row.subject, body: row.body, attachments: parse(row.attachments, []),
      actionId: row.action_id, status: row.status, idempotencyKey: row.idempotency_key, detail: parse(row.detail, {}), createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  /** Records a form application plan. The idempotency key is one per job and application URL. */
  addApplication(jobId, { kind = 'form', url, status, plan, idempotencyKey }, now = new Date()) {
    try {
      this.db.prepare('INSERT INTO applications (job_id, kind, url, status, plan, plan_hash, idempotency_key, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(jobId, kind, url, status, json(plan), plan.planHash, idempotencyKey, '{}', now.toISOString(), now.toISOString());
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) { const duplicate = new Error('This application already exists'); duplicate.code = 'DUPLICATE_APPLICATION'; throw duplicate; }
      throw error;
    }
    return this.listApplications(jobId).at(-1);
  }

  updateApplication(id, { status, plan, result }, now = new Date()) {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
    if (!row) throw new Error(`Unknown application ${id}`);
    const nextPlan = plan ?? parse(row.plan, {});
    this.db.prepare('UPDATE applications SET status = ?, plan = ?, plan_hash = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(status ?? row.status, json(nextPlan), nextPlan.planHash ?? row.plan_hash, json({ ...parse(row.result, {}), ...(result ?? {}) }), now.toISOString(), id);
  }

  findApplicationByKey(key) { return this.listApplications().find((entry) => entry.idempotencyKey === key) ?? null; }

  listApplications(jobId = null) {
    const rows = jobId ? this.db.prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY id').all(jobId) : this.db.prepare('SELECT * FROM applications ORDER BY id').all();
    return rows.map((row) => ({ id: row.id, jobId: row.job_id, kind: row.kind, url: row.url, status: row.status, plan: parse(row.plan, {}), planHash: row.plan_hash, idempotencyKey: row.idempotency_key, result: parse(row.result, {}), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  addReview(jobId, { kind, decision, contentHash, checks, concerns = [], notes = '', model = null }, now = new Date()) {
    if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject');
    this.db.prepare('INSERT INTO reviews (job_id, kind, decision, content_hash, checks, concerns, notes, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, kind, decision, contentHash, json(checks), json(concerns), notes, model, now.toISOString());
    return this.latestReview(jobId, kind);
  }

  latestReview(jobId, kind) {
    const row = this.db.prepare('SELECT * FROM reviews WHERE job_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(jobId, kind);
    return row ? { id: row.id, jobId: row.job_id, kind: row.kind, decision: row.decision, contentHash: row.content_hash, checks: parse(row.checks, []), concerns: parse(row.concerns, []), notes: row.notes, model: row.model, createdAt: row.created_at } : null;
  }

  /** The latest approval for this exact content, or null: any change to what is reviewed invalidates it. */
  validApproval(jobId, kind, contentHash) {
    const review = this.latestReview(jobId, kind);
    return review && review.decision === 'approve' && review.contentHash === contentHash ? review : null;
  }

  // ---- interviews (#536) ----

  addInterview(jobId, { at, endsAt = null, kind = 'video', round = null, locationOrLink = null, notes = null }, now = new Date()) {
    const stamp = now.toISOString();
    const result = this.db.prepare('INSERT INTO interviews (job_id, at, ends_at, kind, round, location_or_link, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, at, endsAt, kind, round, locationOrLink, notes, stamp, stamp);
    return this.getInterview(Number(result.lastInsertRowid));
  }

  getInterview(id) { return rowToInterview(this.db.prepare('SELECT * FROM interviews WHERE id = ?').get(id)); }

  findInterview(jobId, at) { return rowToInterview(this.db.prepare('SELECT * FROM interviews WHERE job_id = ? AND at = ?').get(jobId, at)); }

  updateInterview(id, fields, now = new Date()) {
    const row = this.db.prepare('SELECT * FROM interviews WHERE id = ?').get(id);
    if (!row) return null;
    const next = { ...rowToInterview(row), ...fields };
    this.db.prepare('UPDATE interviews SET at = ?, ends_at = ?, kind = ?, round = ?, location_or_link = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(next.at, next.endsAt, next.kind, next.round, next.locationOrLink, next.notes, now.toISOString(), id);
    return this.getInterview(id);
  }

  deleteInterview(id) { return this.db.prepare('DELETE FROM interviews WHERE id = ?').run(id).changes > 0; }

  /** Interviews that start at or after `from` and before `to` (ISO strings), soonest first. */
  listInterviews({ jobId = null, from = null, to = null } = {}) {
    const rows = this.db.prepare('SELECT * FROM interviews WHERE (? IS NULL OR job_id = ?) AND (? IS NULL OR at >= ?) AND (? IS NULL OR at < ?) ORDER BY at, id').all(jobId, jobId, from, from, to, to);
    return rows.map(rowToInterview);
  }

  // ---- job tasks (#536) ----

  addTask(jobId, { title, dueAt = null, kind = 'task', sourceKey = null }, now = new Date()) {
    const stamp = now.toISOString();
    const result = this.db.prepare('INSERT OR IGNORE INTO job_tasks (job_id, title, due_at, kind, source_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, title, dueAt, kind, sourceKey, stamp, stamp);
    return result.changes ? this.getTask(Number(result.lastInsertRowid)) : this.getTaskByKey(sourceKey);
  }

  getTask(id) { return rowToTask(this.db.prepare('SELECT * FROM job_tasks WHERE id = ?').get(id)); }

  getTaskByKey(key) { return key == null ? null : rowToTask(this.db.prepare('SELECT * FROM job_tasks WHERE source_key = ?').get(key)); }

  /** Sets any of doneAt, snoozedUntil (null clears). Returns the updated task, or null if unknown. */
  updateTask(id, fields, now = new Date()) {
    const row = this.db.prepare('SELECT * FROM job_tasks WHERE id = ?').get(id);
    if (!row) return null;
    const next = { ...rowToTask(row), ...fields };
    this.db.prepare('UPDATE job_tasks SET done_at = ?, snoozed_until = ?, updated_at = ? WHERE id = ?').run(next.doneAt, next.snoozedUntil, now.toISOString(), id);
    return this.getTask(id);
  }

  listTasks({ jobId = null } = {}) {
    return this.db.prepare('SELECT * FROM job_tasks WHERE (? IS NULL OR job_id = ?) ORDER BY id').all(jobId, jobId).map(rowToTask);
  }

  counts() {
    return Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all().map((row) => [row.status, row.n]));
  }
}
