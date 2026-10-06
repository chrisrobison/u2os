import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const navSource = fs.readFileSync(path.join(root, 'components', 'u2-nav.js'), 'utf8');
const iconCss = fs.readFileSync(path.join(root, 'styles', 'icons.css'), 'utf8');

// The nav module touches the DOM when imported, so read its route table as text.
const routes = [...navSource.matchAll(/\['(#\/[\w-]+)', '([^']+)'(?:, '([\w-]+)')?\]/g)].map(([, hash, label, icon]) => ({ hash, label, icon }));

test('every route has an icon, and every icon has a codepoint rule', () => {
  assert.equal(routes.length, 23);
  for (const { hash, icon } of routes) {
    assert.ok(icon, `${hash} has no icon`);
    assert.match(iconCss, new RegExp(`\\.u2-icon--${icon}::before \\{ content: "\\\\[0-9a-f]{4}"; \\}`), `${icon} is missing from icons.css`);
  }
});

test('icons are not reused between routes, so each place is recognisable', () => {
  const icons = routes.map((r) => r.icon);
  assert.equal(new Set(icons).size, icons.length);
});

test('the icon stylesheet lists only icons the navigation uses', () => {
  const used = new Set(routes.map((r) => r.icon));
  for (const [, name] of iconCss.matchAll(/\.u2-icon--([\w-]+)::before/g)) assert.ok(used.has(name), `${name} is defined but unused`);
});

test('the font and its licence ship with the app and the stylesheet points at them', () => {
  assert.match(iconCss, /url\("\/vendor\/fontawesome\/fa-solid-900\.woff2"\)/);
  const font = fs.readFileSync(path.join(root, 'vendor', 'fontawesome', 'fa-solid-900.woff2'));
  assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2', 'a real woff2 file');
  assert.match(fs.readFileSync(path.join(root, 'vendor', 'fontawesome', 'LICENSE.txt'), 'utf8'), /Font Awesome Free License/);
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /href="\/styles\/icons\.css"/);
});

test('no stylesheet loads anything from another origin', () => {
  for (const file of ['index.html', path.join('styles', 'icons.css'), path.join('styles', 'base.css'), path.join('styles', 'themes.css')]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /(?:href|src|url\()\s*=?\s*["']?https?:\/\//, `${file} references an external URL`);
  }
});

test('the font is served with a font content type and the policy still allows only this origin', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-nav-icons-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${handle.port}/vendor/fontawesome/fa-solid-900.woff2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/woff2');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /https?:\/\//, 'the policy names no external origin');
  assert.equal((await fetch(`http://127.0.0.1:${handle.port}/vendor/fontawesome/LICENSE.txt`)).headers.get('content-type'), 'text/plain; charset=utf-8');
});
