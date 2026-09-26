import path from 'node:path';
import { getVaultDir, ROUTINES_DIR } from '../vault/vault-dir.js';
import { listMarkdownFiles, readVaultFile, fileSignature } from '../vault/markdown.js';

// Standing routines are owner-written vault files (docs/routines.md):
//
//   ---
//   when:
//     daily: "07:00"
//     days: [mon, tue, wed, thu, fri]
//   ---
//   Brief me on today's meetings and anything urgent in my inbox.
//
// This module only parses and validates them. It never executes anything.

export const MIN_EVERY_MINUTES = 15;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_INSTRUCTION_CHARS = 4_000;
// Events a routine may not react to: its own lifecycle (self-recursion) and
// U2OS's internal bookkeeping.
const FORBIDDEN_EVENT_PREFIXES = ['routine.', 'vault.', 'agent.', 'action.', 'run.'];

// Every published event consults the routines, so parsed files are reused
// until a routine file is added, removed or changed (stat signature only).
let cache = { key: null, routines: [] };

export function loadRoutines(vaultDir = getVaultDir()) {
  const files = listMarkdownFiles(vaultDir, ROUTINES_DIR);
  const key = `${vaultDir}|${files.map((file) => `${file}=${fileSignature(vaultDir, file)}`).join('|')}`;
  if (cache.key === key) return cache.routines;
  const routines = files.map((relativePath) => {
    try {
      const { frontmatter, body } = readVaultFile(vaultDir, relativePath);
      return { path: relativePath, ...parseRoutine(relativePath, frontmatter, body), error: null };
    } catch (error) {
      if (error.code !== 'VAULT_INVALID' && error.code !== 'ENOENT') throw error;
      return { path: relativePath, name: defaultName(relativePath), enabled: false, trigger: null, instruction: '', error: error.message };
    }
  });
  cache = { key, routines };
  return routines;
}

export function parseRoutine(relativePath, frontmatter, body) {
  const instruction = body.replace(/^#\s+.+$/m, '').trim();
  if (!instruction) throw invalid('A routine needs an instruction in the body');
  if (instruction.length > MAX_INSTRUCTION_CHARS) throw invalid(`Instructions are limited to ${MAX_INSTRUCTION_CHARS} characters`);
  if (frontmatter.enabled !== undefined && typeof frontmatter.enabled !== 'boolean') throw invalid('enabled must be true or false');
  const name = (typeof frontmatter.name === 'string' && frontmatter.name.trim()) || body.match(/^#\s+(.+)$/m)?.[1]?.trim() || defaultName(relativePath);
  return { name, enabled: frontmatter.enabled !== false, trigger: parseTrigger(frontmatter.when), instruction };
}

export function parseTrigger(when) {
  if (!when || typeof when !== 'object' || Array.isArray(when)) throw invalid('when: must be a mapping with daily, every_minutes or event');
  const kinds = ['daily', 'every_minutes', 'event'].filter((key) => when[key] !== undefined);
  if (kinds.length !== 1) throw invalid('when: must contain exactly one of daily, every_minutes or event');

  if (kinds[0] === 'daily') {
    const match = String(when.daily).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) throw invalid('daily must be a time like "07:30"');
    let days = null;
    if (when.days !== undefined) {
      if (!Array.isArray(when.days) || !when.days.length) throw invalid('days must be a list such as [mon, wed, fri]');
      days = when.days.map((day) => String(day).slice(0, 3).toLowerCase());
      if (days.some((day) => !DAY_NAMES.includes(day))) throw invalid('days must use mon, tue, wed, thu, fri, sat or sun');
    }
    return { kind: 'daily', hour: Number(match[1]), minute: Number(match[2]), days };
  }

  if (kinds[0] === 'every_minutes') {
    const minutes = when.every_minutes;
    if (!Number.isInteger(minutes) || minutes < MIN_EVERY_MINUTES) throw invalid(`every_minutes must be a whole number of at least ${MIN_EVERY_MINUTES}`);
    return { kind: 'every', minutes };
  }

  const eventType = String(when.event).trim();
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(eventType)) throw invalid('event must be an event type such as email.received');
  if (FORBIDDEN_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))) throw invalid(`Routines cannot react to ${eventType.split('.')[0]}.* events`);
  let condition = null;
  if (when.if !== undefined) {
    const { path: fieldPath, equals, contains } = when.if || {};
    if (typeof fieldPath !== 'string' || !/^[\w.]+$/.test(fieldPath)) throw invalid('if.path must be a dotted field path such as data.after.from');
    if ((equals === undefined) === (contains === undefined)) throw invalid('if must contain exactly one of equals or contains');
    condition = { path: fieldPath, ...(equals !== undefined ? { equals: String(equals) } : { contains: String(contains).toLowerCase() }) };
  }
  return { kind: 'event', eventType, condition };
}

/**
 * The slot a scheduled routine should claim at `now`, or null when it is not
 * due. Daily routines fire within `graceMinutes` after their time (local
 * server time) so a restart hours later does not replay the morning brief.
 */
export function dueSlot(trigger, now = new Date(), { graceMinutes = 60 } = {}) {
  if (trigger?.kind === 'every') return `every:${trigger.minutes}:${Math.floor(now.getTime() / (trigger.minutes * 60_000))}`;
  if (trigger?.kind !== 'daily') return null;
  if (trigger.days && !trigger.days.includes(DAY_NAMES[now.getDay()])) return null;
  const scheduled = new Date(now);
  scheduled.setHours(trigger.hour, trigger.minute, 0, 0);
  const late = now.getTime() - scheduled.getTime();
  if (late < 0 || late > graceMinutes * 60_000) return null;
  const date = `${scheduled.getFullYear()}-${String(scheduled.getMonth() + 1).padStart(2, '0')}-${String(scheduled.getDate()).padStart(2, '0')}`;
  return `daily:${date}`;
}

export function eventMatches(trigger, event) {
  if (trigger?.kind !== 'event' || event.type !== trigger.eventType) return false;
  if (!trigger.condition) return true;
  const value = trigger.condition.path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), event);
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
  if (trigger.condition.equals !== undefined) return String(value) === trigger.condition.equals;
  return String(value).toLowerCase().includes(trigger.condition.contains);
}

export function describeTrigger(trigger) {
  if (!trigger) return 'invalid';
  if (trigger.kind === 'daily') return `daily at ${String(trigger.hour).padStart(2, '0')}:${String(trigger.minute).padStart(2, '0')}${trigger.days ? ` on ${trigger.days.join(', ')}` : ''}`;
  if (trigger.kind === 'every') return `every ${trigger.minutes} minutes`;
  return `when ${trigger.eventType} occurs${trigger.condition ? ' and matches its condition' : ''}`;
}

function defaultName(relativePath) {
  return path.posix.basename(relativePath, '.md').replace(/[-_]+/g, ' ');
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'VAULT_INVALID';
  return error;
}
