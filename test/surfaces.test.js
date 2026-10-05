'use strict';

/*
 * The staff portal must not be reachable from the public website, and the staff
 * server must expose nothing but the staff portal.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../server/app');
const { openDb } = require('../server/db');
const { seed } = require('../server/seed');

const staticRoot = path.join(__dirname, '..');
const servers = [];
let pub, staff, locked;

async function listen(app) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  const db = openDb(':memory:');
  seed(db);
  const base = { db, seedData: false, staticRoot, sessionTtlHours: 1 };
  pub = await listen(createApp({ ...base, surface: 'public' }));
  staff = await listen(createApp({ ...base, surface: 'staff' }));
  locked = await listen(createApp({ ...base, surface: 'staff', adminAllowedIps: ['203.0.113.7'], trustProxy: false }));
});

after(() => Promise.all(servers.map(s => new Promise(r => s.close(r)))));

const get = (url, opts) => fetch(url, { redirect: 'manual', ...opts });
const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const staffCreds = { username: 'admin', password: 'paralian2025' };
const tenantCreds = { apt: 'APT-101', password: 'paralian2025' };

/* ── Public website ─────────────────────────────────── */

test('public site serves the website and the tenant portal', async () => {
  for (const p of ['/', '/hotel/', '/hotel/rooms.html', '/residence/tenant.html', '/residence/tenant.js', '/assets/js/api.js']) {
    assert.equal((await get(pub + p)).status, 200, p);
  }
  assert.equal((await post(pub + '/api/auth/tenant/login', tenantCreds)).status, 200);
});

test('public site does not serve the staff portal pages, however the path is written', async () => {
  for (const p of ['/admin', '/admin/', '/admin/index.html', '/admin/admin.js', '/ADMIN/', '/%61dmin/',
    '//admin/', '/hotel/../admin/', '/admin%2findex.html']) {
    const res = await get(pub + p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(await res.text(), /Staff Portal/i, p);
  }
});

test('public site has no staff API or staff login', async () => {
  assert.equal((await post(pub + '/api/auth/staff/login', staffCreds)).status, 404);
  assert.equal((await get(pub + '/api/admin/overview')).status, 404);
  assert.equal((await get(pub + '/api/admin/bookings')).status, 404);
});

test('a staff token is useless on the public site', async () => {
  const { token } = await (await post(staff + '/api/auth/staff/login', staffCreds)).json();
  const auth = { headers: { authorization: `Bearer ${token}` } };
  assert.equal((await get(pub + '/api/admin/overview', auth)).status, 404);
  assert.equal((await get(pub + '/api/auth/me', auth)).status, 401);
});

test('public website pages contain no links to the staff portal', async () => {
  for (const p of ['/', '/hotel/', '/hotel/rooms.html', '/hotel/about.html', '/hotel/cafe.html',
    '/hotel/activities.html', '/residence/', '/residence/explore.html', '/residence/tenant.html']) {
    const html = await (await get(pub + p)).text();
    assert.doesNotMatch(html, /href="[^"]*admin/i, p);
    assert.doesNotMatch(html, /staff portal/i, p);
  }
});

test('tenant login page does not list residents', async () => {
  const html = await (await get(pub + '/residence/tenant.html')).text();
  for (const name of ['Ahmed Hassan', 'Mariyam Khalid', 'Zaha Waheed']) assert.doesNotMatch(html, new RegExp(name), name);
});

/* ── Staff server ───────────────────────────────────── */

test('staff server serves the staff portal and its API', async () => {
  const root = await get(staff + '/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/admin/');
  const page = await get(staff + '/admin/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await get(staff + '/assets/js/api.js')).status, 200);
  const login = await post(staff + '/api/auth/staff/login', staffCreds);
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.equal((await get(staff + '/api/admin/overview', { headers: { authorization: `Bearer ${token}` } })).status, 200);
});

test('staff server exposes nothing else', async () => {
  for (const p of ['/hotel/', '/index.html', '/residence/tenant.html', '/server/db.js', '/package.json', '/assets/../server/db.js']) {
    assert.equal((await get(staff + p)).status, 404, p);
  }
  assert.equal((await post(staff + '/api/enquiries', { checkin: '2030-01-01', checkout: '2030-01-02', name: 'x', email: 'x@y.co' })).status, 404);
  assert.equal((await post(staff + '/api/contact', { first_name: 'a', last_name: 'b', email: 'a@b.co', message: 'hi' })).status, 404);
  assert.equal((await post(staff + '/api/auth/tenant/login', tenantCreds)).status, 404);
  const { token } = await (await post(pub + '/api/auth/tenant/login', tenantCreds)).json();
  assert.equal((await get(staff + '/api/tenant/me', { headers: { authorization: `Bearer ${token}` } })).status, 404);
});

test('staff IP allow-list hides the portal from everyone else', async () => {
  // The test client connects from 127.0.0.1, which is not on the list.
  assert.equal((await get(locked + '/admin/')).status, 404);
  assert.equal((await post(locked + '/api/auth/staff/login', staffCreds)).status, 404);
  // With no trusted proxy, a forged X-Forwarded-For header cannot impersonate an allowed IP.
  const spoofed = await get(locked + '/admin/', { headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(spoofed.status, 404);
});
