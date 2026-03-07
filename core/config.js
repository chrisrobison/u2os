require('dotenv').config();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = {
  port: toInt(process.env.PORT, 3000),
  modulesDir: process.env.MODULES_DIR || 'modules',
  db: {
    client: (process.env.DB_CLIENT || 'mysql').toLowerCase(),
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'business_os',
    file: process.env.DB_FILE || ''
  }
};
