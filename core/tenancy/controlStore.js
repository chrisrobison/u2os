const createMySqlConnector = require('../db/connectors/mysql');
const createPostgresConnector = require('../db/connectors/postgres');
const createSqliteConnector = require('../db/connectors/sqlite');
const { uuid } = require('../utils');

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeHost(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) return '';
  if (input.startsWith('[')) {
    const closing = input.indexOf(']');
    return closing > 0 ? input.slice(1, closing) : input;
  }
  return input.split(':')[0];
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+/, '');
}

function isDuplicateConstraintError(error) {
  const message = String(error && error.message ? error.message : '').toLowerCase();
  return error && (
    error.code === '23505'
    || error.code === 'ER_DUP_ENTRY'
    || error.code === 'SQLITE_CONSTRAINT'
    || message.includes('duplicate')
    || message.includes('unique constraint')
    || message.includes('already exists')
  );
}

function toRecord(row) {
  if (!row) return null;
  return {
    ...row,
    is_default: row.is_default === true || row.is_default === 1 || row.is_default === '1'
  };
}

async function createControlConnector(config) {
  const client = String(config && config.client ? config.client : 'sqlite').toLowerCase();
  if (client === 'mysql') return createMySqlConnector(config);
  if (client === 'postgres' || client === 'postgresql') return createPostgresConnector(config);
  if (client === 'sqlite') return createSqliteConnector(config);
  throw new Error(`Unsupported control DB client '${client}'`);
}

async function createControlStore(config) {
  const connector = await createControlConnector(config);
  const qid = typeof connector.escapeId === 'function' ? connector.escapeId : (name) => name;

  async function runSchemaStatements(statements) {
    for (const statement of statements) {
      try {
        await connector.query(statement);
      } catch (error) {
        if (!isDuplicateConstraintError(error)) {
          throw error;
        }
      }
    }
  }

  async function initSchema() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${qid('customers')} (
        ${qid('id')} VARCHAR(64) PRIMARY KEY,
        ${qid('name')} VARCHAR(255) NOT NULL,
        ${qid('status')} VARCHAR(32) NOT NULL,
        ${qid('metadata_json')} TEXT,
        ${qid('created_at')} VARCHAR(40) NOT NULL,
        ${qid('updated_at')} VARCHAR(40) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${qid('instances')} (
        ${qid('id')} VARCHAR(64) PRIMARY KEY,
        ${qid('customer_id')} VARCHAR(64),
        ${qid('name')} VARCHAR(255) NOT NULL,
        ${qid('status')} VARCHAR(32) NOT NULL,
        ${qid('is_default')} INTEGER NOT NULL DEFAULT 0,
        ${qid('db_client')} VARCHAR(32) NOT NULL,
        ${qid('db_config_json')} TEXT NOT NULL,
        ${qid('app_config_json')} TEXT,
        ${qid('created_at')} VARCHAR(40) NOT NULL,
        ${qid('updated_at')} VARCHAR(40) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${qid('instance_domains')} (
        ${qid('id')} VARCHAR(64) PRIMARY KEY,
        ${qid('instance_id')} VARCHAR(64) NOT NULL,
        ${qid('host')} VARCHAR(255) NOT NULL,
        ${qid('domain')} VARCHAR(255) NOT NULL,
        ${qid('status')} VARCHAR(32) NOT NULL,
        ${qid('created_at')} VARCHAR(40) NOT NULL,
        ${qid('updated_at')} VARCHAR(40) NOT NULL
      )`,
      `CREATE INDEX ${qid('idx_customers_status')} ON ${qid('customers')}(${qid('status')})`,
      `CREATE INDEX ${qid('idx_instances_customer_id')} ON ${qid('instances')}(${qid('customer_id')})`,
      `CREATE INDEX ${qid('idx_instances_status')} ON ${qid('instances')}(${qid('status')})`,
      `CREATE INDEX ${qid('idx_instances_is_default')} ON ${qid('instances')}(${qid('is_default')})`,
      `CREATE INDEX ${qid('idx_instance_domains_instance_id')} ON ${qid('instance_domains')}(${qid('instance_id')})`,
      `CREATE INDEX ${qid('idx_instance_domains_host')} ON ${qid('instance_domains')}(${qid('host')})`,
      `CREATE INDEX ${qid('idx_instance_domains_domain')} ON ${qid('instance_domains')}(${qid('domain')})`,
      `CREATE UNIQUE INDEX ${qid('udx_instance_domains_host_domain')} ON ${qid('instance_domains')}(${qid('host')}, ${qid('domain')})`
    ];

    await runSchemaStatements(statements);
  }

  async function listCustomers() {
    const rows = await connector.query(
      `SELECT c.*, COUNT(i.id) AS instance_count
       FROM ${qid('customers')} c
       LEFT JOIN ${qid('instances')} i ON i.customer_id = c.id
       GROUP BY c.id, c.name, c.status, c.metadata_json, c.created_at, c.updated_at
       ORDER BY c.created_at DESC`
    );

    return rows.map((row) => ({
      ...row,
      metadata: parseJson(row.metadata_json, {}),
      instance_count: Number(row.instance_count || 0)
    }));
  }

  async function createCustomer(payload = {}) {
    const now = new Date().toISOString();
    const record = {
      id: payload.id || uuid(),
      name: String(payload.name || '').trim(),
      status: String(payload.status || 'active').trim().toLowerCase(),
      metadata_json: JSON.stringify(payload.metadata || {}),
      created_at: now,
      updated_at: now
    };

    if (!record.name) {
      throw new Error('Customer name is required');
    }

    await connector.query(
      `INSERT INTO ${qid('customers')} (${qid('id')}, ${qid('name')}, ${qid('status')}, ${qid('metadata_json')}, ${qid('created_at')}, ${qid('updated_at')})
       VALUES (?, ?, ?, ?, ?, ?)`,
      [record.id, record.name, record.status, record.metadata_json, record.created_at, record.updated_at]
    );

    return getCustomer(record.id);
  }

  async function getCustomer(id) {
    const rows = await connector.query(`SELECT * FROM ${qid('customers')} WHERE ${qid('id')} = ? LIMIT 1`, [id]);
    if (!rows[0]) return null;
    return {
      ...rows[0],
      metadata: parseJson(rows[0].metadata_json, {})
    };
  }

  async function updateCustomer(id, payload = {}) {
    const current = await getCustomer(id);
    if (!current) return null;

    const now = new Date().toISOString();
    const name = payload.name == null ? current.name : String(payload.name).trim();
    const status = payload.status == null ? current.status : String(payload.status).trim().toLowerCase();
    const metadata = payload.metadata == null ? current.metadata : payload.metadata;

    if (!name) {
      throw new Error('Customer name is required');
    }

    await connector.query(
      `UPDATE ${qid('customers')}
       SET ${qid('name')} = ?,
           ${qid('status')} = ?,
           ${qid('metadata_json')} = ?,
           ${qid('updated_at')} = ?
       WHERE ${qid('id')} = ?`,
      [name, status, JSON.stringify(metadata || {}), now, id]
    );

    return getCustomer(id);
  }

  async function getInstance(id) {
    const rows = await connector.query(`SELECT * FROM ${qid('instances')} WHERE ${qid('id')} = ? LIMIT 1`, [id]);
    if (!rows[0]) return null;
    const row = toRecord(rows[0]);
    return {
      ...row,
      db_config: parseJson(row.db_config_json, {}),
      app_config: parseJson(row.app_config_json, {})
    };
  }

  async function listInstances() {
    const [instances, domains] = await Promise.all([
      connector.query(
        `SELECT i.*, c.name AS customer_name
         FROM ${qid('instances')} i
         LEFT JOIN ${qid('customers')} c ON c.id = i.customer_id
         ORDER BY i.created_at DESC`
      ),
      connector.query(
        `SELECT * FROM ${qid('instance_domains')}
         ORDER BY ${qid('host')} ASC, ${qid('domain')} ASC`
      )
    ]);

    const domainsByInstance = new Map();
    for (const domain of domains) {
      const list = domainsByInstance.get(domain.instance_id) || [];
      list.push(domain);
      domainsByInstance.set(domain.instance_id, list);
    }

    return instances.map((row) => {
      const record = toRecord(row);
      return {
        ...record,
        db_config: parseJson(record.db_config_json, {}),
        app_config: parseJson(record.app_config_json, {}),
        domains: domainsByInstance.get(record.id) || []
      };
    });
  }

  async function clearDefaultFlag(excludeInstanceId = null) {
    if (excludeInstanceId) {
      await connector.query(
        `UPDATE ${qid('instances')} SET ${qid('is_default')} = 0 WHERE ${qid('id')} <> ?`,
        [excludeInstanceId]
      );
      return;
    }

    await connector.query(`UPDATE ${qid('instances')} SET ${qid('is_default')} = 0`);
  }

  async function createInstance(payload = {}) {
    const now = new Date().toISOString();
    const instanceId = payload.id || uuid();
    const name = String(payload.name || '').trim();
    const status = String(payload.status || 'active').trim().toLowerCase();
    const dbClient = String(payload.db_client || '').trim().toLowerCase();
    const dbConfig = payload.db_config || {};
    const appConfig = payload.app_config || {};
    const isDefault = payload.is_default ? 1 : 0;

    if (!name) {
      throw new Error('Instance name is required');
    }
    if (!dbClient) {
      throw new Error('db_client is required');
    }

    if (isDefault) {
      await clearDefaultFlag(instanceId);
    }

    await connector.query(
      `INSERT INTO ${qid('instances')} (
        ${qid('id')},
        ${qid('customer_id')},
        ${qid('name')},
        ${qid('status')},
        ${qid('is_default')},
        ${qid('db_client')},
        ${qid('db_config_json')},
        ${qid('app_config_json')},
        ${qid('created_at')},
        ${qid('updated_at')}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        instanceId,
        payload.customer_id || null,
        name,
        status,
        isDefault,
        dbClient,
        JSON.stringify(dbConfig),
        JSON.stringify(appConfig),
        now,
        now
      ]
    );

    return getInstance(instanceId);
  }

  async function updateInstance(id, payload = {}) {
    const current = await getInstance(id);
    if (!current) return null;

    const now = new Date().toISOString();
    const name = payload.name == null ? current.name : String(payload.name).trim();
    const status = payload.status == null ? current.status : String(payload.status).trim().toLowerCase();
    const dbClient = payload.db_client == null ? current.db_client : String(payload.db_client).trim().toLowerCase();
    const dbConfig = payload.db_config == null ? current.db_config : payload.db_config;
    const appConfig = payload.app_config == null ? current.app_config : payload.app_config;
    const isDefault = payload.is_default == null ? (current.is_default ? 1 : 0) : (payload.is_default ? 1 : 0);

    if (!name) {
      throw new Error('Instance name is required');
    }
    if (!dbClient) {
      throw new Error('db_client is required');
    }

    if (isDefault) {
      await clearDefaultFlag(id);
    }

    await connector.query(
      `UPDATE ${qid('instances')}
       SET ${qid('customer_id')} = ?,
           ${qid('name')} = ?,
           ${qid('status')} = ?,
           ${qid('is_default')} = ?,
           ${qid('db_client')} = ?,
           ${qid('db_config_json')} = ?,
           ${qid('app_config_json')} = ?,
           ${qid('updated_at')} = ?
       WHERE ${qid('id')} = ?`,
      [
        payload.customer_id == null ? current.customer_id : payload.customer_id,
        name,
        status,
        isDefault,
        dbClient,
        JSON.stringify(dbConfig || {}),
        JSON.stringify(appConfig || {}),
        now,
        id
      ]
    );

    return getInstance(id);
  }

  async function listDomains() {
    return connector.query(
      `SELECT d.*, i.name AS instance_name, i.status AS instance_status
       FROM ${qid('instance_domains')} d
       JOIN ${qid('instances')} i ON i.id = d.instance_id
       ORDER BY d.host ASC, d.domain ASC`
    );
  }

  async function getDomain(id) {
    const rows = await connector.query(`SELECT * FROM ${qid('instance_domains')} WHERE ${qid('id')} = ? LIMIT 1`, [id]);
    return rows[0] || null;
  }

  async function createDomain(payload = {}) {
    const now = new Date().toISOString();
    const record = {
      id: payload.id || uuid(),
      instance_id: String(payload.instance_id || '').trim(),
      host: normalizeHost(payload.host),
      domain: normalizeDomain(payload.domain),
      status: String(payload.status || 'active').trim().toLowerCase(),
      created_at: now,
      updated_at: now
    };

    if (!record.instance_id) {
      throw new Error('instance_id is required');
    }
    if (!record.host) {
      throw new Error('host is required');
    }
    if (!record.domain) {
      throw new Error('domain is required');
    }

    await connector.query(
      `INSERT INTO ${qid('instance_domains')} (
        ${qid('id')},
        ${qid('instance_id')},
        ${qid('host')},
        ${qid('domain')},
        ${qid('status')},
        ${qid('created_at')},
        ${qid('updated_at')}
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.instance_id, record.host, record.domain, record.status, record.created_at, record.updated_at]
    );

    return getDomain(record.id);
  }

  async function updateDomain(id, payload = {}) {
    const current = await getDomain(id);
    if (!current) return null;

    const now = new Date().toISOString();
    const host = payload.host == null ? current.host : normalizeHost(payload.host);
    const domain = payload.domain == null ? current.domain : normalizeDomain(payload.domain);
    const status = payload.status == null ? current.status : String(payload.status).trim().toLowerCase();

    if (!host) {
      throw new Error('host is required');
    }
    if (!domain) {
      throw new Error('domain is required');
    }

    await connector.query(
      `UPDATE ${qid('instance_domains')}
       SET ${qid('instance_id')} = ?,
           ${qid('host')} = ?,
           ${qid('domain')} = ?,
           ${qid('status')} = ?,
           ${qid('updated_at')} = ?
       WHERE ${qid('id')} = ?`,
      [
        payload.instance_id == null ? current.instance_id : payload.instance_id,
        host,
        domain,
        status,
        now,
        id
      ]
    );

    return getDomain(id);
  }

  async function getDefaultInstance() {
    const preferred = await connector.query(
      `SELECT * FROM ${qid('instances')}
       WHERE ${qid('is_default')} = 1 AND ${qid('status')} = 'active'
       ORDER BY ${qid('updated_at')} DESC
       LIMIT 1`
    );

    if (preferred[0]) {
      const record = toRecord(preferred[0]);
      return {
        ...record,
        db_config: parseJson(record.db_config_json, {}),
        app_config: parseJson(record.app_config_json, {})
      };
    }

    const fallback = await connector.query(
      `SELECT * FROM ${qid('instances')}
       WHERE ${qid('status')} = 'active'
       ORDER BY ${qid('created_at')} ASC
       LIMIT 1`
    );

    if (!fallback[0]) return null;
    const record = toRecord(fallback[0]);
    return {
      ...record,
      db_config: parseJson(record.db_config_json, {}),
      app_config: parseJson(record.app_config_json, {})
    };
  }

  async function resolveByHostAndDomain(host, domain) {
    const normalizedHost = normalizeHost(host);
    const normalizedDomain = normalizeDomain(domain);

    if (!normalizedHost || !normalizedDomain) {
      return null;
    }

    const rows = await connector.query(
      `SELECT i.*, d.id AS domain_id, d.host, d.domain, d.status AS domain_status
       FROM ${qid('instance_domains')} d
       JOIN ${qid('instances')} i ON i.id = d.instance_id
       WHERE i.status = 'active'
         AND d.status = 'active'
         AND (
           (d.host = ? AND d.domain = ?)
           OR (d.host = ?)
           OR (d.domain = ?)
         )
       ORDER BY
         CASE
           WHEN d.host = ? AND d.domain = ? THEN 1
           WHEN d.host = ? THEN 2
           WHEN d.domain = ? THEN 3
           ELSE 4
         END,
         i.updated_at DESC
       LIMIT 1`,
      [
        normalizedHost,
        normalizedDomain,
        normalizedHost,
        normalizedDomain,
        normalizedHost,
        normalizedDomain,
        normalizedHost,
        normalizedDomain
      ]
    );

    if (!rows[0]) {
      return null;
    }

    const row = toRecord(rows[0]);
    return {
      ...row,
      db_config: parseJson(row.db_config_json, {}),
      app_config: parseJson(row.app_config_json, {})
    };
  }

  async function ensureBootstrapTenant({ host, domain, dbClient, dbConfig }) {
    const normalizedHost = normalizeHost(host);
    const normalizedDomain = normalizeDomain(domain);

    if (!normalizedHost || !normalizedDomain) {
      throw new Error('host and domain are required for bootstrap tenant');
    }

    const existingMapping = await resolveByHostAndDomain(normalizedHost, normalizedDomain);
    if (existingMapping) {
      return existingMapping;
    }

    let defaultInstance = await getDefaultInstance();

    if (!defaultInstance) {
      let customer = null;
      const customers = await listCustomers();
      if (customers.length > 0) {
        customer = customers[0];
      } else {
        customer = await createCustomer({
          name: 'Default Customer',
          status: 'active',
          metadata: { bootstrap: true }
        });
      }

      defaultInstance = await createInstance({
        customer_id: customer ? customer.id : null,
        name: 'Default Instance',
        status: 'active',
        is_default: true,
        db_client: dbClient,
        db_config: dbConfig || {},
        app_config: { bootstrap: true }
      });
    }

    try {
      await createDomain({
        instance_id: defaultInstance.id,
        host: normalizedHost,
        domain: normalizedDomain,
        status: 'active'
      });
    } catch (error) {
      if (!isDuplicateConstraintError(error)) {
        throw error;
      }
    }

    return resolveByHostAndDomain(normalizedHost, normalizedDomain);
  }

  return {
    client: connector.client,
    initSchema,
    close: () => connector.close(),
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    listInstances,
    getInstance,
    createInstance,
    updateInstance,
    listDomains,
    getDomain,
    createDomain,
    updateDomain,
    getDefaultInstance,
    resolveByHostAndDomain,
    ensureBootstrapTenant,
    normalizeHost,
    normalizeDomain
  };
}

module.exports = {
  createControlStore,
  normalizeHost,
  normalizeDomain
};
