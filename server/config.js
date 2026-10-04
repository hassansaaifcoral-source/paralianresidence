'use strict';

const path = require('node:path');

// Load a local .env file if present (Node >= 20.12 supports this natively).
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env file */ }

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'paralian.db'),
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  sessionTtlHours: parseFloat(process.env.SESSION_TTL_HOURS) || 12,
  staticRoot: path.join(__dirname, '..'),
};
