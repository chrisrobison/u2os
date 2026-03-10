const mysql = require('mysql2/promise');
const entities = require('../../entities');
const { buildSchema } = require('../../entitySchemas');

function qid(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function mapType(type) {
  switch (type) {
    case 'id': return 'CHAR(36)';
    case 'money': return 'DECIMAL(12,2)';
    case 'integer': return 'INT';
    case 'boolean': return 'TINYINT(1)';
    case 'date': return 'DATE';
    case 'datetime': return 'DATETIME';
    case 'timestamp': return 'TIMESTAMP';
    case 'json': return 'LONGTEXT';
    case 'phone': return 'VARCHAR(32)';
    case 'email': return 'VARCHAR(255)';
    case 'url': return 'VARCHAR(1024)';
    case 'text': return 'TEXT';
    case 'string':
    default:
      return 'VARCHAR(255)';
  }
}

function buildEntitySql(entity) {
  const schema = buildSchema(entity);
  const columns = schema.columns.map((col) => {
    const parts = [`${qid(col.name)} ${mapType(col.type)}`];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.nullable === false && !col.primary) parts.push('NOT NULL');
    if (col.name === 'created') parts.push('DEFAULT CURRENT_TIMESTAMP');
    if (col.name === 'modified') parts.push('DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    return parts.join(' ');
  });

  const indexCandidates = entity === 'clamps'
    ? schema.columns.map((c) => c.name).filter((name) => name !== 'id')
    : schema.columns
      .map((c) => c.name)
      .filter((name) => ['status', 'email', 'phone', 'cell', 'organization_id', 'customer_id'].includes(name));

  const create = `CREATE TABLE IF NOT EXISTS ${qid(entity)} (${columns.join(', ')}) ENGINE=InnoDB;`;
  const uniqueIndexes = schema.columns
    .filter((c) => c.name === 'public_id')
    .map((c) => `CREATE UNIQUE INDEX ${qid(`udx_${entity}_${c.name}`)} ON ${qid(entity)}(${qid(c.name)});`);
  const indexes = indexCandidates.map((name) =>
    `CREATE INDEX ${qid(`idx_${entity}_${name}`)} ON ${qid(entity)}(${qid(name)});`
  );

  return [create, ...uniqueIndexes, ...indexes];
}

async function createMySqlConnector(config) {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: false
  });

  async function query(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
  }

  async function transaction(handler) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const tx = {
        query: async (sql, params = []) => {
          const [rows] = await connection.query(sql, params);
          return rows;
        }
      };
      const result = await handler(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function describeTable(tableName) {
    const rows = await query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY ORDINAL_POSITION`,
      [tableName]
    );

    return rows.map((row) => ({
      name: row.COLUMN_NAME,
      type: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      isPrimary: row.COLUMN_KEY === 'PRI',
      readOnly: row.COLUMN_KEY === 'PRI' || row.COLUMN_NAME === 'public_id' || row.COLUMN_NAME === 'created' || row.COLUMN_NAME === 'modified' || (row.EXTRA && row.EXTRA.includes('auto_increment'))
    }));
  }

  async function initSchema() {
    await query(`
      CREATE TABLE IF NOT EXISTS ${qid('schema_migrations')} (
        ${qid('id')} INT AUTO_INCREMENT PRIMARY KEY,
        ${qid('migration_key')} VARCHAR(255) UNIQUE NOT NULL,
        ${qid('applied_at')} TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS ${qid('system_events')} (
        ${qid('id')} CHAR(36) PRIMARY KEY,
        ${qid('event_name')} VARCHAR(191) NOT NULL,
        ${qid('payload')} LONGTEXT NOT NULL,
        ${qid('created_at')} TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX ${qid('idx_system_events_name')} (${qid('event_name')}),
        INDEX ${qid('idx_system_events_created')} (${qid('created_at')})
      ) ENGINE=InnoDB;
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS ${qid('public_id_counters')} (
        ${qid('entity')} VARCHAR(64) PRIMARY KEY,
        ${qid('last_value')} INT NOT NULL,
        ${qid('updated_at')} TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    for (const table of entities) {
      const statements = buildEntitySql(table);
      for (const statement of statements) {
        try {
          await query(statement);
        } catch (error) {
          if (!String(error.message).includes('Duplicate key name')) {
            throw error;
          }
        }
      }
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

  return {
    client: 'mysql',
    escapeId: qid,
    query,
    transaction,
    describeTable,
    initSchema,
    applyMigration,
    close: () => pool.end()
  };
}

module.exports = createMySqlConnector;
