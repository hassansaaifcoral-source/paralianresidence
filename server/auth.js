'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./util');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, kind, subject, ttlHours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token, kind, subject, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, kind, subject, expiresAt);
  return { token, expiresAt };
}

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function lookupSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

/** Express middleware requiring a valid session of the given kind. */
function requireSession(db, kind) {
  return (req, _res, next) => {
    const session = lookupSession(db, tokenFrom(req));
    if (!session || session.kind !== kind) {
      return next(new HttpError(401, 'Authentication required'));
    }
    req.session = session;
    next();
  };
}

/**
 * Fixed-window limiter on *failed* login attempts, keyed by IP.
 * Good enough for a single-process deployment.
 */
function loginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = failures.get(key);
    if (entry && now - entry.start > windowMs) {
      failures.delete(key);
      entry = null;
    }
    if (entry && entry.count >= max) {
      return next(new HttpError(429, 'Too many failed login attempts. Please try again later.'));
    }
    res.on('finish', () => {
      if (res.statusCode !== 401) return;
      const e = failures.get(key);
      if (e) e.count += 1;
      else failures.set(key, { start: Date.now(), count: 1 });
    });
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  tokenFrom,
  lookupSession,
  requireSession,
  loginLimiter,
};
