import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact } from '../server/memory/fact-store.js';
import { ContextAssembler } from '../server/agent/context-assembler.js';
import { indexVault } from '../server/vault/indexer.js';
import { getVaultDir, ensureVaultLayout } from '../server/vault/vault-dir.js';
import { loadSkills, MAX_SKILL_CHARS } from '../server/vault/skills.js';
import { loadRoutines } from '../server/routines/routines.js';
import { objectiveFor } from '../server/routines/routine-runner.js';

const EXAMPLE_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'vault');

function fixture(t, { example = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-skills-'));
  process.env.U2OS_HOME = dir;
  t.after(() => { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); });
  const vault = getVaultDir();
  if (example) fs.cpSync(EXAMPLE_VAULT, vault, { recursive: true });
  ensureVaultLayout(vault);
  const write = (relative, text) => fs.writeFileSync(path.join(vault, relative), text);
  return { vault, write };
}

const ROUTINE = (skills) => `---\nwhen:\n  every_minutes: 60\nskills: ${skills}\n---\nDo the thing.\n`;

test('a routine passes the instructions of the skills it names to the planner', (t) => {
  const { write } = fixture(t);
  write('skills/tone.md', '---\ndescription: How I write\n---\nWrite briefly and warmly.\n');
  write('skills/triage.md', 'Urgent means from family or due today.\n');
  write('routines/brief.md', ROUTINE('[triage, tone]'));
  const [routine] = loadRoutines();
  assert.equal(routine.error, null);
  assert.deepEqual(routine.skills.map((skill) => skill.name), ['triage', 'tone']);
  const objective = objectiveFor(routine, 'every', null);
  assert.match(objective, /Do the thing\.\n\nSkill "triage" \(how I want this done\):\nUrgent means from family or due today\.\n\nSkill "tone" \(how I want this done\):\nWrite briefly and warmly\./);
});

test('a routine with a missing, invalid or oversized skill is reported and never runs half-instructed', (t) => {
  const { write } = fixture(t);
  write('skills/empty.md', '---\ndescription: nothing here\n---\n');
  write('skills/big.md', 'x'.repeat(MAX_SKILL_CHARS + 1));
  write('routines/missing.md', ROUTINE('[nowhere]'));
  write('routines/empty.md', ROUTINE('[empty]'));
  write('routines/big.md', ROUTINE('[big]'));
  write('routines/shape.md', ROUTINE('"triage"'));
  write('routines/name.md', ROUTINE('["../secrets"]'));
  const errors = Object.fromEntries(loadRoutines().map((routine) => [routine.path, routine.error]));
  assert.match(errors['routines/missing.md'], /Unknown skill "nowhere"/);
  assert.match(errors['routines/empty.md'], /Skill "empty" is invalid/);
  assert.match(errors['routines/big.md'], /Skill "big" is invalid/);
  assert.match(errors['routines/shape.md'], /skills must be a list/);
  assert.match(errors['routines/name.md'], /skills must be a list/);
});

test('editing a skill file takes effect on the next routine load', (t) => {
  const { write } = fixture(t);
  write('routines/brief.md', ROUTINE('[tone]'));
  assert.match(loadRoutines()[0].error, /Unknown skill/);
  write('skills/tone.md', 'Be brief.\n');
  assert.equal(loadRoutines()[0].skills[0].instructions, 'Be brief.');
  write('skills/tone.md', 'Be brief and kind.\n');
  assert.equal(loadRoutines()[0].skills[0].instructions, 'Be brief and kind.');
});

test('the owner profile always reaches planning context in full, beyond the people limit', (t) => {
  fixture(t);
  const db = getDb();
  const owner = createEntity({ type: 'Person', name: 'Owner' }).id;
  db.prepare("INSERT INTO owners (id, entity_id, passphrase_hash, salt, scrypt_params, created_at) VALUES ('o', ?, 'x', 'x', '{}', ?)").run(owner, new Date().toISOString());
  for (let i = 0; i < 8; i++) recordFact({ entityId: owner, key: `preference_${i}`, value: `value ${i}`, source: 'owner' });
  for (let i = 0; i < 6; i++) createEntity({ type: 'Person', name: `Mentioned ${i}` });
  const objective = Array.from({ length: 6 }, (_, i) => `Mentioned ${i}`).join(', ');
  return new ContextAssembler({ ownerEntityId: owner }).assemblePersonalContext(objective).then((context) => {
    const people = context.relevantPeople;
    assert.equal(people[0].id, owner);
    assert.equal(people[0].matchedOn, 'the owner');
    assert.equal(people[0].facts.length, 8, 'more than the per-person limit of 5');
    assert.equal(people.length, 6, 'the owner does not take a relevant person\'s place');
  });
});

test('the example Job Hunter vault parses, indexes and gives the planner the full profile', async (t) => {
  fixture(t, { example: true });
  const db = getDb();
  const owner = createEntity({ type: 'Person', name: 'Sam Rivera' }).id;
  db.prepare("INSERT INTO owners (id, entity_id, passphrase_hash, salt, scrypt_params, created_at) VALUES ('o', ?, 'x', 'x', '{}', ?)").run(owner, new Date().toISOString());
  assert.deepEqual(indexVault().errors, []);
  assert.equal([...loadSkills().values()].filter((skill) => skill.error).length, 0);
  const [routine] = loadRoutines();
  assert.equal(routine.error, null);
  assert.equal(routine.enabled, false, 'the example ships disabled');
  assert.deepEqual(routine.skills.map((skill) => skill.name), ['job-hunting']);
  const context = await new ContextAssembler({ ownerEntityId: owner }).assemblePersonalContext(objectiveFor(routine, 'daily', null));
  const keys = context.relevantPeople.find((person) => person.id === owner).facts.map((fact) => fact.key);
  for (const key of ['target_roles', 'minimum_salary', 'locations', 'avoid_industries']) assert.ok(keys.includes(key), key);
});
