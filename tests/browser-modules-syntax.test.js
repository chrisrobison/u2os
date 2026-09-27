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
