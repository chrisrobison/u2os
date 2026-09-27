// Automation trigger providers (docs/plugin-architecture.md §9). A trigger
// provider validates its config and either computes the next scheduled time
// (`nextRun`) or matches published events (`matches`). New trigger types
// are added by registering another provider; the runtime does not change.
import { nextCronTime, parseCron } from './cron.js';
import { checkExpression, checkTemplate, evaluate, truthy } from './expression.js';
import { isPlainObject } from './json-schema.js';
import { isValidEventType } from './events.js';
import { conditionSource, parseDuration } from './workflow.js';

const MIN_EVERY_MS = 60_000;

export class TriggerRegistry {
  constructor() { this._providers = new Map(); }
  register(provider) {
    if (!provider?.type) throw new Error('Trigger provider needs a type');
    if (this._providers.has(provider.type)) throw new Error(`Trigger provider already registered: ${provider.type}`);
    this._providers.set(provider.type, provider);
    return provider;
  }
  get(type) { return this._providers.get(type) || null; }
  types() { return [...this._providers.keys()]; }

  validate(trigger, where = 'trigger') {
    if (!isPlainObject(trigger)) return [`${where}: must be a mapping`];
    const provider = this.get(trigger.type);
    if (!provider) return [`${where}.type: use one of ${this.types().join(', ')}`];
    const errors = provider.validate(trigger, where);
    if (trigger.with !== undefined) {
      if (!isPlainObject(trigger.with)) errors.push(`${where}.with: must map workflow inputs to values`);
      else checkTemplate(trigger.with, `${where}.with`, errors);
    }
    return errors;
  }
}

const scheduleTrigger = {
  type: 'schedule',
  validate(trigger, where) {
    const errors = unknownKeys(trigger, ['type', 'cron', 'every', 'with'], where);
    if ((trigger.cron === undefined) === (trigger.every === undefined)) errors.push(`${where}: schedule takes exactly one of cron or every`);
    if (trigger.cron !== undefined) {
      try { parseCron(trigger.cron); } catch (error) { errors.push(`${where}.cron: ${error.message}`); }
    }
    if (trigger.every !== undefined) {
      const ms = parseDuration(trigger.every);
      if (ms === null || ms < MIN_EVERY_MS) errors.push(`${where}.every: a duration of at least 1m, such as 1h`);
    }
    return errors;
  },
  nextRun(trigger, from = new Date()) {
    if (trigger.cron) return nextCronTime(trigger.cron, from);
    const ms = parseDuration(trigger.every);
    return new Date((Math.floor(from.getTime() / ms) + 1) * ms);
  },
  describe(trigger) {
    return trigger.cron ? `cron ${trigger.cron}` : `every ${trigger.every}`;
  },
};

const eventTrigger = {
  type: 'event',
  validate(trigger, where) {
    const errors = unknownKeys(trigger, ['type', 'event', 'where', 'with'], where);
    if (!isValidEventType(trigger.event)) errors.push(`${where}.event: an event type such as mail.received`);
    if (trigger.where !== undefined) {
      const problem = typeof trigger.where === 'string' ? checkExpression(conditionSource(trigger.where)) : 'must be an expression';
      if (problem) errors.push(`${where}.where: ${problem}`);
    }
    return errors;
  },
  matches(trigger, event, scope = {}) {
    if (event?.type !== trigger.event) return false;
    if (trigger.where === undefined) return true;
    try { return truthy(evaluate(conditionSource(trigger.where), { ...scope, event })); } catch { return false; }
  },
  describe(trigger) {
    return `when ${trigger.event} occurs${trigger.where ? ' and matches its condition' : ''}`;
  },
};

const manualTrigger = {
  type: 'manual',
  validate(trigger, where) { return unknownKeys(trigger, ['type', 'with'], where); },
  describe() { return 'run on request'; },
};

const watchTrigger = {
  type: 'watch',
  validate(_trigger, where) { return [`${where}: watch triggers are reserved and not available yet`]; },
  describe() { return 'watch (not available)'; },
};

function unknownKeys(object, allowed, where) {
  return Object.keys(object).filter((key) => !allowed.includes(key)).map((key) => `${where}.${key}: unknown key`);
}

export function createTriggerRegistry() {
  const registry = new TriggerRegistry();
  for (const provider of [scheduleTrigger, eventTrigger, manualTrigger, watchTrigger]) registry.register(provider);
  return registry;
}

export const defaultTriggerRegistry = createTriggerRegistry();
