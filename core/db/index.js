const createMySqlConnector = require('./connectors/mysql');
const createPostgresConnector = require('./connectors/postgres');
const createSqliteConnector = require('./connectors/sqlite');
const createRepository = require('./repository');

async function createDataSource(config) {
  if (config.client === 'mysql') {
    const connector = await createMySqlConnector(config);
    return createRepository(connector);
  }

  if (config.client === 'postgres' || config.client === 'postgresql') {
    const connector = await createPostgresConnector(config);
    return createRepository(connector);
  }

  if (config.client === 'sqlite') {
    const connector = await createSqliteConnector(config);
    return createRepository(connector);
  }

  throw new Error(`Unsupported DB_CLIENT '${config.client}'. Use 'mysql', 'postgres', or 'sqlite'.`);
}

module.exports = { createDataSource };
