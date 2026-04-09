const { EVENTS, EVENT_NAMES } = require('../events/event-registry');

const DEFAULT_DOMAIN_KEYS = Object.freeze([
  'RESERVATION',
  'CUSTOMER',
  'DRIVER',
  'SCHEDULE',
  'NOTIFICATION'
]);

const DOMAIN_ALIASES = Object.freeze({
  RESERVATION: Object.freeze([EVENTS.APPOINTMENT]),
  CUSTOMER: Object.freeze([EVENTS.CUSTOMER]),
  DRIVER: Object.freeze([EVENTS.TRANSPORTATION_DRIVER]),
  SCHEDULE: Object.freeze([EVENTS.APPOINTMENT, EVENTS.TRANSPORTATION.TRIP]),
  NOTIFICATION: Object.freeze([])
});

function collectEventNames(node, bucket = []) {
  for (const value of Object.values(node || {})) {
    if (typeof value === 'string') {
      bucket.push(value);
      continue;
    }
    collectEventNames(value, bucket);
  }
  return bucket;
}

function parseBoolean(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowlist(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values));
}

function resolveDomainEvents(domainKey) {
  const direct = EVENTS[domainKey];
  if (direct) {
    return collectEventNames(direct);
  }
  const aliases = DOMAIN_ALIASES[domainKey] || [];
  return aliases.flatMap((aliasNode) => collectEventNames(aliasNode));
}

function buildDefaultAllowlist() {
  const names = DEFAULT_DOMAIN_KEYS.flatMap((domainKey) => resolveDomainEvents(domainKey));
  return Object.freeze(unique(names));
}

const DEFAULT_FORWARD_ALLOWLIST = buildDefaultAllowlist();
const DEFAULT_RECEIVE_ALLOWLIST = buildDefaultAllowlist();
const EVENT_NAME_LOOKUP = new Set(EVENT_NAMES);

function normalizeAllowlist(values, fallback) {
  const candidates = Array.isArray(values) && values.length > 0 ? values : fallback;
  return unique(candidates.filter((eventName) => EVENT_NAME_LOOKUP.has(eventName)));
}

function createBridgeConfig(env = process.env) {
  const enabled = parseBoolean(env.MINDGRAPH_BRIDGE_ENABLED, true);
  const wsPort = parsePort(env.MINDGRAPH_BRIDGE_PORT, 8788);
  const authSecret = String(env.MINDGRAPH_BRIDGE_SECRET || '').trim();
  const forwardAllowlist = normalizeAllowlist(
    parseAllowlist(env.MINDGRAPH_BRIDGE_FORWARD_ALLOWLIST),
    DEFAULT_FORWARD_ALLOWLIST
  );
  const receiveAllowlist = normalizeAllowlist(
    parseAllowlist(env.MINDGRAPH_BRIDGE_RECEIVE_ALLOWLIST),
    DEFAULT_RECEIVE_ALLOWLIST
  );

  return {
    enabled,
    wsPort,
    authSecret,
    forwardAllowlist,
    receiveAllowlist
  };
}

module.exports = {
  createBridgeConfig,
  DEFAULT_FORWARD_ALLOWLIST,
  DEFAULT_RECEIVE_ALLOWLIST
};
