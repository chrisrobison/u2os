import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The browser client has no build step, so a syntax error in any component
// breaks the whole shell (every page imports u2-app.js). Parse every module.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function modules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return modules(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('every browser module parses', () => {
  const files = modules(root);
  assert.ok(files.length > 10);
  for (const file of files) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }), `${path.relative(root, file)} has a syntax error`);
  }
});

// A class may define a method twice without a syntax error, and the later one
// silently wins. That is almost always an editing mistake, so catch it.
test('no browser component defines the same method twice', () => {
  for (const file of modules(root)) {
    const names = [...fs.readFileSync(file, 'utf8').matchAll(/^  (?:static )?(?:async )?(?:get |set )?([A-Za-z_$][\w$]*)\([^)]*\)\s*\{/gm)].map((m) => m[0].replace(/\([^)]*\)\s*\{$/, '').trim());
    const seen = new Set();
    for (const name of names.filter((n) => !/^(if|for|while|switch|catch|function|return)\b/.test(n))) {
      assert.ok(!seen.has(name), `${path.relative(root, file)} defines "${name}" more than once`);
      seen.add(name);
    }
  }
});
