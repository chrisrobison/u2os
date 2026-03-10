const config = require('../core/config');
const { createDataSource } = require('../core/db');
const { PUBLIC_ID_ENTITIES } = require('../core/publicIds');

function quoteId(client, name) {
  if (client === 'mysql') return `\`${String(name).replace(/`/g, '``')}\``;
  return `"${String(name).replace(/"/g, '""')}"`;
}

function publicIdColumnSql(client, entity) {
  const q = (value) => quoteId(client, value);

  if (client === 'postgres') {
    return `ALTER TABLE ${q(entity)} ADD COLUMN ${q('public_id')} TEXT NULL;`;
  }

  if (client === 'mysql') {
    return `ALTER TABLE ${q(entity)} ADD COLUMN ${q('public_id')} VARCHAR(32) NULL;`;
  }

  return `ALTER TABLE ${q(entity)} ADD COLUMN ${q('public_id')} TEXT NULL;`;
}

async function main() {
  const db = await createDataSource(config.db);

  try {
    await db.initSchema();

    for (const entity of PUBLIC_ID_ENTITIES) {
      const columns = await db.describe(entity);
      if (columns.some((col) => col.name === 'public_id')) {
        continue;
      }

      const migrationKey = `core:public-id-column:${entity}:v1`;
      const sql = publicIdColumnSql(db.client, entity);
      const applied = await db.applyMigration(migrationKey, sql);
      console.log(`${applied ? 'Applied' : 'Skipped'} migration ${migrationKey}`);
      await db.refreshSchema(entity);
    }

    // Re-run schema initialization so per-table unique public_id indexes are created.
    await db.initSchema();

    const summary = await db.backfillPublicIds({ targetEntities: PUBLIC_ID_ENTITIES });
    for (const item of summary) {
      if (!item.hasPublicId) {
        console.log(`Skipped ${item.entity}: no public_id column`);
        continue;
      }
      console.log(`Backfilled ${item.entity}: ${item.filled}/${item.total} newly assigned`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error('Public ID migration failed:', error);
  process.exit(1);
});
