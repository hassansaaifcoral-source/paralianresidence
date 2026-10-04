'use strict';

const express = require('express');
const path = require('node:path');
const { HttpError } = require('./util');
const { openDb } = require('./db');
const { seed } = require('./seed');

function cors(origins) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (origins.includes('*') || origins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

/**
 * Builds the Express app. Options:
 *   dbPath   – SQLite file (or ':memory:')
 *   db       – an already-open database (overrides dbPath)
 *   seedData – seed demo data into an empty database (default true)
 */
function createApp(config) {
  const db = config.db || openDb(config.dbPath);
  if (config.seedData !== false) seed(db);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  const api = express.Router();
  api.use(cors(config.corsOrigins || []));
  api.use(express.json({ limit: '100kb' }));
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use('/', require('./routes/public')(db, config));
  api.use('/admin', require('./routes/admin')(db));
  api.use('/tenant', require('./routes/tenant')(db));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  api.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Request body is not valid JSON');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Request body is too large');
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({
      error: status === 500 ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  });

  app.use('/api', api);

  // Serve the static website, but never the backend source, database or dependencies.
  if (config.staticRoot) {
    const blocked = /^\/(server|test|data|node_modules|package(-lock)?\.json|\.env|\.git)(\/|$)/i;
    app.use((req, res, next) => (blocked.test(req.path) ? res.status(404).end() : next()));
    app.use(express.static(config.staticRoot, { extensions: ['html'], dotfiles: 'deny' }));
    app.use((_req, res) => res.status(404).sendFile(path.join(config.staticRoot, 'index.html')));
  }

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
