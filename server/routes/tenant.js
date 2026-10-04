'use strict';

const express = require('express');
const { HttpError, validate, route, today } = require('../util');
const { requireSession, verifyPassword, hashPassword } = require('../auth');

const SERVICE_LABELS = { standard: 'Standard Clean', deep: 'Deep Clean', linen: 'Linen Change', laundry: 'Laundry Service' };
const TIME_SLOTS = ['8–10 AM', '10–12 PM', '1–3 PM', '3–5 PM'];

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

module.exports = function tenantRoutes(db) {
  const r = express.Router();
  r.use(requireSession(db, 'tenant'));
  const apt = req => req.session.subject;

  const cleaningFor = a => db.prepare('SELECT * FROM cleaning_requests WHERE tenant_apt = ? ORDER BY created_at DESC').all(a)
    .map(c => ({ ...c, areas: parseJson(c.areas, []), service_label: SERVICE_LABELS[c.service_type] }));
  const maintenanceFor = a => db.prepare(`
    SELECT id, category, title, description, priority, preferred_time, notes, status, created_at, resolved_at
    FROM maintenance_requests WHERE tenant_apt = ? ORDER BY created_at DESC`).all(a);

  function history(a) {
    const items = [
      ...cleaningFor(a).map(c => ({
        kind: 'cleaning', id: c.id,
        title: `Cleaning — ${c.service_label}${c.areas.length ? ` (${c.areas.join(', ')})` : ''}`,
        status: c.status, created_at: c.created_at, completed_at: c.completed_at,
        scheduled_date: c.preferred_date, time_slot: c.time_slot,
      })),
      ...maintenanceFor(a).map(m => ({
        kind: 'maintenance', id: m.id,
        title: `Maintenance — ${m.title}`,
        status: m.status === 'resolved' ? 'done' : m.status, priority: m.priority,
        created_at: m.created_at, completed_at: m.resolved_at, notes: m.notes,
      })),
    ];
    return items.sort((x, y) => y.created_at.localeCompare(x.created_at));
  }

  r.get('/me', route((req, res) => {
    const a = apt(req);
    const t = db.prepare('SELECT apt_id, name, floor, unit_type, lease_end, monthly_rent FROM tenants WHERE apt_id = ?').get(a);
    const due = db.prepare("SELECT COALESCE(SUM(total_mvr), 0) AS n FROM invoices WHERE tenant_apt = ? AND status = 'due'").get(a).n;
    const nextCleaning = db.prepare(`
      SELECT preferred_date, time_slot FROM cleaning_requests
      WHERE tenant_apt = ? AND status IN ('pending', 'in_progress') AND preferred_date >= ?
      ORDER BY preferred_date LIMIT 1`).get(a, today());
    const hist = history(a);
    const latestNotice = db.prepare('SELECT * FROM notices WHERE important = 1 ORDER BY posted_at DESC LIMIT 1').get();
    res.json({
      tenant: t,
      summary: {
        open_requests: hist.filter(h => h.status === 'pending' || h.status === 'in_progress').length,
        amount_due_mvr: due,
        packages_arrived: db.prepare("SELECT COUNT(*) AS n FROM packages WHERE tenant_apt = ? AND status = 'arrived'").get(a).n,
        next_cleaning: nextCleaning || null,
      },
      recent_requests: hist.slice(0, 3),
      announcement: latestNotice ? { ...latestNotice, important: true } : null,
    });
  }));

  r.post('/password', route((req, res) => {
    const body = validate(req.body, {
      current_password: { type: 'string', required: true, max: 200 },
      new_password: { type: 'string', required: true, max: 200 },
    });
    if (body.new_password.length < 8) throw new HttpError(400, 'Validation failed', { new_password: 'must be at least 8 characters' });
    const t = db.prepare('SELECT password_hash FROM tenants WHERE apt_id = ?').get(apt(req));
    if (!verifyPassword(body.current_password, t.password_hash)) throw new HttpError(401, 'Current password is incorrect');
    db.prepare('UPDATE tenants SET password_hash = ? WHERE apt_id = ?').run(hashPassword(body.new_password), apt(req));
    // Sign out every other device.
    db.prepare("DELETE FROM sessions WHERE kind = 'tenant' AND subject = ? AND token != ?").run(apt(req), req.session.token);
    res.status(204).end();
  }));

  r.get('/cleaning', route((req, res) => res.json(cleaningFor(apt(req)))));

  r.post('/cleaning', route((req, res) => {
    const body = validate(req.body, {
      service_type: { type: 'enum', values: Object.keys(SERVICE_LABELS), default: 'standard' },
      areas: { type: 'array', max: 12, default: [] },
      preferred_date: { type: 'date', required: true },
      time_slot: { type: 'string', max: 20 },
      notes: { type: 'string', max: 1000 },
    });
    if (body.preferred_date < today()) throw new HttpError(400, 'Preferred date cannot be in the past');
    if (body.time_slot && !TIME_SLOTS.includes(body.time_slot)) {
      throw new HttpError(400, 'Validation failed', { time_slot: `must be one of: ${TIME_SLOTS.join(', ')}` });
    }
    if (['standard', 'deep'].includes(body.service_type) && !body.areas.length) {
      throw new HttpError(400, 'Please choose at least one area to clean');
    }
    const info = db.prepare(`
      INSERT INTO cleaning_requests (tenant_apt, service_type, areas, preferred_date, time_slot, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(apt(req), body.service_type, JSON.stringify(body.areas), body.preferred_date, body.time_slot ?? null,
        body.notes ?? null, new Date().toISOString());
    res.status(201).json(cleaningFor(apt(req)).find(c => c.id === Number(info.lastInsertRowid)));
  }));

  r.get('/maintenance', route((req, res) => res.json(maintenanceFor(apt(req)))));

  r.post('/maintenance', route((req, res) => {
    const body = validate(req.body, {
      category: { type: 'string', max: 40, default: 'Other' },
      description: { type: 'string', required: true, max: 2000 },
      priority: { type: 'enum', values: ['low', 'medium', 'high'], default: 'low' },
      preferred_time: { type: 'string', max: 40 },
      notes: { type: 'string', max: 1000 },
    });
    const title = body.description.split(/[.\n]/)[0].slice(0, 80);
    const info = db.prepare(`
      INSERT INTO maintenance_requests (location, tenant_apt, category, title, description, priority, preferred_time, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(apt(req), apt(req), body.category, title, body.description, body.priority, body.preferred_time ?? null,
        body.notes ?? null, new Date().toISOString());
    res.status(201).json(maintenanceFor(apt(req)).find(m => m.id === Number(info.lastInsertRowid)));
  }));

  r.get('/history', route((req, res) => res.json(history(apt(req)))));

  r.get('/billing', route((req, res) => {
    const rows = db.prepare('SELECT * FROM invoices WHERE tenant_apt = ? ORDER BY period DESC').all(apt(req))
      .map(i => ({ ...i, line_items: parseJson(i.line_items, []) }));
    res.json({
      current: rows.find(i => i.status === 'due') || null,
      outstanding_mvr: rows.filter(i => i.status === 'due').reduce((s, i) => s + i.total_mvr, 0),
      history: rows.filter(i => i.status === 'paid'),
    });
  }));

  r.get('/packages', route((req, res) => {
    res.json(db.prepare(`
      SELECT * FROM packages WHERE tenant_apt = ? AND status != 'collected'
      ORDER BY COALESCE(arrived_at, expected_at) DESC`).all(apt(req)));
  }));

  r.get('/notices', route((_req, res) => {
    res.json(db.prepare('SELECT * FROM notices ORDER BY posted_at DESC').all().map(n => ({ ...n, important: !!n.important })));
  }));

  return r;
};
