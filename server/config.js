'use strict';

const path = require('node:path');

// Load a local .env file if present (Node >= 20.12 supports this natively).
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env file */ }

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'paralian.db'),
  corsOrigins: list(process.env.CORS_ORIGIN),
  sessionTtlHours: parseFloat(process.env.SESSION_TTL_HOURS) || 12,
  staticRoot: path.join(__dirname, '..'),

  // ── Staff portal separation ──────────────────────────────────────────────
  // The staff portal never appears on the public website. It is served either:
  //  • on its own port (ADMIN_PORT, default 3001), optionally bound to one interface
  //    (ADMIN_BIND=127.0.0.1 makes it reachable only from the server itself / a VPN or SSH tunnel), or
  //  • on the main port but only for requests to a dedicated hostname (ADMIN_HOST, e.g.
  //    staff.paralian.mv) — use this on hosts that expose a single port.
  adminPort: parseInt(process.env.ADMIN_PORT, 10) || 3001,
  adminBind: process.env.ADMIN_BIND || undefined,
  adminHost: (process.env.ADMIN_HOST || '').trim().toLowerCase() || null,
  // Optional: only these client IPs may reach the staff portal (everyone else gets 404).
  adminAllowedIps: list(process.env.ADMIN_ALLOWED_IPS),
  // Express "trust proxy": set to the number of proxies in front of the app (e.g. 1) when hosted
  // behind a load balancer, so client IPs (for the allow-list and login limits) are read correctly.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};

function list(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return 'loopback';
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? parseInt(value, 10) : value;
}
