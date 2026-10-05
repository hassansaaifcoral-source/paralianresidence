'use strict';

const express = require('express');
const { HttpError, validate, route, today, nightsBetween } = require('../util');
const { transaction } = require('../db');
const { hashPassword, requireSession } = require('../auth');
const { freeRooms, checkDates, nextRef, normaliseType, presentBooking } = require('../bookings');

const nowIso = () => new Date().toISOString();

function leaseStatus(leaseEnd, now = today()) {
  if (leaseEnd < now) return 'expired';
  if (nightsBetween(now, leaseEnd) <= 60) return 'renewal_due';
  return 'active';
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

module.exports = function adminRoutes(db) {
  const r = express.Router();
  r.use(requireSession(db, 'staff'));

  const getBooking = ref => {
    const b = db.prepare(`
      SELECT b.*, t.name AS type_name FROM bookings b JOIN room_types t ON t.code = b.type_code
      WHERE b.ref = ?`).get(String(ref).toUpperCase());
    if (!b) throw new HttpError(404, 'Booking not found');
    return b;
  };

  /* ── Overview ─────────────────────────────────────── */

  r.get('/overview', route((_req, res) => {
    const now = today();
    const month = now.slice(0, 7);
    const rooms = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(status = 'occupied') AS occupied,
             SUM(status = 'maintenance') AS maintenance
      FROM rooms`).get();
    const arrivals = db.prepare(`
      SELECT b.*, t.name AS type_name FROM bookings b JOIN room_types t ON t.code = b.type_code
      WHERE b.check_in = ? AND b.status IN ('confirmed', 'checked_in') ORDER BY b.eta`).all(now);
    const departures = db.prepare(`
      SELECT b.*, t.name AS type_name FROM bookings b JOIN room_types t ON t.code = b.type_code
      WHERE b.check_out = ? AND b.status IN ('checked_in', 'checked_out') ORDER BY b.ref`).all(now);
    const openRequests = db.prepare(`
      SELECT * FROM maintenance_requests WHERE status != 'resolved'
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC`).all();
    const revenue = db.prepare(`
      SELECT COALESCE(SUM(total_usd), 0) AS total FROM bookings
      WHERE status != 'cancelled' AND substr(check_in, 1, 7) = ?`).get(month).total;

    res.json({
      date: now,
      rooms: {
        total: rooms.total,
        occupied: rooms.occupied || 0,
        maintenance: rooms.maintenance || 0,
        occupancy_rate: rooms.total ? Math.round(((rooms.occupied || 0) / rooms.total) * 100) : 0,
      },
      arrivals: arrivals.map(presentBooking),
      departures: departures.map(presentBooking),
      open_requests: openRequests,
      revenue_month_usd: revenue,
      counts: {
        upcoming_bookings: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").get().n,
        open_maintenance: openRequests.length,
        new_enquiries: db.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'").get().n,
        new_messages: db.prepare("SELECT COUNT(*) AS n FROM contact_messages WHERE status = 'new'").get().n,
        pending_cleaning: db.prepare("SELECT COUNT(*) AS n FROM cleaning_requests WHERE status IN ('pending', 'in_progress')").get().n,
      },
    });
  }));

  /* ── Bookings ─────────────────────────────────────── */

  r.get('/bookings', route((req, res) => {
    const q = validate(req.query, {
      status: { type: 'enum', values: ['confirmed', 'checked_in', 'checked_out', 'cancelled'] },
      from: { type: 'date' },
      to: { type: 'date' },
    });
    const rows = db.prepare(`
      SELECT b.*, t.name AS type_name FROM bookings b JOIN room_types t ON t.code = b.type_code
      WHERE (? IS NULL OR b.status = ?)
        AND (? IS NULL OR b.check_out >= ?)
        AND (? IS NULL OR b.check_in <= ?)
      ORDER BY b.check_in DESC, b.ref DESC`)
      .all(q.status ?? null, q.status ?? null, q.from ?? null, q.from ?? null, q.to ?? null, q.to ?? null);
    res.json(rows.map(presentBooking));
  }));

  r.post('/bookings', route((req, res) => {
    const body = validate(req.body, {
      guest_name: { type: 'string', max: 160 },
      first_name: { type: 'string', max: 80 },
      last_name: { type: 'string', max: 80 },
      email: { type: 'email' },
      phone: { type: 'string', max: 40 },
      checkin: { type: 'date', required: true },
      checkout: { type: 'date', required: true },
      room: { type: 'string', required: true, max: 40 },
      room_number: { type: 'string', max: 10 },
      guests: { type: 'int', min: 1, max: 8, default: 1 },
      source: { type: 'string', max: 40, default: 'Direct' },
      payment_method: { type: 'string', max: 40 },
      eta: { type: 'string', max: 10 },
      notes: { type: 'string', max: 2000 },
    });
    const guestName = body.guest_name || [body.first_name, body.last_name].filter(Boolean).join(' ');
    if (!guestName) throw new HttpError(400, 'Validation failed', { guest_name: 'is required' });
    checkDates(body.checkin, body.checkout);

    const type = db.prepare('SELECT * FROM room_types WHERE code = ?').get(normaliseType(body.room));
    if (!type) throw new HttpError(400, 'Validation failed', { room: 'is not a room type we offer' });
    if (body.guests > type.max_guests) {
      throw new HttpError(400, `${type.name} sleeps at most ${type.max_guests}`);
    }

    const booking = transaction(db, () => {
      const free = freeRooms(db, type.code, body.checkin, body.checkout);
      let room = body.room_number;
      if (room && !free.includes(room)) throw new HttpError(409, `Room ${room} is not available for those dates`);
      room = room || free[0];
      if (!room) throw new HttpError(409, `No ${type.name} rooms are available for those dates`);

      const ref = nextRef(db);
      const total = type.price_usd * nightsBetween(body.checkin, body.checkout);
      db.prepare(`
        INSERT INTO bookings (ref, guest_name, email, phone, room_number, type_code, check_in, check_out,
          guests, source, payment_method, total_usd, balance_usd, eta, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ref, guestName, body.email ?? null, body.phone ?? null, room, type.code, body.checkin,
          body.checkout, body.guests, body.source, body.payment_method ?? null, total, total,
          body.eta ?? null, body.notes ?? null, nowIso());
      return getBooking(ref);
    });
    res.status(201).json(presentBooking(booking));
  }));

  r.get('/bookings/:ref', route((req, res) => res.json(presentBooking(getBooking(req.params.ref)))));

  r.patch('/bookings/:ref', route((req, res) => {
    const b = getBooking(req.params.ref);
    const body = validate(req.body, {
      email: { type: 'email' },
      phone: { type: 'string', max: 40 },
      guests: { type: 'int', min: 1, max: 8 },
      source: { type: 'string', max: 40 },
      payment_method: { type: 'string', max: 40 },
      eta: { type: 'string', max: 10 },
      notes: { type: 'string', max: 2000 },
      checkin: { type: 'date' },
      checkout: { type: 'date' },
      room_number: { type: 'string', max: 10 },
    });
    if (['checked_out', 'cancelled'].includes(b.status)) throw new HttpError(409, 'Closed bookings cannot be edited');

    const updated = transaction(db, () => {
      const checkIn = body.checkin ?? b.check_in;
      const checkOut = body.checkout ?? b.check_out;
      const room = body.room_number ?? b.room_number;
      if (body.checkin || body.checkout || body.room_number) {
        if (b.status === 'checked_in' && (body.checkin || body.room_number)) {
          throw new HttpError(409, 'Guest is already checked in; only the check-out date can change');
        }
        checkDates(checkIn, checkOut, { allowPast: b.status === 'checked_in' });
        const roomRow = db.prepare('SELECT type_code FROM rooms WHERE number = ?').get(room);
        if (!roomRow) throw new HttpError(400, 'Unknown room number');
        if (!freeRooms(db, roomRow.type_code, checkIn, checkOut, { excludeRef: b.ref }).includes(room)) {
          throw new HttpError(409, `Room ${room} is not available for those dates`);
        }
        const price = db.prepare('SELECT price_usd FROM room_types WHERE code = ?').get(roomRow.type_code).price_usd;
        const newTotal = price * nightsBetween(checkIn, checkOut);
        const paid = b.total_usd - b.balance_usd;
        db.prepare(`UPDATE bookings SET check_in = ?, check_out = ?, room_number = ?, type_code = ?,
          total_usd = ?, balance_usd = ? WHERE ref = ?`)
          .run(checkIn, checkOut, room, roomRow.type_code, newTotal, Math.max(0, newTotal - paid), b.ref);
      }
      for (const field of ['email', 'phone', 'guests', 'source', 'payment_method', 'eta', 'notes']) {
        if (body[field] !== undefined) db.prepare(`UPDATE bookings SET ${field} = ? WHERE ref = ?`).run(body[field], b.ref);
      }
      return getBooking(b.ref);
    });
    res.json(presentBooking(updated));
  }));

  r.post('/bookings/:ref/check-in', route((req, res) => {
    const b = getBooking(req.params.ref);
    if (b.status !== 'confirmed') throw new HttpError(409, `Cannot check in a booking that is ${b.status.replace('_', ' ')}`);
    if (b.check_in > today()) throw new HttpError(409, 'Check-in date has not arrived yet');
    const room = db.prepare('SELECT status FROM rooms WHERE number = ?').get(b.room_number);
    if (room && room.status !== 'available') throw new HttpError(409, `Room ${b.room_number} is ${room.status}`);
    transaction(db, () => {
      db.prepare("UPDATE bookings SET status = 'checked_in' WHERE ref = ?").run(b.ref);
      db.prepare("UPDATE rooms SET status = 'occupied' WHERE number = ?").run(b.room_number);
    });
    res.json(presentBooking(getBooking(b.ref)));
  }));

  r.post('/bookings/:ref/check-out', route((req, res) => {
    const b = getBooking(req.params.ref);
    if (b.status !== 'checked_in') throw new HttpError(409, 'Guest is not checked in');
    transaction(db, () => {
      db.prepare("UPDATE bookings SET status = 'checked_out' WHERE ref = ?").run(b.ref);
      db.prepare("UPDATE rooms SET status = 'available', clean_status = 'due' WHERE number = ?").run(b.room_number);
    });
    res.json(presentBooking(getBooking(b.ref)));
  }));

  r.post('/bookings/:ref/cancel', route((req, res) => {
    const b = getBooking(req.params.ref);
    if (b.status !== 'confirmed') throw new HttpError(409, 'Only confirmed (not yet arrived) bookings can be cancelled');
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE ref = ?").run(b.ref);
    res.json(presentBooking(getBooking(b.ref)));
  }));

  r.post('/bookings/:ref/settle', route((req, res) => {
    const b = getBooking(req.params.ref);
    const body = validate(req.body, { amount_usd: { type: 'int', min: 1 } });
    if (b.balance_usd <= 0) throw new HttpError(409, 'Booking has no outstanding balance');
    const amount = Math.min(body.amount_usd ?? b.balance_usd, b.balance_usd);
    db.prepare('UPDATE bookings SET balance_usd = balance_usd - ? WHERE ref = ?').run(amount, b.ref);
    res.json(presentBooking(getBooking(b.ref)));
  }));

  /* ── Rooms & guests ───────────────────────────────── */

  r.get('/rooms', route((_req, res) => {
    const rows = db.prepare(`
      SELECT r.*, t.name AS type_name,
        (SELECT b.guest_name FROM bookings b WHERE b.room_number = r.number AND b.status = 'checked_in' LIMIT 1) AS guest_name,
        (SELECT b.ref FROM bookings b WHERE b.room_number = r.number AND b.status = 'checked_in' LIMIT 1) AS booking_ref
      FROM rooms r JOIN room_types t ON t.code = r.type_code
      ORDER BY CAST(r.number AS INTEGER)`).all();
    res.json(rows);
  }));

  r.patch('/rooms/:number', route((req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE number = ?').get(req.params.number);
    if (!room) throw new HttpError(404, 'Room not found');
    const body = validate(req.body, {
      status: { type: 'enum', values: ['available', 'maintenance'], required: true },
    });
    if (room.status === 'occupied') throw new HttpError(409, 'Room is occupied — check the guest out first');
    db.prepare('UPDATE rooms SET status = ? WHERE number = ?').run(body.status, room.number);
    res.json(db.prepare('SELECT * FROM rooms WHERE number = ?').get(room.number));
  }));

  r.get('/guests', route((_req, res) => {
    const now = today();
    const rows = db.prepare(`
      SELECT b.*, t.name AS type_name FROM bookings b JOIN room_types t ON t.code = b.type_code
      WHERE b.status = 'checked_in' ORDER BY b.room_number`).all();
    res.json(rows.map(b => ({ ...presentBooking(b), nights_left: Math.max(0, nightsBetween(now, b.check_out)) })));
  }));

  /* ── Housekeeping ─────────────────────────────────── */

  r.get('/housekeeping', route((_req, res) => {
    res.json(db.prepare(`
      SELECT r.number, r.type_code, t.name AS type_name, r.status, r.last_cleaned, r.clean_status, r.housekeeper
      FROM rooms r JOIN room_types t ON t.code = r.type_code
      ORDER BY r.clean_status = 'due' DESC, CAST(r.number AS INTEGER)`).all());
  }));

  r.post('/housekeeping/:number/clean', route((req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE number = ?').get(req.params.number);
    if (!room) throw new HttpError(404, 'Room not found');
    const body = validate(req.body, { housekeeper: { type: 'string', max: 60 } });
    db.prepare("UPDATE rooms SET clean_status = 'clean', last_cleaned = ?, housekeeper = COALESCE(?, housekeeper) WHERE number = ?")
      .run(nowIso(), body.housekeeper ?? null, room.number);
    res.json(db.prepare('SELECT * FROM rooms WHERE number = ?').get(room.number));
  }));

  r.patch('/housekeeping/:number', route((req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE number = ?').get(req.params.number);
    if (!room) throw new HttpError(404, 'Room not found');
    const body = validate(req.body, {
      housekeeper: { type: 'string', max: 60 },
      clean_status: { type: 'enum', values: ['clean', 'due'] },
    });
    if (body.housekeeper !== undefined) db.prepare('UPDATE rooms SET housekeeper = ? WHERE number = ?').run(body.housekeeper, room.number);
    if (body.clean_status) db.prepare('UPDATE rooms SET clean_status = ? WHERE number = ?').run(body.clean_status, room.number);
    res.json(db.prepare('SELECT * FROM rooms WHERE number = ?').get(room.number));
  }));

  /* ── Maintenance (hotel rooms + residence apartments) ─ */

  r.get('/maintenance', route((req, res) => {
    const q = validate(req.query, {
      status: { type: 'enum', values: ['pending', 'in_progress', 'resolved', 'open'] },
      scope: { type: 'enum', values: ['hotel', 'residence'] },
    });
    const rows = db.prepare(`
      SELECT * FROM maintenance_requests
      WHERE (? IS NULL OR (? = 'open' AND status != 'resolved') OR status = ?)
        AND (? IS NULL OR (? = 'hotel' AND tenant_apt IS NULL) OR (? = 'residence' AND tenant_apt IS NOT NULL))
      ORDER BY status = 'resolved', CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC`)
      .all(q.status ?? null, q.status ?? null, q.status ?? null, q.scope ?? null, q.scope ?? null, q.scope ?? null);
    res.json(rows);
  }));

  r.post('/maintenance', route((req, res) => {
    const body = validate(req.body, {
      location: { type: 'string', required: true, max: 40 },
      title: { type: 'string', max: 120 },
      description: { type: 'string', required: true, max: 2000 },
      category: { type: 'string', max: 40, default: 'Other' },
      priority: { type: 'enum', values: ['low', 'medium', 'high'], default: 'medium' },
      assigned_to: { type: 'string', max: 60 },
    });
    const aptMatch = body.location.toUpperCase().match(/^APT-\d+$/);
    const tenantApt = aptMatch && db.prepare('SELECT apt_id FROM tenants WHERE apt_id = ?').get(aptMatch[0]) ? aptMatch[0] : null;
    const title = body.title || body.description.split(/[.\n]/)[0].slice(0, 80);
    const info = db.prepare(`
      INSERT INTO maintenance_requests (location, tenant_apt, category, title, description, priority, assigned_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(body.location, tenantApt, body.category, title, body.description, body.priority, body.assigned_to ?? null, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(info.lastInsertRowid));
  }));

  r.patch('/maintenance/:id', route((req, res) => {
    const m = db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(req.params.id);
    if (!m) throw new HttpError(404, 'Request not found');
    const body = validate(req.body, {
      status: { type: 'enum', values: ['pending', 'in_progress', 'resolved'] },
      priority: { type: 'enum', values: ['low', 'medium', 'high'] },
      assigned_to: { type: 'string', max: 60 },
      notes: { type: 'string', max: 2000 },
    });
    transaction(db, () => {
      if (body.status) {
        db.prepare('UPDATE maintenance_requests SET status = ?, resolved_at = ? WHERE id = ?')
          .run(body.status, body.status === 'resolved' ? nowIso() : null, m.id);
      }
      for (const f of ['priority', 'assigned_to', 'notes']) {
        if (body[f] !== undefined) db.prepare(`UPDATE maintenance_requests SET ${f} = ? WHERE id = ?`).run(body[f], m.id);
      }
    });
    res.json(db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(m.id));
  }));

  /* ── Residence cleaning requests ──────────────────── */

  r.get('/cleaning-requests', route((_req, res) => {
    const rows = db.prepare(`
      SELECT c.*, t.name AS tenant_name FROM cleaning_requests c JOIN tenants t ON t.apt_id = c.tenant_apt
      ORDER BY c.status IN ('done', 'cancelled'), c.preferred_date`).all();
    res.json(rows.map(c => ({ ...c, areas: parseJson(c.areas, []) })));
  }));

  r.patch('/cleaning-requests/:id', route((req, res) => {
    const c = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(req.params.id);
    if (!c) throw new HttpError(404, 'Request not found');
    const body = validate(req.body, {
      status: { type: 'enum', values: ['pending', 'in_progress', 'done', 'cancelled'], required: true },
    });
    db.prepare('UPDATE cleaning_requests SET status = ?, completed_at = ? WHERE id = ?')
      .run(body.status, body.status === 'done' ? nowIso() : null, c.id);
    const row = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(c.id);
    res.json({ ...row, areas: parseJson(row.areas, []) });
  }));

  /* ── Café orders ──────────────────────────────────── */

  r.get('/cafe-orders', route((req, res) => {
    const q = validate(req.query, { date: { type: 'date', default: today() } });
    // created_at is stored in UTC; the café day runs on Maldives time (UTC+5).
    const rows = db.prepare(`
      SELECT * FROM cafe_orders WHERE date(created_at, '+5 hours') = ? ORDER BY created_at DESC`).all(q.date);
    const billable = rows.filter(o => o.status !== 'cancelled');
    const revenue = billable.reduce((s, o) => s + o.total_mvr, 0);
    res.json({
      date: q.date,
      stats: {
        total_orders: billable.length,
        revenue_mvr: revenue,
        average_order_mvr: billable.length ? Math.round(revenue / billable.length) : 0,
      },
      orders: rows,
    });
  }));

  r.post('/cafe-orders', route((req, res) => {
    const body = validate(req.body, {
      location: { type: 'string', required: true, max: 40 },
      items: { type: 'string', required: true, max: 500 },
      total_mvr: { type: 'int', required: true, min: 0, max: 1000000 },
    });
    const info = db.prepare('INSERT INTO cafe_orders (location, items, total_mvr, created_at) VALUES (?, ?, ?, ?)')
      .run(body.location, body.items, body.total_mvr, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM cafe_orders WHERE id = ?').get(info.lastInsertRowid));
  }));

  r.patch('/cafe-orders/:id', route((req, res) => {
    const o = db.prepare('SELECT * FROM cafe_orders WHERE id = ?').get(req.params.id);
    if (!o) throw new HttpError(404, 'Order not found');
    const body = validate(req.body, {
      status: { type: 'enum', values: ['in_progress', 'delivered', 'cancelled'], required: true },
    });
    db.prepare('UPDATE cafe_orders SET status = ? WHERE id = ?').run(body.status, o.id);
    res.json(db.prepare('SELECT * FROM cafe_orders WHERE id = ?').get(o.id));
  }));

  /* ── Tenants, invoices, packages, notices ─────────── */

  r.get('/tenants', route((_req, res) => {
    const rows = db.prepare(`
      SELECT t.apt_id, t.name, t.floor, t.unit_type, t.lease_end, t.portal_active, t.monthly_rent,
        (SELECT COALESCE(SUM(total_mvr), 0) FROM invoices i WHERE i.tenant_apt = t.apt_id AND i.status = 'due') AS balance_due_mvr,
        (SELECT COUNT(*) FROM maintenance_requests m WHERE m.tenant_apt = t.apt_id AND m.status != 'resolved')
          + (SELECT COUNT(*) FROM cleaning_requests c WHERE c.tenant_apt = t.apt_id AND c.status IN ('pending', 'in_progress')) AS open_requests
      FROM tenants t ORDER BY t.apt_id`).all();
    res.json(rows.map(t => ({ ...t, portal_active: !!t.portal_active, lease_status: leaseStatus(t.lease_end) })));
  }));

  r.patch('/tenants/:apt', route((req, res) => {
    const t = db.prepare('SELECT * FROM tenants WHERE apt_id = ?').get(req.params.apt.toUpperCase());
    if (!t) throw new HttpError(404, 'Tenant not found');
    const body = validate(req.body, {
      name: { type: 'string', max: 120 },
      lease_end: { type: 'date' },
      monthly_rent: { type: 'int', min: 0 },
      portal_active: { type: 'enum', values: [true, false] },
      password: { type: 'string', max: 200 },
    });
    if (body.password !== undefined && body.password.length < 8) {
      throw new HttpError(400, 'Validation failed', { password: 'must be at least 8 characters' });
    }
    transaction(db, () => {
      for (const f of ['name', 'lease_end', 'monthly_rent']) {
        if (body[f] !== undefined) db.prepare(`UPDATE tenants SET ${f} = ? WHERE apt_id = ?`).run(body[f], t.apt_id);
      }
      if (body.portal_active !== undefined) {
        db.prepare('UPDATE tenants SET portal_active = ? WHERE apt_id = ?').run(body.portal_active ? 1 : 0, t.apt_id);
        if (!body.portal_active) db.prepare("DELETE FROM sessions WHERE kind = 'tenant' AND subject = ?").run(t.apt_id);
      }
      if (body.password !== undefined) {
        db.prepare('UPDATE tenants SET password_hash = ? WHERE apt_id = ?').run(hashPassword(body.password), t.apt_id);
        db.prepare("DELETE FROM sessions WHERE kind = 'tenant' AND subject = ?").run(t.apt_id);
      }
    });
    const row = db.prepare('SELECT apt_id, name, floor, unit_type, lease_end, portal_active, monthly_rent FROM tenants WHERE apt_id = ?').get(t.apt_id);
    res.json({ ...row, portal_active: !!row.portal_active, lease_status: leaseStatus(row.lease_end) });
  }));

  r.get('/invoices', route((req, res) => {
    const q = validate(req.query, {
      tenant: { type: 'string', max: 20 },
      status: { type: 'enum', values: ['due', 'paid'] },
    });
    const tenant = q.tenant ? q.tenant.toUpperCase() : null;
    const rows = db.prepare(`
      SELECT * FROM invoices WHERE (? IS NULL OR tenant_apt = ?) AND (? IS NULL OR status = ?)
      ORDER BY period DESC, tenant_apt`).all(tenant, tenant, q.status ?? null, q.status ?? null);
    res.json(rows.map(i => ({ ...i, line_items: parseJson(i.line_items, []) })));
  }));

  r.post('/invoices', route((req, res) => {
    const body = validate(req.body, {
      tenant_apt: { type: 'string', required: true, max: 20 },
      period: { type: 'string', required: true, max: 7 },
      due_date: { type: 'date', required: true },
    });
    if (!/^\d{4}-\d{2}$/.test(body.period)) throw new HttpError(400, 'Validation failed', { period: 'must be YYYY-MM' });
    const items = req.body.line_items;
    if (!Array.isArray(items) || !items.length || items.some(i =>
      !i || typeof i.label !== 'string' || !i.label.trim() || !Number.isInteger(i.amount_mvr))) {
      throw new HttpError(400, 'Validation failed', { line_items: 'must be a non-empty list of { label, amount_mvr }' });
    }
    const apt = body.tenant_apt.toUpperCase();
    if (!db.prepare('SELECT 1 FROM tenants WHERE apt_id = ?').get(apt)) throw new HttpError(404, 'Tenant not found');
    if (db.prepare('SELECT 1 FROM invoices WHERE tenant_apt = ? AND period = ?').get(apt, body.period)) {
      throw new HttpError(409, 'An invoice for that period already exists');
    }
    const clean = items.map(i => ({ label: i.label.trim().slice(0, 80), amount_mvr: i.amount_mvr }));
    const total = clean.reduce((s, i) => s + i.amount_mvr, 0);
    const info = db.prepare('INSERT INTO invoices (tenant_apt, period, line_items, total_mvr, due_date) VALUES (?, ?, ?, ?, ?)')
      .run(apt, body.period, JSON.stringify(clean), total, body.due_date);
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ...row, line_items: clean });
  }));

  r.post('/invoices/:id/pay', route((req, res) => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.status === 'paid') throw new HttpError(409, 'Invoice is already paid');
    db.prepare("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?").run(nowIso(), inv.id);
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    res.json({ ...row, line_items: parseJson(row.line_items, []) });
  }));

  r.get('/packages', route((_req, res) => {
    res.json(db.prepare("SELECT * FROM packages ORDER BY status = 'collected', COALESCE(arrived_at, expected_at) DESC").all());
  }));

  r.post('/packages', route((req, res) => {
    const body = validate(req.body, {
      tenant_apt: { type: 'string', required: true, max: 20 },
      carrier: { type: 'string', required: true, max: 60 },
      description: { type: 'string', required: true, max: 200 },
      status: { type: 'enum', values: ['expected', 'arrived'], default: 'arrived' },
      expected_at: { type: 'date' },
    });
    const apt = body.tenant_apt.toUpperCase();
    if (!db.prepare('SELECT 1 FROM tenants WHERE apt_id = ?').get(apt)) throw new HttpError(404, 'Tenant not found');
    const info = db.prepare(`
      INSERT INTO packages (tenant_apt, carrier, description, status, arrived_at, expected_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(apt, body.carrier, body.description, body.status, body.status === 'arrived' ? nowIso() : null, body.expected_at ?? null);
    res.status(201).json(db.prepare('SELECT * FROM packages WHERE id = ?').get(info.lastInsertRowid));
  }));

  r.patch('/packages/:id', route((req, res) => {
    const p = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
    if (!p) throw new HttpError(404, 'Package not found');
    const body = validate(req.body, {
      status: { type: 'enum', values: ['expected', 'arrived', 'collected'], required: true },
    });
    const stamp = nowIso();
    db.prepare(`UPDATE packages SET status = ?,
      arrived_at = CASE WHEN ? = 'arrived' AND arrived_at IS NULL THEN ? ELSE arrived_at END,
      collected_at = CASE WHEN ? = 'collected' THEN ? ELSE NULL END WHERE id = ?`)
      .run(body.status, body.status, stamp, body.status, stamp, p.id);
    res.json(db.prepare('SELECT * FROM packages WHERE id = ?').get(p.id));
  }));

  r.get('/notices', route((_req, res) => {
    res.json(db.prepare('SELECT * FROM notices ORDER BY posted_at DESC').all().map(n => ({ ...n, important: !!n.important })));
  }));

  r.post('/notices', route((req, res) => {
    const body = validate(req.body, {
      title: { type: 'string', required: true, max: 160 },
      body: { type: 'string', required: true, max: 5000 },
      important: { type: 'enum', values: [true, false], default: false },
    });
    const author = db.prepare('SELECT display_name FROM staff_users WHERE username = ?').get(req.session.subject);
    const info = db.prepare('INSERT INTO notices (title, body, important, posted_by, posted_at) VALUES (?, ?, ?, ?, ?)')
      .run(body.title, body.body, body.important ? 1 : 0, author?.display_name || 'Management', nowIso());
    const n = db.prepare('SELECT * FROM notices WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ...n, important: !!n.important });
  }));

  r.delete('/notices/:id', route((req, res) => {
    const info = db.prepare('DELETE FROM notices WHERE id = ?').run(req.params.id);
    if (!info.changes) throw new HttpError(404, 'Notice not found');
    res.status(204).end();
  }));

  /* ── Website inbox ────────────────────────────────── */

  const getEnquiry = id => db.prepare(`
    SELECT e.*, t.name AS type_name FROM enquiries e LEFT JOIN room_types t ON t.code = e.type_code
    WHERE e.id = ?`).get(id);

  r.get('/enquiries', route((_req, res) => {
    res.json(db.prepare(`
      SELECT e.*, t.name AS type_name FROM enquiries e LEFT JOIN room_types t ON t.code = e.type_code
      ORDER BY e.status != 'new', e.created_at DESC`).all());
  }));

  r.patch('/enquiries/:id', route((req, res) => {
    const body = validate(req.body, {
      status: { type: 'enum', values: ['new', 'contacted', 'booked', 'closed'], required: true },
      booking_ref: { type: 'string', max: 20 },
    });
    if (!getEnquiry(req.params.id)) throw new HttpError(404, 'Enquiry not found');
    if (body.booking_ref && !db.prepare('SELECT 1 FROM bookings WHERE ref = ?').get(body.booking_ref.toUpperCase())) {
      throw new HttpError(400, 'Validation failed', { booking_ref: 'does not match a booking' });
    }
    db.prepare('UPDATE enquiries SET status = ?, booking_ref = COALESCE(?, booking_ref) WHERE id = ?')
      .run(body.status, body.booking_ref ? body.booking_ref.toUpperCase() : null, req.params.id);
    res.json(getEnquiry(req.params.id));
  }));

  r.get('/messages', route((_req, res) => {
    res.json(db.prepare("SELECT * FROM contact_messages ORDER BY status != 'new', created_at DESC").all());
  }));

  r.patch('/messages/:id', route((req, res) => {
    const body = validate(req.body, { status: { type: 'enum', values: ['new', 'replied', 'closed'], required: true } });
    const info = db.prepare('UPDATE contact_messages SET status = ? WHERE id = ?').run(body.status, req.params.id);
    if (!info.changes) throw new HttpError(404, 'Message not found');
    res.json(db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(req.params.id));
  }));

  return r;
};

module.exports.leaseStatus = leaseStatus;
