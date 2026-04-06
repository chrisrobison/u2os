const PUBLIC_ID_START = 100000;

const PUBLIC_ID_PREFIXES = {
  users: 'USR',
  organizations: 'ORG',
  customers: 'CUS',
  contacts: 'CON',
  products: 'PRD',
  services: 'SVC',
  orders: 'ORD',
  appointments: 'APT',
  transportation_addresses: 'TAD',
  transportation_requests: 'TRQ',
  transportation_trips: 'TRP',
  transportation_waypoints: 'TWP',
  transportation_drivers: 'TDR',
  transportation_buses: 'TBS',
  transportation_invoices: 'TIN',
  transportation_payments: 'TPY',
  transportation_trip_results: 'TRR',
  invoices: 'INV',
  payments: 'PAY',
  documents: 'DOC',
  tasks: 'TSK'
};

const PUBLIC_ID_ENTITIES = Object.keys(PUBLIC_ID_PREFIXES);

function hasPublicId(entity) {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ID_PREFIXES, entity);
}

function getPublicIdPrefix(entity) {
  return PUBLIC_ID_PREFIXES[entity] || null;
}

function formatPublicId(entity, sequence) {
  const prefix = getPublicIdPrefix(entity);
  if (!prefix) {
    throw new Error(`No public ID prefix configured for '${entity}'`);
  }

  const serial = Number(sequence);
  if (!Number.isInteger(serial) || serial <= 0) {
    throw new Error(`Invalid sequence value '${sequence}' for '${entity}'`);
  }

  return `${prefix}-${String(serial).padStart(6, '0')}`;
}

function normalizePublicId(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

function extractPublicIdSequence(entity, publicId) {
  const normalized = normalizePublicId(publicId);
  const prefix = getPublicIdPrefix(entity);
  if (!normalized || !prefix) return null;

  const match = normalized.match(/^([A-Z]{3,5})-(\d+)$/);
  if (!match || match[1] !== prefix) return null;

  const num = Number.parseInt(match[2], 10);
  return Number.isFinite(num) ? num : null;
}

module.exports = {
  PUBLIC_ID_START,
  PUBLIC_ID_ENTITIES,
  hasPublicId,
  getPublicIdPrefix,
  formatPublicId,
  normalizePublicId,
  extractPublicIdSequence
};
