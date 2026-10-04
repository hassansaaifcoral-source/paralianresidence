'use strict';

const config = require('./config');
const { createApp } = require('./app');

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`Paralian server running at http://localhost:${config.port}`);
  console.log(`  Database: ${config.dbPath}`);
});

function shutdown() {
  server.close(() => {
    app.locals.db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
