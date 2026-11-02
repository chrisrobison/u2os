import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { getVaultDir, ensureVaultLayout } from '../server/vault/vault-dir.js';
import { parseTrigger, dueSlot } from '../server/routines/routines.js';
import { runScheduledRoutines, runEventRoutines, runRoutineNow, MAX_RUNS_PER_HOUR } from '../server/routines/routine-runner.js';

// Shared fixture for the Rust scheduler (majordomo/, ADR 0011, Phase 4b). This
// test drives Node's real parseTrigger, dueSlot and routine runner (claims in
// routine_runs) with the same file the Rust test
// (majordomo/tests/scheduler_parity.rs) reads. Fixture 'ran' is Node
// 'completed'. Known differences are listed under `differences`.

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '..', 'majordomo', 'tests', 'fixtures', 'scheduler-parity.json'), 'utf8'));
const ORIGINAL_TZ = process.env.TZ;

test.after(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

test('fixture documents its differences', () => {
  assert.ok(FIXTURE.differences.length >= 4);
  for (const d of FIXTURE.differences) assert.ok(d.area && d.node && d.rust);
});

test('dueSlot: fixture cases (Node column)', () => {
  assert.ok(FIXTURE.due_slot.length > 20);
  for (const c of FIXTURE.due_slot) {
    process.env.TZ = c.tz;
    const got = dueSlot(parseTrigger(c.when), new Date(c.now));
    assert.equal(got, c.expected, c.name);
  }
});

test('parseTrigger: valid and invalid shapes', () => {
  for (const c of FIXTURE.valid_when) assert.doesNotThrow(() => parseTrigger(c.when), c.name);
  for (const c of FIXTURE.invalid_when) {
    assert.throws(() => parseTrigger(c.when), (e) => e.code === 'VAULT_INVALID', c.name);
  }
});

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-parity-sched-'));
  process.env.U2OS_HOME = dir;
  const db = getDb();
  db.prepare("INSERT INTO owners (id, entity_id, passphrase_hash, salt, scrypt_params, created_at) VALUES ('owner_1', NULL, 'x', 'x', '{}', ?)").run(new Date().toISOString());
  const vault = ensureVaultLayout(getVaultDir());
  return { dir, db, vault, eventBus: new EventBus(db) };
}

const agent = {
  async handleMessage() { return { runId: 'run_x', pendingActionIds: [] }; },
};

function describeResults(db, results) {
  return results.map((r) => {
    const row = db.prepare('SELECT routine_path, slot, status FROM routine_runs WHERE id = ?').get(r.id);
    return { routine: path.posix.basename(row.routine_path), slot: row.slot, status: r.status === 'completed' ? 'ran' : r.status };
  });
}

function matchSlot(expected, actual) {
  return expected.endsWith('*') ? actual.startsWith(expected.slice(0, -1)) : expected === actual;
}

function assertSame(label, actual, expected) {
  assert.equal(actual.length, expected.length, `${label}: ${JSON.stringify(actual)}`);
  const remaining = [...actual];
  for (const e of expected) {
    const i = remaining.findIndex((a) => a.routine === e.routine && a.status === e.status && matchSlot(e.slot, a.slot));
    assert.ok(i >= 0, `${label}: missing ${JSON.stringify(e)} in ${JSON.stringify(actual)}`);
    remaining.splice(i, 1);
  }
}

for (const scenario of FIXTURE.scenarios) {
  test(`scenario: ${scenario.name} (Node column)`, async () => {
    process.env.TZ = scenario.tz;
    const { dir, db, vault, eventBus } = home();
    try {
      for (const r of scenario.routines) {
        fs.writeFileSync(path.join(vault, 'routines', r.path), `---\nwhen: ${JSON.stringify(r.when)}\n---\nDo the thing.\n`);
      }
      for (const [n, step] of scenario.steps.entries()) {
        const label = `${scenario.name} step ${n} (${step.op})`;
        if (step.op === 'tick') {
          assertSame(label, describeResults(db, await runScheduledRoutines({ eventBus, agent, now: new Date(step.now) })), step.expect);
        } else if (step.op === 'event') {
          assertSame(label, describeResults(db, await runEventRoutines({ eventBus, agent, event: step.event })), step.expect);
        } else if (step.op === 'events') {
          let ran = 0; let throttled = 0;
          for (let i = step.from; i < step.from + step.count; i += 1) {
            const results = describeResults(db, await runEventRoutines({ eventBus, agent, event: { id: `${step.prefix}${i}`, type: step.type, data: {} } }));
            for (const r of results) { if (r.status === 'ran') ran += 1; else if (r.status === 'throttled') throttled += 1; }
          }
          assert.equal(ran, step.expect_ran, label);
          assert.equal(throttled, step.expect_throttled, label);
          assert.equal(step.expect_ran, MAX_RUNS_PER_HOUR);
        } else if (step.op === 'manual') {
          const result = await runRoutineNow({ eventBus, agent, routinePath: `routines/${step.routine}` });
          assertSame(label, describeResults(db, [result]), step.expect);
        } else if (step.op === 'age_runs') {
          for (const r of db.prepare('SELECT id, created_at FROM routine_runs').all()) {
            db.prepare('UPDATE routine_runs SET created_at = ? WHERE id = ?').run(new Date(Date.parse(r.created_at) - step.ms).toISOString(), r.id);
          }
        } else {
          assert.fail(`unknown op ${step.op}`);
        }
      }
    } finally {
      closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
