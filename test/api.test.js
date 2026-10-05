'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { today } = require('../server/util');

let server;
let base;

before(async () => {
  const app = createApp({ dbPath: ':memory:', sessionTtlHours: 1, staticRoot: require('node:path').join(__dirname, '..') });
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

async function req(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const staffLogin = async () =>
  (await req('POST', '/api/auth/staff/login', { body: { username: 'admin', password: 'paralian2025' } })).data.token;
const tenantLogin = async (apt = 'APT-101') =>
  (await req('POST', '/api/auth/tenant/login', { body: { apt, password: 'paralian2025' } })).data.token;

/* ── Public ─────────────────────────────────────────── */

test('health check', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

const CONTACT = { name: 'Test Guest', email: 'guest@example.com' };

test('enquiry stores and returns availability; "studio" maps to the Nest', async () => {
  const r = await req('POST', '/api/enquiries', {
    body: { checkin: today(30), checkout: today(33), room: 'studio', guests: 1, ...CONTACT },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.availability.length, 1);
  assert.equal(r.data.availability[0].type, 'nest');
  assert.equal(r.data.availability[0].estimated_total_usd, 79 * 3);
});

test('enquiry validation rejects bad dates', async () => {
  let r = await req('POST', '/api/enquiries', { body: { checkin: today(5), checkout: today(3), ...CONTACT } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/enquiries', { body: { checkin: 'tomorrow', checkout: today(3), ...CONTACT } });
  assert.equal(r.status, 400);
  assert.ok(r.data.details.checkin);
  r = await req('POST', '/api/enquiries', { body: { checkin: today(-3), checkout: today(1), ...CONTACT } });
  assert.equal(r.status, 400);
});

test('enquiry requires a name and a valid email', async () => {
  const dates = { checkin: today(10), checkout: today(12) };
  let r = await req('POST', '/api/enquiries', { body: dates });
  assert.equal(r.status, 400);
  assert.ok(r.data.details.name);
  assert.ok(r.data.details.email);
  r = await req('POST', '/api/enquiries', { body: { ...dates, name: 'A', email: 'not-an-email' } });
  assert.equal(r.status, 400);
  assert.ok(r.data.details.email);
});

/* ── Staff inbox ────────────────────────────────────── */

test('website enquiry shows in the staff inbox and can be turned into a booking', async () => {
  const sent = await req('POST', '/api/enquiries', {
    body: { checkin: today(60), checkout: today(63), room: 'palms', guests: 2, name: 'Inbox Tester', email: 'Inbox@Example.com', phone: '+960 7000000' },
  });
  assert.equal(sent.status, 201);
  const token = await staffLogin();
  const list = (await req('GET', '/api/admin/enquiries', { token })).data;
  const e = list.find(x => x.id === sent.data.id);
  assert.equal(e.name, 'Inbox Tester');
  assert.equal(e.email, 'inbox@example.com');
  assert.equal(e.phone, '+960 7000000');
  assert.equal(e.type_name, 'Palms View Deluxe');
  assert.equal(e.status, 'new');
  assert.equal(list[0].status, 'new', 'new enquiries are listed first');

  const counts = (await req('GET', '/api/admin/overview', { token })).data.counts;
  assert.ok(counts.new_enquiries >= 1);

  const b = await req('POST', '/api/admin/bookings', {
    token, body: { guest_name: e.name, email: e.email, checkin: e.check_in, checkout: e.check_out, room: e.type_code, guests: e.guests },
  });
  assert.equal(b.status, 201);
  const upd = await req('PATCH', `/api/admin/enquiries/${e.id}`, { token, body: { status: 'booked', booking_ref: b.data.ref } });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.status, 'booked');
  assert.equal(upd.data.booking_ref, b.data.ref);

  const bad = await req('PATCH', `/api/admin/enquiries/${e.id}`, { token, body: { status: 'booked', booking_ref: 'PRL-999' } });
  assert.equal(bad.status, 400);
  assert.equal((await req('PATCH', '/api/admin/enquiries/99999', { token, body: { status: 'closed' } })).status, 404);
});

test('contact message shows in the staff inbox and can be marked replied', async () => {
  const sent = await req('POST', '/api/contact', {
    body: { first_name: 'Ina', last_name: 'Box', email: 'ina@example.com', subject: 'Room Booking', message: 'Line one\nLine two' },
  });
  const token = await staffLogin();
  const msgs = (await req('GET', '/api/admin/messages', { token })).data;
  const m = msgs.find(x => x.id === sent.data.id);
  assert.equal(m.message, 'Line one\nLine two');
  assert.equal(m.status, 'new');
  const upd = await req('PATCH', `/api/admin/messages/${m.id}`, { token, body: { status: 'replied' } });
  assert.equal(upd.data.status, 'replied');
  assert.equal((await req('PATCH', `/api/admin/messages/${m.id}`, { token, body: { status: 'spam' } })).status, 400);
});

test('tenant cleaning request moves through the staff workflow', async () => {
  const tenant = await tenantLogin('APT-501');
  const c = (await req('POST', '/api/tenant/cleaning', {
    token: tenant, body: { service_type: 'standard', areas: ['Kitchen'], preferred_date: today(1) },
  })).data;
  const staff = await staffLogin();
  const list = (await req('GET', '/api/admin/cleaning-requests', { token: staff })).data;
  const row = list.find(x => x.id === c.id);
  assert.equal(row.tenant_name, 'Zaha Waheed');
  assert.deepEqual(row.areas, ['Kitchen']);
  await req('PATCH', `/api/admin/cleaning-requests/${c.id}`, { token: staff, body: { status: 'in_progress' } });
  const done = await req('PATCH', `/api/admin/cleaning-requests/${c.id}`, { token: staff, body: { status: 'done' } });
  assert.equal(done.data.status, 'done');
  assert.ok(done.data.completed_at);
  const mine = (await req('GET', '/api/tenant/cleaning', { token: tenant })).data;
  assert.equal(mine.find(x => x.id === c.id).status, 'done');
});

test('contact form requires a valid email', async () => {
  let r = await req('POST', '/api/contact', { body: { first_name: 'A', last_name: 'B', email: 'nope', message: 'Hi' } });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/contact', { body: { first_name: 'A', last_name: 'B', email: 'a@b.com', message: 'Hi' } });
  assert.equal(r.status, 201);
});

test('malformed JSON gets a 400, unknown API routes a 404', async () => {
  const res = await fetch(base + '/api/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
  assert.equal((await req('GET', '/api/nope')).status, 404);
});

/* ── Auth ───────────────────────────────────────────── */

test('staff login rejects wrong password and protects admin routes', async () => {
  const bad = await req('POST', '/api/auth/staff/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.status, 401);
  assert.equal((await req('GET', '/api/admin/overview')).status, 401);
  const token = await staffLogin();
  assert.equal((await req('GET', '/api/admin/overview', { token })).status, 200);
});

test('tenant tokens cannot reach admin routes and vice versa', async () => {
  const tenant = await tenantLogin();
  const staff = await staffLogin();
  assert.equal((await req('GET', '/api/admin/bookings', { token: tenant })).status, 401);
  assert.equal((await req('GET', '/api/tenant/me', { token: staff })).status, 401);
});

test('logout invalidates the token', async () => {
  const token = await staffLogin();
  assert.equal((await req('POST', '/api/auth/logout', { token })).status, 204);
  assert.equal((await req('GET', '/api/admin/overview', { token })).status, 401);
});

test('tenant with inactive portal cannot sign in', async () => {
  const r = await req('POST', '/api/auth/tenant/login', { body: { apt: 'APT-401', password: 'paralian2025' } });
  assert.equal(r.status, 403);
});

/* ── Admin: bookings lifecycle ──────────────────────── */

test('create → check in → check out → settle a booking', async () => {
  const token = await staffLogin();
  const created = await req('POST', '/api/admin/bookings', {
    token,
    body: { first_name: 'Test', last_name: 'Guest', checkin: today(0), checkout: today(2), room: 'classic', guests: 2 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const b = created.data;
  assert.match(b.ref, /^PRL-\d{3}$/);
  assert.equal(b.total_usd, 95 * 2);
  assert.equal(b.balance_usd, 95 * 2);
  assert.equal(b.display_status, 'Arriving');

  const inRes = await req('POST', `/api/admin/bookings/${b.ref}/check-in`, { token });
  assert.equal(inRes.status, 200);
  assert.equal(inRes.data.status, 'checked_in');
  const rooms = (await req('GET', '/api/admin/rooms', { token })).data;
  assert.equal(rooms.find(r => r.number === b.room_number).status, 'occupied');

  const outRes = await req('POST', `/api/admin/bookings/${b.ref}/check-out`, { token });
  assert.equal(outRes.data.status, 'checked_out');
  assert.equal(outRes.data.display_status, 'Pending Payment');
  const hk = (await req('GET', '/api/admin/housekeeping', { token })).data;
  assert.equal(hk.find(r => r.number === b.room_number).clean_status, 'due');

  const settled = await req('POST', `/api/admin/bookings/${b.ref}/settle`, { token, body: {} });
  assert.equal(settled.data.balance_usd, 0);
  assert.equal(settled.data.display_status, 'Checked Out');
});

test('double-booking a specific room is refused; filling a type returns 409', async () => {
  const token = await staffLogin();
  const dates = { checkin: today(40), checkout: today(42) };
  const first = await req('POST', '/api/admin/bookings', { token, body: { guest_name: 'One', room: 'nest', ...dates } });
  assert.equal(first.status, 201);
  // Only one Nest room exists.
  const second = await req('POST', '/api/admin/bookings', { token, body: { guest_name: 'Two', room: 'nest', ...dates } });
  assert.equal(second.status, 409);
  // Back-to-back stays are fine (check-out day = next check-in day).
  const third = await req('POST', '/api/admin/bookings', {
    token, body: { guest_name: 'Three', room: 'nest', checkin: today(42), checkout: today(44) },
  });
  assert.equal(third.status, 201);
  // Cancelling frees the room again.
  await req('POST', `/api/admin/bookings/${first.data.ref}/cancel`, { token });
  const fourth = await req('POST', '/api/admin/bookings', { token, body: { guest_name: 'Four', room: 'nest', ...dates } });
  assert.equal(fourth.status, 201);
});

test('booking respects room capacity', async () => {
  const token = await staffLogin();
  const r = await req('POST', '/api/admin/bookings', {
    token, body: { guest_name: 'Big Party', room: 'nest', guests: 3, checkin: today(50), checkout: today(51) },
  });
  assert.equal(r.status, 400);
});

test('cannot put an occupied room into maintenance', async () => {
  const token = await staffLogin();
  const r = await req('PATCH', '/api/admin/rooms/401', { token, body: { status: 'maintenance' } });
  assert.equal(r.status, 409);
  const ok = await req('PATCH', '/api/admin/rooms/402', { token, body: { status: 'maintenance' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'maintenance');
});

test('overview reflects seeded data', async () => {
  const token = await staffLogin();
  const o = (await req('GET', '/api/admin/overview', { token })).data;
  assert.equal(o.rooms.total, 22);
  assert.ok(o.arrivals.some(a => a.guest_name === 'Lena Hartmann'));
  assert.ok(o.departures.some(d => d.guest_name === 'Priya Nair' && d.balance_usd === 240));
  assert.ok(o.open_requests.length >= 2);
});

/* ── Tenant portal ──────────────────────────────────── */

test('tenant submits cleaning and maintenance; staff sees and resolves them', async () => {
  const tenant = await tenantLogin('APT-202');
  const clean = await req('POST', '/api/tenant/cleaning', {
    token: tenant,
    body: { service_type: 'deep', areas: ['Kitchen'], preferred_date: today(3), time_slot: '1–3 PM' },
  });
  assert.equal(clean.status, 201, JSON.stringify(clean.data));
  assert.deepEqual(clean.data.areas, ['Kitchen']);

  const badSlot = await req('POST', '/api/tenant/cleaning', {
    token: tenant, body: { service_type: 'linen', preferred_date: today(3), time_slot: 'midnight' },
  });
  assert.equal(badSlot.status, 400);

  const maint = await req('POST', '/api/tenant/maintenance', {
    token: tenant, body: { category: 'Plumbing', description: 'Bathroom sink is blocked. Water pools.', priority: 'high' },
  });
  assert.equal(maint.status, 201);
  assert.equal(maint.data.title, 'Bathroom sink is blocked');

  const hist = (await req('GET', '/api/tenant/history', { token: tenant })).data;
  assert.equal(hist.length, 2);

  const staff = await staffLogin();
  const list = (await req('GET', '/api/admin/maintenance?scope=residence&status=open', { token: staff })).data;
  const mine = list.find(m => m.id === maint.data.id);
  assert.equal(mine.location, 'APT-202');
  await req('PATCH', `/api/admin/maintenance/${mine.id}`, { token: staff, body: { status: 'resolved', notes: 'Cleared trap' } });

  const after = (await req('GET', '/api/tenant/history', { token: tenant })).data;
  assert.equal(after.find(h => h.kind === 'maintenance').status, 'done');
});

test('tenant only sees their own data', async () => {
  const t101 = await tenantLogin('APT-101');
  const t302 = await tenantLogin('APT-302');
  const pk101 = (await req('GET', '/api/tenant/packages', { token: t101 })).data;
  const pk302 = (await req('GET', '/api/tenant/packages', { token: t302 })).data;
  assert.ok(pk101.every(p => p.tenant_apt === 'APT-101'));
  assert.ok(pk302.every(p => p.tenant_apt === 'APT-302'));
  assert.equal(pk302.length, 1);

  const bill = (await req('GET', '/api/tenant/billing', { token: t101 })).data;
  assert.ok(bill.current);
  assert.equal(bill.current.tenant_apt, 'APT-101');
  assert.equal(bill.history.length, 5);
});

test('tenant dashboard summary', async () => {
  const token = await tenantLogin('APT-101');
  const me = (await req('GET', '/api/tenant/me', { token })).data;
  assert.equal(me.tenant.name, 'Ahmed Hassan');
  assert.equal(me.summary.packages_arrived, 1);
  assert.ok(me.summary.amount_due_mvr > 0);
  assert.ok(me.announcement);
  assert.equal(me.recent_requests.length, 3);
});

test('tenant password change signs out other sessions', async () => {
  const a = await tenantLogin('APT-201');
  const b = await tenantLogin('APT-201');
  const r = await req('POST', '/api/tenant/password', {
    token: a, body: { current_password: 'paralian2025', new_password: 'new-secret-123' },
  });
  assert.equal(r.status, 204);
  assert.equal((await req('GET', '/api/tenant/me', { token: a })).status, 200);
  assert.equal((await req('GET', '/api/tenant/me', { token: b })).status, 401);
  const login = await req('POST', '/api/auth/tenant/login', { body: { apt: 'APT-201', password: 'new-secret-123' } });
  assert.equal(login.status, 200);
});

/* ── Static site ────────────────────────────────────── */

test('serves the website but not backend files', async () => {
  assert.equal((await fetch(base + '/hotel/rooms.html')).status, 200);
  assert.equal((await fetch(base + '/server/db.js')).status, 404);
  assert.equal((await fetch(base + '/package.json')).status, 404);
  assert.equal((await fetch(base + '/test/api.test.js')).status, 404);
});

/* ── Database upgrade ───────────────────────────────── */

test('older databases gain the new enquiry columns on startup', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb } = require('../server/db');
  const file = require('node:path').join(require('node:os').tmpdir(), `paralian-migrate-${process.pid}.db`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE enquiries (id INTEGER PRIMARY KEY AUTOINCREMENT, check_in TEXT NOT NULL, check_out TEXT NOT NULL,
    type_code TEXT, guests INTEGER NOT NULL, name TEXT, email TEXT, status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  old.exec("INSERT INTO enquiries (check_in, check_out, guests) VALUES ('2026-01-01', '2026-01-02', 1)");
  old.close();
  try {
    const db = openDb(file);
    const cols = db.prepare('PRAGMA table_info(enquiries)').all().map(c => c.name);
    assert.ok(cols.includes('phone') && cols.includes('booking_ref'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 1);
    db.close();
  } finally {
    for (const ext of ['', '-wal', '-shm']) require('node:fs').rmSync(file + ext, { force: true });
  }
});
