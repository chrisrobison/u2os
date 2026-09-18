import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyVoiceAuthorization } from '../server/voice/authorize.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-voice-authorize-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function fakeEvaluation(overrides = {}) {
  return {
    autonomyLevel: 4,
    requiresApproval: false,
    blocked: false,
    domain: 'tasks',
    rule: 'tasks.create:autonomous',
    reason: 'tasks.create is configured for delegated autonomy.',
    ...overrides,
  };
}

test('voice undefined: the evaluation is returned completely unchanged (same reference) -- the critical opt-in invariant', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation();
    const result = applyVoiceAuthorization({ evaluation, voice: undefined });
    assert.equal(result, evaluation, 'must be the exact same object reference, not just deep-equal');
  } finally {
    cleanup(dir);
  }
});

test('low confidence forces an autonomous resolution to require approval', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation();
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0.3 } });
    assert.equal(result.requiresApproval, true);
    assert.equal(result.blocked, false);
    assert.notEqual(result, evaluation, 'must return a new object, never mutate the original');
    // Original untouched.
    assert.equal(evaluation.requiresApproval, false);
    assert.match(result.rule, /\+voice:low-confidence$/);
  } finally {
    cleanup(dir);
  }
});

test('confidence at or above the standard threshold does not force approval', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation();
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0.9 } });
    assert.equal(result.requiresApproval, false);
    assert.equal(result, evaluation);
  } finally {
    cleanup(dir);
  }
});

test('low confidence on an already-blocked (`never`) resolution stays blocked -- never "upgraded" to merely requiring confirmation', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation({
      autonomyLevel: 5,
      requiresApproval: true,
      blocked: true,
      domain: 'email',
      rule: 'email.send.legal:never',
      reason: 'email.send is blocked by policy (never).',
    });
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0.1 } });
    assert.equal(result.blocked, true);
    assert.equal(result.requiresApproval, true);
    assert.equal(result, evaluation, 'a hard block is returned untouched, not re-wrapped');
  } finally {
    cleanup(dir);
  }
});

test('high confidence does NOT loosen an already-blocked (`never`) resolution', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation({
      autonomyLevel: 5,
      requiresApproval: true,
      blocked: true,
      domain: 'email',
      rule: 'email.send.legal:never',
      reason: 'email.send is blocked by policy (never).',
    });
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0.99 } });
    assert.equal(result.blocked, true);
    assert.equal(result.requiresApproval, true);
  } finally {
    cleanup(dir);
  }
});

test('high confidence does NOT loosen an existing `confirm` resolution', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation({
      autonomyLevel: 3,
      requiresApproval: true,
      blocked: false,
      domain: 'calendar',
      rule: 'calendar.reschedule.default:confirm',
      reason: 'calendar.reschedule requires explicit confirmation per policy.',
    });
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0.99 } });
    assert.equal(result.requiresApproval, true, 'voice can only ever tighten, never substitute for the existing approval mechanism');
    assert.equal(result, evaluation);
  } finally {
    cleanup(dir);
  }
});

test('autonomy level 0 (read-only / "always") is left alone regardless of confidence -- nothing to gate', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation({
      autonomyLevel: 0,
      requiresApproval: false,
      blocked: false,
      domain: 'calendar',
      rule: 'read:always',
      reason: 'Read-only tools are always allowed in Phase 1.',
    });
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0 } });
    assert.equal(result, evaluation);
  } finally {
    cleanup(dir);
  }
});

test('a domain configured "private" is blocked outright when confidence is below the private threshold, even if the underlying policy was autonomous', () => {
  const dir = tempHome();
  try {
    const configPath = path.join(dir, 'config', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ voiceThresholds: { conversation: 0.7, standard: 0.85, private: 0.95 }, privateDomains: ['finance'] })
    );

    const evaluation = fakeEvaluation({ domain: 'finance', rule: 'finance.transfer:autonomous' });
    // Above the standard threshold but below the private one.
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0.9 } });
    assert.equal(result.blocked, true);
    assert.equal(result.requiresApproval, true);
    assert.match(result.rule, /\+voice:private-domain-low-confidence$/);
  } finally {
    cleanup(dir);
  }
});

test('a private domain with confidence at/above the private threshold is not blocked by this gate', () => {
  const dir = tempHome();
  try {
    const configPath = path.join(dir, 'config', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ voiceThresholds: { conversation: 0.7, standard: 0.85, private: 0.95 }, privateDomains: ['finance'] })
    );

    const evaluation = fakeEvaluation({ domain: 'finance', rule: 'finance.transfer:autonomous' });
    const result = applyVoiceAuthorization({ evaluation, voice: { confidence: 0.97 } });
    assert.equal(result.blocked, false);
    assert.equal(result.requiresApproval, false);
    assert.equal(result, evaluation);
  } finally {
    cleanup(dir);
  }
});

test('missing/non-numeric confidence fails safe to 0 (treated as maximally untrusted)', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation();
    const result = applyVoiceAuthorization({ evaluation, voice: {} });
    assert.equal(result.requiresApproval, true);
  } finally {
    cleanup(dir);
  }
});

test('default voiceThresholds/privateDomains are written into config.json the first time this runs, idempotently', () => {
  const dir = tempHome();
  try {
    const evaluation = fakeEvaluation();
    applyVoiceAuthorization({ evaluation, voice: { confidence: 0.99 } });

    const configPath = path.join(dir, 'config', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.voiceThresholds, { conversation: 0.7, standard: 0.85, private: 0.95 });
    assert.deepEqual(config.privateDomains, []);

    // Calling again must not change the file (idempotent, no clobbering of
    // any hand-edited value that might get added later).
    const before = fs.readFileSync(configPath, 'utf8');
    applyVoiceAuthorization({ evaluation, voice: { confidence: 0.99 } });
    const after = fs.readFileSync(configPath, 'utf8');
    assert.equal(before, after);
  } finally {
    cleanup(dir);
  }
});
