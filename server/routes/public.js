'use strict';

const express = require('express');
const { HttpError, validate, route } = require('../util');
const { availability, checkDates, normaliseType } = require('../bookings');
const { verifyPassword, createSession, tokenFrom, lookupSession, loginLimiter } = require('../auth');

/**
 * Routes outside /admin and /tenant. `surface` selects which groups are mounted:
 *   site   – website forms and availability
 *   staff  – staff login
 *   tenant – tenant login
 */
module.exports = function publicRoutes(db, config, surface = { site: true, staff: true, tenant: true }) {
  const r = express.Router();
  const limiter = loginLimiter();

  r.get('/health', (_req, res) => res.json({ ok: true }));

  if (surface.site) {
    r.get('/room-types', route((_req, res) => {
      res.json(db.prepare('SELECT * FROM room_types ORDER BY price_usd DESC').all());
    }));

    function typeOrThrow(raw) {
      const code = normaliseType(raw);
      if (code && !db.prepare('SELECT 1 FROM room_types WHERE code = ?').get(code)) {
        throw new HttpError(400, 'Unknown room type', { room: 'is not a room type we offer' });
      }
      return code;
    }

    r.get('/availability', route((req, res) => {
      const q = validate(req.query, {
        checkin: { type: 'date', required: true },
        checkout: { type: 'date', required: true },
        guests: { type: 'int', min: 1, max: 8, default: 1 },
        room: { type: 'string', max: 40 },
      });
      checkDates(q.checkin, q.checkout);
      res.json({ results: availability(db, q.checkin, q.checkout, q.guests, typeOrThrow(q.room)) });
    }));

    // Quick-enquiry bar on the hotel home page.
    r.post('/enquiries', route((req, res) => {
      const body = validate(req.body, {
        checkin: { type: 'date', required: true },
        checkout: { type: 'date', required: true },
        guests: { type: 'int', min: 1, max: 8, default: 1 },
        room: { type: 'string', max: 40 },
        name: { type: 'string', required: true, max: 120 },
        email: { type: 'email', required: true },
        phone: { type: 'string', max: 40 },
      });
      checkDates(body.checkin, body.checkout);
      const typeCode = typeOrThrow(body.room);
      const info = db.prepare(`
        INSERT INTO enquiries (check_in, check_out, type_code, guests, name, email, phone, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(body.checkin, body.checkout, typeCode, body.guests, body.name, body.email, body.phone ?? null,
          new Date().toISOString());
      res.status(201).json({
        id: Number(info.lastInsertRowid),
        availability: availability(db, body.checkin, body.checkout, body.guests, typeCode),
      });
    }));

    r.post('/contact', route((req, res) => {
      const body = validate(req.body, {
        first_name: { type: 'string', required: true, max: 80 },
        last_name: { type: 'string', required: true, max: 80 },
        email: { type: 'email', required: true },
        subject: { type: 'string', max: 80 },
        message: { type: 'string', required: true, max: 5000 },
      });
      const info = db.prepare(`
        INSERT INTO contact_messages (first_name, last_name, email, subject, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(body.first_name, body.last_name, body.email, body.subject ?? null, body.message,
          new Date().toISOString());
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    }));
  }

  /* ── Auth ─────────────────────────────────────────── */

  if (surface.staff) {
    r.post('/auth/staff/login', limiter, route((req, res) => {
      const body = validate(req.body, {
        username: { type: 'string', required: true, max: 60 },
        password: { type: 'string', required: true, max: 200 },
      });
      const user = db.prepare('SELECT * FROM staff_users WHERE username = ?').get(body.username.toLowerCase());
      if (!user || !verifyPassword(body.password, user.password_hash)) {
        throw new HttpError(401, 'Invalid username or password');
      }
      const session = createSession(db, 'staff', user.username, config.sessionTtlHours);
      res.json({ ...session, user: { username: user.username, display_name: user.display_name, role: user.role } });
    }));
  }

  if (surface.tenant) {
    r.post('/auth/tenant/login', limiter, route((req, res) => {
      const body = validate(req.body, {
        apt: { type: 'string', required: true, max: 20 },
        password: { type: 'string', required: true, max: 200 },
      });
      const tenant = db.prepare('SELECT * FROM tenants WHERE apt_id = ?').get(body.apt.toUpperCase());
      if (!tenant || !verifyPassword(body.password, tenant.password_hash)) {
        throw new HttpError(401, 'Incorrect apartment number or password');
      }
      if (!tenant.portal_active) throw new HttpError(403, 'Portal access for this apartment is inactive. Please contact the front desk.');
      const session = createSession(db, 'tenant', tenant.apt_id, config.sessionTtlHours);
      res.json({ ...session, tenant: { apt_id: tenant.apt_id, name: tenant.name, floor: tenant.floor } });
    }));
  }

  r.post('/auth/logout', route((req, res) => {
    const token = tokenFrom(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.status(204).end();
  }));

  r.get('/auth/me', route((req, res) => {
    const s = lookupSession(db, tokenFrom(req));
    // Only recognise the kinds of session this surface can create.
    if (!s || !surface[s.kind]) throw new HttpError(401, 'Not signed in');
    if (s.kind === 'staff') {
      const u = db.prepare('SELECT username, display_name, role FROM staff_users WHERE username = ?').get(s.subject);
      return res.json({ kind: 'staff', user: u, expiresAt: s.expires_at });
    }
    const t = db.prepare('SELECT apt_id, name, floor FROM tenants WHERE apt_id = ?').get(s.subject);
    res.json({ kind: 'tenant', tenant: t, expiresAt: s.expires_at });
  }));

  return r;
};
