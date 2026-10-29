import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { MAX_NOTE_BYTES, noteRelativePath, readNote, revisionOf, writeNote } from '../mcp/jobs/hunt/notes.js';
import { parseMarkdown } from '../server/vault/markdown.js';
import { startServer } from './helpers/authed-server.js';

// #634: the per-job notes file in the vault, as a module and through GET/PUT /api/job-hunt/jobs/:id/notes.

const ID = 'job_0123456789abcdef';
const JOB = { id: ID, company: 'Acme: The "Company"', role: 'Staff Engineer' };
const tmp = (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-notes-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  return vault;
};
const fileOf = (vault, id = ID) => path.join(vault, 'job-hunt', 'notes', `${id}.md`);

test('the path comes only from a valid job id', () => {
  assert.equal(noteRelativePath(ID), `job-hunt/notes/${ID}.md`);
  for (const bad of ['../../etc/passwd', 'job_../../../x', `${ID}/../x`, `${ID}.md`, 'job_0123456789ABCDEF', '', null, undefined, 42, `${ID}\n`, `${ID}\0`, '/etc/passwd']) {
    assert.throws(() => noteRelativePath(bad), { code: 'BAD_INPUT' }, String(bad));
  }
});

test('a note that was never edited has no file, and saving nothing creates none', (t) => {
  const vault = tmp(t);
  const note = readNote(vault, ID);
  assert.deepEqual({ exists: note.exists, body: note.body, revision: note.revision }, { exists: false, body: '', revision: null });
  const saved = writeNote(vault, JOB, '  \n ', null);
  assert.equal(saved.exists, false);
  assert.equal(fs.existsSync(path.join(vault, 'job-hunt')), false, 'not even the folders are created');
});

test('a save writes Markdown with front matter bound to the job, and reads back', (t) => {
  const vault = tmp(t);
  const now = new Date('2026-10-29T12:00:00.000Z');
  const saved = writeNote(vault, JOB, '# Call\n\n- ask about **team size**\n<script>alert(1)</script>\n', null, { now });
  assert.equal(saved.exists, true);
  assert.equal(saved.body, '# Call\n\n- ask about **team size**\n<script>alert(1)</script>', 'stored as text, trimmed');
  assert.equal(saved.updatedAt, now.toISOString());
  const raw = fs.readFileSync(fileOf(vault), 'utf8');
  assert.equal(saved.revision, revisionOf(raw));
  const { frontmatter, body } = parseMarkdown(raw);
  assert.deepEqual(frontmatter, { job: ID, company: JOB.company, role: JOB.role, updated: now.toISOString() });
  assert.match(body, /^# Call/);
  assert.equal(fs.statSync(fileOf(vault)).mode & 0o777, 0o600);
  assert.deepEqual(readNote(vault, ID), saved);
  assert.deepEqual(fs.readdirSync(path.dirname(fileOf(vault))), [`${ID}.md`], 'no temporary file is left behind');
});

test('an unchanged body does not rewrite the file; clearing a saved note keeps the file', (t) => {
  const vault = tmp(t);
  const first = writeNote(vault, JOB, 'one', null, { now: new Date('2026-10-29T12:00:00.000Z') });
  const same = writeNote(vault, JOB, 'one\n', first.revision, { now: new Date('2026-10-30T12:00:00.000Z') });
  assert.equal(same.revision, first.revision);
  assert.equal(same.updatedAt, first.updatedAt);
  const cleared = writeNote(vault, JOB, '', first.revision);
  assert.equal(cleared.exists, true);
  assert.equal(cleared.body, '');
});

test('a stale revision is a conflict that carries the current note; null means "there was no file"', (t) => {
  const vault = tmp(t);
  const first = writeNote(vault, JOB, 'mine', null);
  assert.throws(() => writeNote(vault, JOB, 'again', null), (error) => error.code === 'CONFLICT' && error.note.body === 'mine' && error.note.revision === first.revision);
  const second = writeNote(vault, JOB, 'second', first.revision);
  assert.throws(() => writeNote(vault, JOB, 'third', first.revision), { code: 'CONFLICT' });
  assert.equal(readNote(vault, ID).body, 'second');
  assert.notEqual(second.revision, first.revision);
  assert.throws(() => writeNote(vault, JOB, 'x', 'not-a-hash'), { code: 'BAD_INPUT' });
  assert.throws(() => writeNote(vault, JOB, 'x', undefined), { code: 'BAD_INPUT' });
});

test('an edit made in a text editor converges: new revision, unknown front matter and comments survive our next save', (t) => {
  const vault = tmp(t);
  const first = writeNote(vault, JOB, 'from the app', null);
  const external = `---\njob: ${ID}\ncompany: ${JSON.stringify(JOB.company)}\nrole: Staff Engineer\n# kept comment\ntags: [interesting, remote]\nupdated: "2026-01-01T00:00:00.000Z"\n---\nwritten in an editor\n\nsecond paragraph\n`;
  fs.writeFileSync(fileOf(vault), external);
  const seen = readNote(vault, ID);
  assert.equal(seen.body, 'written in an editor\n\nsecond paragraph');
  assert.notEqual(seen.revision, first.revision);
  assert.throws(() => writeNote(vault, JOB, 'stale save', first.revision), { code: 'CONFLICT' }, 'the app does not overwrite the editor\'s change');
  const saved = writeNote(vault, { ...JOB, role: 'Principal Engineer' }, 'edited again in the app', seen.revision, { now: new Date('2026-10-29T12:00:00.000Z') });
  const raw = fs.readFileSync(fileOf(vault), 'utf8');
  assert.match(raw, /# kept comment/);
  const { frontmatter } = parseMarkdown(raw);
  assert.deepEqual(frontmatter.tags, ['interesting', 'remote']);
  assert.equal(frontmatter.role, 'Principal Engineer');
  assert.equal(frontmatter.job, ID);
  assert.equal(saved.body, 'edited again in the app');
});

test('a note over the size limit is refused and nothing is written', (t) => {
  const vault = tmp(t);
  assert.throws(() => writeNote(vault, JOB, 'a'.repeat(MAX_NOTE_BYTES + 1), null), { code: 'TOO_LARGE' });
  assert.throws(() => writeNote(vault, JOB, 'é'.repeat(MAX_NOTE_BYTES / 2 + 1), null), { code: 'TOO_LARGE' }, 'the limit is in bytes');
  assert.equal(fs.existsSync(path.join(vault, 'job-hunt')), false);
  assert.equal(writeNote(vault, JOB, 'a'.repeat(MAX_NOTE_BYTES), null).exists, true, 'exactly the limit is fine');
  assert.throws(() => writeNote(vault, JOB, 'nul\0byte', readNote(vault, ID).revision), { code: 'BAD_INPUT' });
  assert.throws(() => writeNote(vault, JOB, { not: 'text' }, null), { code: 'BAD_INPUT' });
});

test('links are refused: a symlinked folder or file cannot send a read or write outside the vault', (t) => {
  const vault = tmp(t);
  const outside = tmp(t);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  fs.mkdirSync(path.join(vault, 'job-hunt'));
  fs.symlinkSync(outside, path.join(vault, 'job-hunt', 'notes'));
  assert.throws(() => readNote(vault, ID), { code: 'UNSAFE_PATH' });
  assert.throws(() => writeNote(vault, JOB, 'x', null), { code: 'UNSAFE_PATH' });
  assert.deepEqual(fs.readdirSync(outside), ['secret.md']);
  fs.unlinkSync(path.join(vault, 'job-hunt', 'notes'));
  fs.mkdirSync(path.join(vault, 'job-hunt', 'notes'));
  fs.symlinkSync(path.join(outside, 'secret.md'), fileOf(vault));
  assert.throws(() => readNote(vault, ID), { code: 'UNSAFE_PATH' });
  assert.throws(() => writeNote(vault, JOB, 'x', null), { code: 'UNSAFE_PATH' });
  assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'secret');
});

test('a file with broken front matter is reported, not overwritten', (t) => {
  const vault = tmp(t);
  fs.mkdirSync(path.dirname(fileOf(vault)), { recursive: true });
  fs.writeFileSync(fileOf(vault), '---\njob: [unclosed\n---\nbody\n');
  assert.throws(() => readNote(vault, ID), { code: 'NOTE_INVALID' });
  assert.throws(() => writeNote(vault, JOB, 'x', null), { code: 'NOTE_INVALID' });
  assert.match(fs.readFileSync(fileOf(vault), 'utf8'), /unclosed/);
});

// ---- API ----------------------------------------------------------------------

async function apiFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-notes-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const vault = process.env.U2OS_VAULT;
  fs.mkdirSync(vault, { recursive: true });
  const store = openStore(huntDbPath(vault));
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:9#0', company: 'Pond', role: 'Head of Engineering', rawText: 'Pond | Head of Engineering', applicationUrls: [], contactEmails: [], author: 'a', locations: ['Oakland'], remote: true });
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const put = (id, body) => fetch(`${base}/api/job-hunt/jobs/${id}/notes`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { vault, job, get: (id) => fetch(`${base}/api/job-hunt/jobs/${id}/notes`), put, base };
}

test('API: GET is empty before any edit, PUT saves, a stale PUT is 409 with the current note, an editor change is picked up', async (t) => {
  const { get, put, job, vault } = await apiFixture(t);
  const empty = await (await get(job.id)).json();
  assert.deepEqual({ exists: empty.exists, body: empty.body, revision: empty.revision, maxBytes: empty.maxBytes }, { exists: false, body: '', revision: null, maxBytes: MAX_NOTE_BYTES });

  const nothing = await put(job.id, { body: '', revision: null });
  assert.equal(nothing.status, 200);
  assert.equal(fs.existsSync(path.join(vault, 'job-hunt', 'notes')), false, 'no file for an empty, never-edited note');

  const saved = await (await put(job.id, { body: '## Plan\n\n- [ ] email recruiter', revision: null })).json();
  assert.equal(saved.exists, true);
  assert.equal(saved.path, `job-hunt/notes/${job.id}.md`);
  const { frontmatter } = parseMarkdown(fs.readFileSync(fileOf(vault, job.id), 'utf8'));
  assert.deepEqual([frontmatter.job, frontmatter.company, frontmatter.role], [job.id, 'Pond', 'Head of Engineering']);

  const stale = await put(job.id, { body: 'other tab', revision: null });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.code, 'CONFLICT');
  assert.equal(conflict.note.body, '## Plan\n\n- [ ] email recruiter');
  assert.equal(conflict.note.revision, saved.revision);

  fs.appendFileSync(fileOf(vault, job.id), '\nadded in an editor\n');
  const reread = await (await get(job.id)).json();
  assert.match(reread.body, /added in an editor/);
  assert.equal((await put(job.id, { body: 'overwrite', revision: saved.revision })).status, 409, 'the pre-edit revision no longer matches');
  assert.equal((await put(job.id, { body: 'merged', revision: reread.revision })).status, 200);
});

test('API: bad ids, unknown jobs, missing revision, oversize and path-like ids are refused', async (t) => {
  const { get, put, job, vault } = await apiFixture(t);
  for (const bad of ['nope', 'job_0123456789ABCDEF', 'job_0123456789abcdef0']) {
    assert.equal((await get(bad)).status, 400, bad);
    assert.equal((await put(bad, { body: 'x', revision: null })).status, 400, bad);
  }
  // An encoded slash never reaches the handler as an id (the router does not match it), so it is a 400 or 404, never a file.
  for (const bad of ['..%2F..%2Fetc%2Fpasswd', `${job.id}%2F..%2Fx`]) {
    assert.ok([400, 404].includes((await get(bad)).status), bad);
    assert.ok([400, 404].includes((await put(bad, { body: 'x', revision: null })).status), bad);
  }
  assert.equal(fs.existsSync(path.join(vault, 'job-hunt', 'notes')), false);
  assert.equal((await get('job_0000000000000000')).status, 404);
  assert.equal((await put('job_0000000000000000', { body: 'x', revision: null })).status, 404);
  assert.equal((await put(job.id, { body: 'x' })).status, 400, 'revision is required');
  assert.equal((await put(job.id, { body: 5, revision: null })).status, 400);
  assert.equal((await put(job.id, { body: 'x', revision: 'abc' })).status, 400);
  const big = await put(job.id, { body: 'a'.repeat(MAX_NOTE_BYTES + 1), revision: null });
  assert.equal(big.status, 413);
  assert.equal(fs.existsSync(path.join(vault, 'job-hunt', 'notes')), false);
  fs.mkdirSync(path.dirname(fileOf(vault, job.id)), { recursive: true });
  fs.writeFileSync(fileOf(vault, job.id), '---\n: [\n---\nx');
  assert.equal((await get(job.id)).status, 422);
});

test('API: nothing outside job-hunt/notes is touched by a save', async (t) => {
  const { put, job, vault } = await apiFixture(t);
  await put(job.id, { body: 'x', revision: null });
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(vault, path.join(dir, e.name))]));
  const files = walk(vault).filter((file) => !/^(README\.md|job-hunt\/state\/|journal\/)/.test(file));
  assert.deepEqual(files, [`job-hunt/notes/${job.id}.md`]);
});
