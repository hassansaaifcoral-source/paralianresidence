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

/** Which parts of the system each server surface exposes. */
const SURFACES = {
  // Everything on one server — used by the tests and handy for local development.
  all: { site: true, staff: true, tenant: true },
  // The public website and the tenant portal. The staff portal does not exist here.
  public: { site: true, staff: false, tenant: true },
  // The staff portal only.
  staff: { site: false, staff: true, tenant: false },
};

/**
 * First path segment as the static file server will resolve it — decoded and normalised, so
 * tricks like "/%61dmin/", "//admin/" or "/x/../admin/" are caught. Lower-cased because the
 * host filesystem may be case-insensitive.
 */
function topLevelSegment(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return '\0'; }
  return path.posix.normalize('/' + p.replace(/\\/g, '/')).split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
}

const normaliseIp = ip => String(ip || '').replace(/^::ffff:/, '');

/** Hides the surface from any IP not on the allow-list (when one is configured). */
function ipAllowList(allowed) {
  const set = new Set(allowed.map(normaliseIp));
  return (req, res, next) => {
    if (!set.size || set.has(normaliseIp(req.ip))) return next();
    res.status(404).type('text').send('Not found');
  };
}

/**
 * Builds an Express app for one surface. Options:
 *   surface        – 'public' | 'staff' | 'all' (default 'all')
 *   dbPath         – SQLite file (or ':memory:')
 *   db             – an already-open database (overrides dbPath), so surfaces can share one
 *   seedData       – seed demo data into an empty database (default true)
 *   adminAllowedIps – staff surface only: IPs allowed to reach it (empty = any)
 *   trustProxy     – Express "trust proxy" setting (default 'loopback')
 */
function createApp(config) {
  const surfaceName = config.surface || 'all';
  const surface = SURFACES[surfaceName];
  if (!surface) throw new Error(`Unknown surface "${surfaceName}"`);

  const db = config.db || openDb(config.dbPath);
  if (config.seedData !== false) seed(db);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 'loopback');

  if (surface.staff && !surface.site) app.use(ipAllowList(config.adminAllowedIps || []));

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  if (surface.staff) {
    // Keep the staff portal out of search engines and out of other sites' frames.
    app.use((_req, res, next) => {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.set('X-Frame-Options', 'DENY');
      next();
    });
  }

  const api = express.Router();
  api.use(cors(config.corsOrigins || []));
  api.use(express.json({ limit: '100kb' }));
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use('/', require('./routes/public')(db, config, surface));
  if (surface.staff) api.use('/admin', require('./routes/admin')(db));
  if (surface.tenant) api.use('/tenant', require('./routes/tenant')(db));
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

  if (config.staticRoot) {
    const root = config.staticRoot;
    const staticOpts = { extensions: ['html'], dotfiles: 'deny' };
    const notFound = (_req, res) => res.status(404).type('text').send('Not found');

    if (surface.site) {
      // Public website: never the backend source, database or dependencies — and, unless this
      // server is also the staff surface, not the staff portal either.
      const blocked = new Set(['server', 'test', 'data', 'node_modules', 'package.json', 'package-lock.json', '.env', '.git']);
      if (!surface.staff) blocked.add('admin');
      app.use((req, res, next) => (blocked.has(topLevelSegment(req.path)) ? notFound(req, res) : next()));
      app.use(express.static(root, staticOpts));
      app.use((_req, res) => res.status(404).sendFile(path.join(root, 'index.html')));
    } else {
      // Staff surface: only the staff portal and the shared assets it needs.
      app.get('/', (_req, res) => res.redirect('/admin/'));
      app.use('/admin', express.static(path.join(root, 'admin'), staticOpts));
      app.use('/assets', express.static(path.join(root, 'assets'), staticOpts));
      app.use(notFound);
    }
  }

  app.locals.db = db;
  return app;
}

module.exports = { createApp, SURFACES };
