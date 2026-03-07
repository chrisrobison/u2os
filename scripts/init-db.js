const config = require('../core/config');
const { createDataSource } = require('../core/db');

(async () => {
  const db = await createDataSource(config.db);
  await db.initSchema();
  console.log(`Initialized schema using ${db.client}`);
  await db.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
