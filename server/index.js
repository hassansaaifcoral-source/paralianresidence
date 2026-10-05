'use strict';

const http = require('node:http');
const config = require('./config');
const { createApp } = require('./app');
const { openDb } = require('./db');
const { seed } = require('./seed');

// One database shared by both surfaces.
const db = openDb(config.dbPath);
seed(db);

const publicApp = createApp({ ...config, db, seedData: false, surface: 'public' });
const staffApp = createApp({ ...config, db, seedData: false, surface: 'staff' });

const servers = [];

if (config.adminHost) {
  // Single port: route by hostname. Anything not addressed to the staff hostname gets the public site.
  const hostOf = req => String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const server = http.createServer((req, res) => (hostOf(req) === config.adminHost ? staffApp : publicApp)(req, res));
  server.listen(config.port, () => {
    console.log(`Paralian website:     http://localhost:${config.port}`);
    console.log(`Staff portal:         http://${config.adminHost}:${config.port}/admin/ (only via that hostname)`);
  });
  servers.push(server);
} else {
  servers.push(publicApp.listen(config.port, () => {
    console.log(`Paralian website:     http://localhost:${config.port}`);
  }));
  servers.push(staffApp.listen(config.adminPort, config.adminBind, () => {
    console.log(`Staff portal:         http://${config.adminBind || 'localhost'}:${config.adminPort}/admin/`);
  }));
}
if (config.adminAllowedIps.length) console.log(`  Staff portal limited to: ${config.adminAllowedIps.join(', ')}`);
console.log(`  Database: ${config.dbPath}`);

function shutdown() {
  let open = servers.length;
  for (const s of servers) {
    s.close(() => {
      if (--open === 0) {
        db.close();
        process.exit(0);
      }
    });
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
