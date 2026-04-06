const { Pool } = require('pg');
const entities = require('../../entities');
const { buildSchema } = require('../../entitySchemas');

function qid(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function toPgSql(sql) {
  let idx = 1;
  return sql.replace(/\?/g, () => `$${idx++}`);
}

function mapType(type) {
  switch (type) {
    case 'id': return 'UUID';
    case 'money': return 'NUMERIC(12,2)';
    case 'integer': return 'INT';
    case 'boolean': return 'BOOLEAN';
    case 'date': return 'DATE';
    case 'datetime':
    case 'timestamp': return 'TIMESTAMPTZ';
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

async function createPostgresConnector(config) {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 10
  });

  async function query(sql, params = []) {
    const result = await pool.query(toPgSql(sql), params);
    return result.rows;
  }

  async function transaction(handler) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        query: async (sql, params = []) => {
          const result = await client.query(toPgSql(sql), params);
          return result.rows;
        }
      };
      const result = await handler(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function describeTable(tableName) {
    const rows = await query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              EXISTS (
                SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               WHERE tc.constraint_type = 'PRIMARY KEY'
                 AND tc.table_schema = 'public'
                 AND tc.table_name = c.table_name
                 AND kcu.column_name = c.column_name
              ) AS is_primary
       FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = ?
       ORDER BY c.ordinal_position`,
      [tableName]
    );

    return rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      isPrimary: row.is_primary === true,
      readOnly: row.is_primary === true || row.column_name === 'public_id' || row.column_name === 'created' || row.column_name === 'modified'
    }));
  }

  async function initSchema() {
    await query(`
      CREATE TABLE IF NOT EXISTS ${qid('schema_migrations')} (
        ${qid('id')} SERIAL PRIMARY KEY,
        ${qid('migration_key')} TEXT UNIQUE NOT NULL,
        ${qid('applied_at')} TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS ${qid('system_events')} (
        ${qid('id')} UUID PRIMARY KEY,
        ${qid('event_name')} TEXT NOT NULL,
        ${qid('payload')} TEXT NOT NULL,
        ${qid('created_at')} TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS ${qid('idx_system_events_name')} ON ${qid('system_events')}(${qid('event_name')});
      CREATE INDEX IF NOT EXISTS ${qid('idx_system_events_created')} ON ${qid('system_events')}(${qid('created_at')});
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS ${qid('public_id_counters')} (
        ${qid('entity')} TEXT PRIMARY KEY,
        ${qid('last_value')} INT NOT NULL,
        ${qid('updated_at')} TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    for (const table of entities) {
      await query(buildEntitySql(table));
    }
  }

  async function applyMigration(migrationKey, sql) {
    const existing = await query(`SELECT ${qid('migration_key')} FROM ${qid('schema_migrations')} WHERE ${qid('migration_key')} = ?`, [migrationKey]);
    if (existing.length > 0) return false;

    await transaction(async (tx) => {
      await tx.query(sql);
      await tx.query(`INSERT INTO ${qid('schema_migrations')} (${qid('migration_key')}) VALUES (?)`, [migrationKey]);
    });

    return true;
  }

  async function hasMigration(migrationKey) {
    const existing = await query(
      `SELECT ${qid('migration_key')} FROM ${qid('schema_migrations')} WHERE ${qid('migration_key')} = ? LIMIT 1`,
      [migrationKey]
    );
    return existing.length > 0;
  }

  async function listMigrations() {
    const rows = await query(`SELECT ${qid('migration_key')} FROM ${qid('schema_migrations')} ORDER BY ${qid('migration_key')} ASC`);
    return rows.map((row) => row.migration_key);
  }

  return {
    client: 'postgres',
    escapeId: qid,
    query,
    transaction,
    describeTable,
    initSchema,
    applyMigration,
    hasMigration,
    listMigrations,
    close: () => pool.end()
  };
}

module.exports = createPostgresConnector;
