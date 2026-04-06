const fs = require('fs');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const entities = require('../../entities');
const { buildSchema } = require('../../entitySchemas');

function qid(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function mapType(type) {
  switch (type) {
    case 'id': return 'TEXT';
    case 'money': return 'REAL';
    case 'integer': return 'INTEGER';
    case 'boolean': return 'INTEGER';
    case 'date': return 'TEXT';
    case 'datetime':
    case 'timestamp': return 'TEXT';
    case 'json': return 'TEXT';
    case 'phone':
    case 'email':
    case 'url':
    case 'string':
    case 'text':
    default:
      return 'TEXT';
  }
}

function buildEntitySql(entity) {
  const schema = buildSchema(entity);
  const columns = schema.columns.map((col) => {
    const parts = [`${qid(col.name)} ${mapType(col.type)}`];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.nullable === false && !col.primary) parts.push('NOT NULL');
    if (col.defaultNow) parts.push('DEFAULT CURRENT_TIMESTAMP');
    return parts.join(' ');
  });

  const indexCandidates = entity === 'clamps'
    ? schema.columns.map((c) => c.name).filter((name) => name !== 'id')
    : schema.columns
      .map((c) => c.name)
      .filter((name) => [
        'status',
        'email',
        'phone',
        'cell',
        'organization_id',
        'customer_id',
        'staff_user_id',
        'invoice_id',
        'public_id',
        'start_at',
        'end_at',
        'trip_date',
        'request_id',
        'trip_id',
        'driver_id',
        'bus_id',
        'pickup_address_id',
        'dropoff_address_id',
        'address_id',
        'transportation_invoice_id',
        'planned_departure_at',
        'planned_arrival_at',
        'actual_departure_at',
        'actual_arrival_at',
        'waypoint_order',
        'paid_at',
        'issue_date',
        'due_date',
        'ordered_at'
      ].includes(name));

  const create = `CREATE TABLE IF NOT EXISTS ${qid(entity)} (${columns.join(', ')});`;
  const uniqueIndexes = schema.columns
    .filter((c) => c.name === 'public_id')
    .map((c) => `CREATE UNIQUE INDEX IF NOT EXISTS ${qid(`udx_${entity}_${c.name}`)} ON ${qid(entity)}(${qid(c.name)});`);
  const indexes = indexCandidates.map((name) =>
    `CREATE INDEX IF NOT EXISTS ${qid(`idx_${entity}_${name}`)} ON ${qid(entity)}(${qid(name)});`
  );

  return [create, ...uniqueIndexes, ...indexes].join('\n');
}

async function createSqliteConnector(config) {
  const dbFile = config.file || path.join(process.cwd(), 'data', 'u2os.sqlite');
  const dbDir = path.dirname(dbFile);
  fs.mkdirSync(dbDir, { recursive: true });

  const db = await open({ filename: dbFile, driver: sqlite3.Database });

  async function runQuery(client, sql, params = []) {
    const statement = sql.trim().toUpperCase();
    if (statement.startsWith('SELECT') || statement.startsWith('PRAGMA')) {
      return client.all(sql, params);
    }

    await client.run(sql, params);
    return [];
  }

  async function query(sql, params = []) {
    return runQuery(db, sql, params);
  }

  async function transaction(handler) {
    await db.exec('BEGIN');
    try {
      const tx = { query: async (sql, params = []) => runQuery(db, sql, params) };
      const result = await handler(tx);
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }

  async function describeTable(tableName) {
    const rows = await db.all(`PRAGMA table_info(${qid(tableName)})`);
    return rows.map((row) => ({
      name: row.name,
      type: row.type || 'TEXT',
      nullable: row.notnull === 0,
      defaultValue: row.dflt_value,
      isPrimary: row.pk === 1,
      readOnly: row.pk === 1 || row.name === 'public_id' || row.name === 'created' || row.name === 'modified'
    }));
  }

  async function initSchema() {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${qid('schema_migrations')} (
        ${qid('id')} INTEGER PRIMARY KEY AUTOINCREMENT,
        ${qid('migration_key')} TEXT UNIQUE NOT NULL,
        ${qid('applied_at')} TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ${qid('system_events')} (
        ${qid('id')} TEXT PRIMARY KEY,
        ${qid('event_name')} TEXT NOT NULL,
        ${qid('payload')} TEXT NOT NULL,
        ${qid('created_at')} TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ${qid('public_id_counters')} (
        ${qid('entity')} TEXT PRIMARY KEY,
        ${qid('last_value')} INTEGER NOT NULL,
        ${qid('updated_at')} TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS ${qid('idx_system_events_name')} ON ${qid('system_events')}(${qid('event_name')});
      CREATE INDEX IF NOT EXISTS ${qid('idx_system_events_created')} ON ${qid('system_events')}(${qid('created_at')});
    `);

    for (const table of entities) {
      await db.exec(buildEntitySql(table));
    }
  }

  async function applyMigration(migrationKey, sql) {
    const existing = await db.all(`SELECT ${qid('migration_key')} FROM ${qid('schema_migrations')} WHERE ${qid('migration_key')} = ?`, [migrationKey]);
    if (existing.length > 0) return false;

    await db.exec('BEGIN');
    try {
      await db.exec(sql);
      await db.run(`INSERT INTO ${qid('schema_migrations')} (${qid('migration_key')}) VALUES (?)`, [migrationKey]);
      await db.exec('COMMIT');
      return true;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }

  async function hasMigration(migrationKey) {
    const existing = await db.all(
      `SELECT ${qid('migration_key')} FROM ${qid('schema_migrations')} WHERE ${qid('migration_key')} = ? LIMIT 1`,
      [migrationKey]
    );
    return existing.length > 0;
  }

  async function listMigrations() {
    const rows = await db.all(`SELECT ${qid('migration_key')} FROM ${qid('schema_migrations')} ORDER BY ${qid('migration_key')} ASC`);
    return rows.map((row) => row.migration_key);
  }

  return {
    client: 'sqlite',
    escapeId: qid,
    query,
    transaction,
    describeTable,
    initSchema,
    applyMigration,
    hasMigration,
    listMigrations,
    close: () => db.close()
  };
}

module.exports = createSqliteConnector;
