const entities = require('../entities');
const { uuid } = require('../utils');

const entitySet = new Set(entities);

function parseJsonSafe(value) {
  if (value == null || typeof value === 'object') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function assertEntity(entity) {
  if (!entitySet.has(entity)) {
    throw new Error(`Unknown entity '${entity}'`);
  }
}

function createRepository(connector) {
  const qid = typeof connector.escapeId === 'function' ? connector.escapeId : (name) => name;
  const schemaCache = new Map();

  async function getColumns(entity) {
    assertEntity(entity);
    if (!schemaCache.has(entity)) {
      const columns = typeof connector.describeTable === 'function'
        ? await connector.describeTable(entity)
        : [];
      schemaCache.set(entity, columns);
    }
    return schemaCache.get(entity);
  }

  function toModel(row) {
    const model = {};
    for (const [key, value] of Object.entries(row || {})) {
      model[key] = parseJsonSafe(value);
    }
    return model;
  }

  function normalizeValue(value) {
    if (value == null) return null;
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  function writableColumns(columns, { includeId = true } = {}) {
    return columns.filter((col) => {
      if (col.readOnly) return false;
      if (!includeId && col.name === 'id') return false;
      if (col.name === 'created' || col.name === 'modified') return false;
      return true;
    });
  }

  async function create(entity, payload) {
    const columns = await getColumns(entity);
    const writable = writableColumns(columns, { includeId: true });
    const valuesByCol = {};

    for (const col of writable) {
      if (Object.prototype.hasOwnProperty.call(payload, col.name)) {
        valuesByCol[col.name] = normalizeValue(payload[col.name]);
      }
    }

    if (columns.some((c) => c.name === 'id') && !valuesByCol.id) {
      valuesByCol.id = payload.id || uuid();
    }

    const colNames = Object.keys(valuesByCol);
    if (colNames.length === 0) {
      throw new Error(`No writable fields provided for ${entity}`);
    }

    const sql = `INSERT INTO ${qid(entity)} (${colNames.map(qid).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`;
    await connector.query(sql, colNames.map((name) => valuesByCol[name]));

    if (valuesByCol.id) {
      return getById(entity, valuesByCol.id);
    }

    const rows = await list(entity, { limit: 1, offset: 0 });
    return rows[0] || null;
  }

  async function getById(entity, id) {
    const columns = await getColumns(entity);
    if (!columns.some((c) => c.name === 'id')) {
      return null;
    }

    const rows = await connector.query(`SELECT * FROM ${qid(entity)} WHERE ${qid('id')} = ? LIMIT 1`, [id]);
    return rows[0] ? toModel(rows[0]) : null;
  }

  async function count(entity) {
    await getColumns(entity);
    const rows = await connector.query(`SELECT COUNT(*) AS total FROM ${qid(entity)}`);
    const totalRaw = rows[0] && (rows[0].total ?? rows[0]['COUNT(*)'] ?? rows[0].count);
    return Number(totalRaw || 0);
  }

  async function list(entity, options = {}) {
    const columns = await getColumns(entity);
    const { q, limit = 25, offset = 0 } = options;

    const sortColumn = columns.some((c) => c.name === 'modified')
      ? 'modified'
      : (columns.some((c) => c.name === 'created') ? 'created' : (columns[0] && columns[0].name) || 'id');

    if (!q) {
      const rows = await connector.query(
        `SELECT * FROM ${qid(entity)} ORDER BY ${qid(sortColumn)} DESC LIMIT ? OFFSET ?`,
        [Math.min(limit, 200), offset]
      );
      return rows.map(toModel);
    }

    const searchable = columns
      .filter((c) => {
        const t = String(c.type || '').toLowerCase();
        return ['char', 'text', 'varchar', 'uuid', 'date', 'time'].some((hint) => t.includes(hint)) || c.name === 'id';
      })
      .map((c) => c.name);

    if (searchable.length === 0) {
      const rows = await connector.query(
        `SELECT * FROM ${qid(entity)} ORDER BY ${qid(sortColumn)} DESC LIMIT ? OFFSET ?`,
        [Math.min(limit, 200), offset]
      );
      return rows.map(toModel);
    }

    const search = `%${q}%`;
    const where = searchable.map((name) => `${qid(name)} LIKE ?`).join(' OR ');
    const params = [...searchable.map(() => search), Math.min(limit, 200), offset];

    const rows = await connector.query(
      `SELECT * FROM ${qid(entity)} WHERE ${where} ORDER BY ${qid(sortColumn)} DESC LIMIT ? OFFSET ?`,
      params
    );
    return rows.map(toModel);
  }

  async function update(entity, id, payload) {
    const columns = await getColumns(entity);
    const current = await getById(entity, id);
    if (!current) return null;

    const writable = writableColumns(columns, { includeId: false });
    const sets = [];
    const params = [];

    for (const col of writable) {
      if (Object.prototype.hasOwnProperty.call(payload, col.name)) {
        sets.push(`${qid(col.name)} = ?`);
        params.push(normalizeValue(payload[col.name]));
      }
    }

    if (columns.some((c) => c.name === 'modified')) {
      sets.push(`${qid('modified')} = CURRENT_TIMESTAMP`);
    }

    if (sets.length === 0) {
      return current;
    }

    await connector.query(
      `UPDATE ${qid(entity)} SET ${sets.join(', ')} WHERE ${qid('id')} = ?`,
      [...params, id]
    );

    return getById(entity, id);
  }

  async function remove(entity, id) {
    const existing = await getById(entity, id);
    if (!existing) return false;
    await connector.query(`DELETE FROM ${qid(entity)} WHERE ${qid('id')} = ?`, [id]);
    return true;
  }

  async function describe(entity) {
    return getColumns(entity);
  }

  async function appendEvent(eventName, payload) {
    const id = uuid();
    await connector.query(
      `INSERT INTO ${qid('system_events')} (${qid('id')}, ${qid('event_name')}, ${qid('payload')}) VALUES (?, ?, ?)`,
      [id, eventName, JSON.stringify(payload || {})]
    );
    return { id, event_name: eventName, payload, created_at: new Date().toISOString() };
  }

  async function listEvents(limit = 100) {
    const rows = await connector.query(
      `SELECT * FROM ${qid('system_events')} ORDER BY ${qid('created_at')} DESC LIMIT ?`,
      [Math.min(limit, 500)]
    );
    return rows.map((row) => ({ ...row, payload: parseJsonSafe(row.payload) }));
  }

  return {
    client: connector.client,
    initSchema: connector.initSchema,
    applyMigration: connector.applyMigration,
    close: connector.close,
    create,
    getById,
    list,
    count,
    update,
    remove,
    describe,
    appendEvent,
    listEvents
  };
}

module.exports = createRepository;
