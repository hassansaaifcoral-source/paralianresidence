/* ═══════════════════════════════════════════════════════════
   PARALIAN — Staff dashboard (talks to /api/admin/*)
   ═══════════════════════════════════════════════════════════ */
const { esc, fmtDate, fmtTime, fmtMoney, hotelToday } = window.ParalianAPI;
const api = window.ParalianAPI.session('paralian-admin-token');

const $ = id => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const titleCase = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/* ── Auth ──────────────────────────────── */
async function doLogin() {
  const username = $('login-user').value.trim().toLowerCase();
  const password = $('login-pass').value;
  $('login-err').textContent = '';
  if (!username || !password) { $('login-err').textContent = 'Please enter your username and password.'; return; }
  try {
    const res = await window.ParalianAPI.request('POST', '/auth/staff/login', { body: { username, password } });
    api.set(res.token);
    enterDashboard(res.user);
  } catch (err) {
    $('login-err').textContent = err.message;
  }
}

$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function enterDashboard(user) {
  $('login-screen').classList.add('hidden');
  $('dashboard').classList.add('active');
  if (user) {
    $('user-name').textContent = user.display_name;
    $('user-role').textContent = user.role;
    $('user-avatar').textContent = user.display_name.charAt(0).toUpperCase();
  }
  setDate();
  loadOverview();
  loadMaintenanceFormOptions();
}

async function doLogout() {
  try { await api.call('POST', '/auth/logout'); } catch { /* already signed out */ }
  showLogin();
}

function showLogin(message = '') {
  api.clear();
  $('login-screen').classList.remove('hidden');
  $('dashboard').classList.remove('active');
  $('login-user').value = '';
  $('login-pass').value = '';
  $('login-err').textContent = message;
}

// Resume an existing session.
(async function resume() {
  if (!api.token) return;
  try {
    const me = await api.call('GET', '/auth/me');
    if (me.kind === 'staff') enterDashboard(me.user); else showLogin();
  } catch { showLogin(); }
})();

/** Calls the admin API, handling expired sessions and surfacing errors as toasts. */
async function call(method, path, body) {
  try {
    return await api.call(method, '/admin' + path, body);
  } catch (err) {
    if (err.status === 401) showLogin('Your session has expired. Please sign in again.');
    else showToast(err.message, 'error');
    throw err;
  }
}

/* ── Navigation ────────────────────────── */
const pageTitles = {
  overview: 'Dashboard', bookings: 'Bookings', rooms: 'Room Status',
  guests: 'Current Guests', maintenance: 'Maintenance', housekeeping: 'Housekeeping',
  'cafe-orders': 'Café Orders', tenants: 'Tenants', 'new-booking': 'New Booking',
  inbox: 'Website Inbox', cleaning: 'Cleaning Requests'
};

const loaders = {
  overview: () => loadOverview(),
  bookings: () => loadBookings(),
  rooms: () => initRoomGrid(),
  guests: () => loadGuests(),
  maintenance: () => loadMaintenance(),
  housekeeping: () => loadHousekeeping(),
  'cafe-orders': () => loadCafe(),
  tenants: () => loadTenants(),
  'new-booking': () => resetBookingForm(),
  inbox: () => loadInbox(),
  cleaning: () => loadCleaning(),
};

function showPage(id, navEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pg = $('page-' + id);
  if (pg) pg.classList.add('active');
  if (navEl) navEl.classList.add('active');
  $('page-title').textContent = pageTitles[id] || id;
  closeSidebar();
  if (loaders[id]) loaders[id]().catch(() => {});
}

const navTo = id => showPage(id, document.querySelector(`.nav-item[onclick*="'${id}'"]`));

/* ── Sidebar Mobile ────────────────────── */
function toggleSidebar() {
  $('sidebar').classList.toggle('open');
  $('overlay').classList.toggle('open');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('overlay').classList.remove('open');
}

/* ── Date ──────────────────────────────── */
function setDate() {
  $('topbar-date').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── Shared renderers ──────────────────── */
const STATUS_BADGE = {
  'Active': 'badge-green', 'Checked In': 'badge-green', 'Paid': 'badge-green', 'Checked Out': 'badge-gray',
  'Arriving': 'badge-amber', 'Pending': 'badge-amber', 'Upcoming': 'badge-blue',
  'Pending Payment': 'badge-red', 'Cancelled': 'badge-gray',
};
const badge = (label, cls) => `<span class="badge ${cls || STATUS_BADGE[label] || 'badge-gray'}">${esc(label)}</span>`;
const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="empty-cell">${esc(msg)}</td></tr>`;
const roomLabel = b => `${esc(b.type_name.split(' ')[0])} ${esc(b.room_number || '')}`;

function updateNavBadges(counts) {
  const set = (id, n) => { const el = $(id); el.textContent = n; el.style.display = n ? '' : 'none'; };
  set('badge-bookings', counts.upcoming_bookings);
  set('badge-maintenance', counts.open_maintenance);
  set('badge-inbox', counts.new_enquiries + counts.new_messages);
  set('badge-cleaning', counts.pending_cleaning);
}

/** Re-reads the overview counts so the sidebar badges stay current after an action. */
const refreshBadges = () => call('GET', '/overview').then(o => updateNavBadges(o.counts)).catch(() => {});

function requestItem(m, { compact = false } = {}) {
  const resolved = m.status === 'resolved';
  const prio = { high: ['High Priority', 'badge-red'], medium: ['Medium Priority', 'badge-amber'], low: ['Low Priority', 'badge-green'] }[m.priority];
  const meta = `${esc(m.location)} · ${fmtDate(m.created_at)}, ${fmtTime(m.created_at)} · Assigned: ${esc(m.assigned_to || 'Unassigned')}`;
  const btn = resolved
    ? '<button class="btn-sm ghost" disabled style="opacity:.4">Done</button>'
    : `<button class="btn-sm ${m.priority === 'high' ? 'primary' : 'ghost'}" onclick="resolveRequest(this, ${m.id})">Resolve</button>`;
  return `
    <div class="request-item">
      <div class="request-dot ${resolved ? 'low' : esc(m.priority)}"></div>
      <div class="request-body">
        <strong>${esc(m.title)} — ${esc(m.location)}</strong>
        <p>${esc(m.description)}</p>
        <div class="request-meta">${meta}</div>
      </div>
      ${compact ? btn : `<div style="display:flex;gap:.5rem;flex-direction:column;align-items:flex-end">
        ${resolved ? badge('Resolved', 'badge-green') : badge(prio[0], prio[1])}${btn}</div>`}
    </div>`;
}

/* ── Overview ──────────────────────────── */
async function loadOverview() {
  const o = await call('GET', '/overview');
  $('stat-occupied').textContent = o.rooms.occupied;
  $('stat-occupied-sub').textContent = `of ${o.rooms.total} rooms tonight`;
  $('stat-occupancy').textContent = o.rooms.occupancy_rate + '%';
  $('stat-occupancy-sub').textContent = `${plural(o.rooms.maintenance, 'room')} in maintenance`;
  const inHouse = o.arrivals.filter(a => a.status === 'checked_in').length;
  $('stat-checkins').textContent = o.arrivals.length;
  $('stat-checkins-sub').textContent = `${o.arrivals.length - inHouse} pending, ${inHouse} checked in`;
  $('stat-revenue').textContent = fmtMoney(o.revenue_month_usd, 'USD');
  $('stat-revenue-sub').textContent = `${o.counts.new_enquiries} new enquiries · ${o.counts.new_messages} messages`;

  $('arrivals-count').textContent = plural(o.arrivals.length, 'guest');
  $('arrivals-body').innerHTML = o.arrivals.length ? o.arrivals.map(b => `
    <tr><td>${esc(b.guest_name)}</td><td>${roomLabel(b)}</td><td>${esc(b.eta || '—')}</td>
    <td>${b.status === 'checked_in' ? badge('Checked In')
      : `<button class="btn-sm primary" onclick="checkIn('${esc(b.ref)}')">Check In</button>`}</td></tr>`).join('')
    : emptyRow(4, 'No arrivals today');

  const open = o.open_requests;
  $('requests-count').textContent = `${open.length} open`;
  $('overview-requests').innerHTML = open.length
    ? open.slice(0, 5).map(m => requestItem(m, { compact: true })).join('')
    : '<div class="empty-cell">No open requests 🎉</div>';

  $('departures-count').textContent = plural(o.departures.length, 'check-out');
  $('departures-body').innerHTML = o.departures.length ? o.departures.map(b => {
    const bal = b.balance_usd > 0 ? `${fmtMoney(b.balance_usd, 'USD')} due` : '$0 — Paid';
    let action = badge(b.display_status === 'Active' ? 'Pending' : b.display_status);
    if (b.status === 'checked_in') action = `<button class="btn-sm ghost" onclick="checkOut('${esc(b.ref)}')">Check Out</button>`;
    if (b.balance_usd > 0) action = `<button class="btn-sm primary" onclick="settleBooking('${esc(b.ref)}')">Settle</button>`;
    return `<tr><td>${esc(b.guest_name)}</td><td>${roomLabel(b)}</td><td>${plural(b.nights, 'night')}</td><td>${bal}</td><td>${action}</td></tr>`;
  }).join('') : emptyRow(5, 'No departures today');

  updateNavBadges(o.counts);
}

/* ── Bookings ──────────────────────────── */
const bookingCache = {};

async function loadBookings() {
  const rows = await call('GET', '/bookings');
  rows.forEach(b => { bookingCache[b.ref] = b; });
  $('bookings-body').innerHTML = rows.length ? rows.map(b => `
    <tr><td>${esc(b.ref)}</td><td>${esc(b.guest_name)}</td><td>${roomLabel(b)}</td>
    <td>${fmtDate(b.check_in)}</td><td>${fmtDate(b.check_out)}</td><td>${b.guests}</td><td>${esc(b.source)}</td>
    <td>${badge(b.display_status === 'Pending Payment' ? 'Pending Pay' : b.display_status,
      STATUS_BADGE[b.display_status])}</td>
    <td>${b.balance_usd > 0 && b.status !== 'confirmed'
      ? `<button class="btn-sm primary" onclick="settleBooking('${esc(b.ref)}')">Settle</button>`
      : `<button class="btn-sm ghost" onclick="viewBooking('${esc(b.ref)}')">View</button>`}</td></tr>`).join('')
    : emptyRow(9, 'No bookings yet');
}

async function viewBooking(ref) {
  const b = await call('GET', '/bookings/' + encodeURIComponent(ref));
  bookingCache[ref] = b;
  $('bm-ref').textContent = b.ref;
  $('bm-guest').textContent = b.guest_name;
  $('bm-room').textContent = `${b.type_name} ${b.room_number || ''}`;
  $('bm-checkin').textContent = fmtDate(b.check_in, { weekday: 'short', month: 'short', day: 'numeric' });
  $('bm-checkout').textContent = fmtDate(b.check_out, { weekday: 'short', month: 'short', day: 'numeric' });
  $('bm-nights').textContent = plural(b.nights, 'night');
  $('bm-guests').textContent = plural(b.guests, 'guest');
  $('bm-source').textContent = b.source;
  const st = $('bm-status');
  st.textContent = b.display_status;
  st.className = 'badge ' + (STATUS_BADGE[b.display_status] || 'badge-gray');
  $('bm-balance').textContent = fmtMoney(b.balance_usd, 'USD');
  $('bm-balance-row').style.display = b.balance_usd > 0 ? '' : 'none';

  const actions = [];
  const today = hotelToday();
  if (b.status === 'confirmed' && b.check_in <= today) actions.push(['Check In', 'primary', 'checkIn']);
  if (b.status === 'checked_in') actions.push(['Check Out', 'outline', 'checkOut']);
  if (b.balance_usd > 0) actions.push(['Settle Balance', 'primary', 'settleBooking']);
  if (b.status === 'confirmed') actions.push(['Cancel Booking', 'ghost', 'cancelBooking']);
  $('bm-actions').innerHTML = actions.map(([label, cls, fn]) =>
    `<button class="btn-sm ${cls}" onclick="${fn}('${esc(b.ref)}')">${label}</button>`).join('');
  $('booking-modal').style.display = 'flex';
}

function closeBookingModal() {
  $('booking-modal').style.display = 'none';
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBookingModal(); });

/** Runs a booking action, then refreshes whichever views show bookings. */
async function bookingAction(ref, path, message, body) {
  const b = await call('POST', `/bookings/${encodeURIComponent(ref)}/${path}`, body);
  showToast(message(b), 'success');
  closeBookingModal();
  const active = document.querySelector('.page.active')?.id.replace('page-', '');
  if (loaders[active]) loaders[active]().catch(() => {});
}

const settleBooking = ref => bookingAction(ref, 'settle', b => `✓ Payment settled for ${b.guest_name}`).catch(() => {});
const checkIn = ref => bookingAction(ref, 'check-in', b => `✓ ${b.guest_name} checked in to ${b.room_number}`).catch(() => {});
const checkOut = ref => bookingAction(ref, 'check-out', b => `✓ ${b.guest_name} checked out`).catch(() => {});
function cancelBooking(ref) {
  if (!confirm(`Cancel booking ${ref}? This cannot be undone.`)) return;
  bookingAction(ref, 'cancel', b => `Booking ${b.ref} cancelled`).catch(() => {});
}

/* ── New booking ───────────────────────── */
let bookingFromEnquiry = null;

function resetBookingForm() {
  const today = hotelToday();
  $('nb-checkin').min = today;
  $('nb-checkout').min = today;
  if (!bookingFromEnquiry) $('nb-from-enquiry').style.display = 'none';
  return Promise.resolve();
}

$('nb-checkin').addEventListener('change', function () {
  if (this.value) $('nb-checkout').min = this.value;
});

async function saveBooking() {
  const body = {
    first_name: $('nb-first').value,
    last_name: $('nb-last').value,
    email: $('nb-email').value || undefined,
    phone: $('nb-phone').value || undefined,
    checkin: $('nb-checkin').value,
    checkout: $('nb-checkout').value,
    room: $('nb-room').value,
    guests: Number($('nb-guests').value),
    source: $('nb-source').value,
    payment_method: $('nb-payment').value,
    notes: $('nb-notes').value || undefined,
  };
  if (!body.first_name.trim() && !body.last_name.trim()) { showToast('Please enter the guest name', 'error'); return; }
  if (!body.checkin || !body.checkout) { showToast('Please choose check-in and check-out dates', 'error'); return; }
  try {
    const b = await call('POST', '/bookings', body);
    if (bookingFromEnquiry) {
      await call('PATCH', '/enquiries/' + bookingFromEnquiry, { status: 'booked', booking_ref: b.ref }).catch(() => {});
      bookingFromEnquiry = null;
    }
    showToast(`✓ Booking ${b.ref} created — room ${b.room_number}`, 'success');
    clearBookingForm();
    setTimeout(() => navTo('bookings'), 1200);
  } catch { /* toast already shown */ }
}

function clearBookingForm() {
  ['nb-first', 'nb-last', 'nb-email', 'nb-phone', 'nb-checkin', 'nb-checkout', 'nb-notes'].forEach(id => { $(id).value = ''; });
  $('nb-from-enquiry').style.display = 'none';
}

$('page-new-booking').querySelector('button.ghost').addEventListener('click', () => {
  bookingFromEnquiry = null;
  clearBookingForm();
});

/* ── Room Grid ─────────────────────────── */
let roomCache = [];

async function initRoomGrid() {
  roomCache = await call('GET', '/rooms');
  $('room-grid').innerHTML = roomCache.map(r => `
    <div class="room-tile ${esc(r.status)}" onclick="showRoomInfo('${esc(r.number)}')">
      <div class="room-num">${esc(r.number)}</div>
      <div class="room-type">${esc(r.type_name.split(' ')[0])}</div>
      <div class="room-status">${titleCase(r.status)}</div>
    </div>`).join('');
}

async function showRoomInfo(num) {
  const r = roomCache.find(x => x.number === num);
  if (!r) return;
  const who = r.guest_name ? ` · ${r.guest_name}` : '';
  if (r.status === 'occupied') {
    showToast(`Room ${r.number}  ·  ${r.type_name}  ·  Occupied${who}`, 'info');
    return;
  }
  const next = r.status === 'available' ? 'maintenance' : 'available';
  if (!confirm(`Room ${r.number} (${r.type_name}) is ${r.status}.\n\nMark it as ${next}?`)) return;
  try {
    await call('PATCH', '/rooms/' + encodeURIComponent(r.number), { status: next });
    showToast(`Room ${r.number} marked ${next}`, 'success');
    initRoomGrid();
  } catch { /* toast already shown */ }
}

/* ── Guests ────────────────────────────── */
async function loadGuests() {
  const rows = await call('GET', '/guests');
  $('guests-body').innerHTML = rows.length ? rows.map(g => `
    <tr><td>${esc(g.guest_name)}</td><td>${roomLabel(g)}</td><td>${fmtDate(g.check_in)}</td>
    <td>${fmtDate(g.check_out)}</td><td>${g.nights_left}</td><td>${esc(g.notes || '—')}</td></tr>`).join('')
    : emptyRow(6, 'No guests currently checked in');
}

/* ── Maintenance ───────────────────────── */
async function loadMaintenance() {
  const rows = await call('GET', '/maintenance');
  $('maintenance-list').innerHTML = rows.length ? rows.map(m => requestItem(m)).join('')
    : '<div class="empty-cell">No maintenance requests</div>';
}

async function resolveRequest(btn, id) {
  btn.disabled = true;
  try {
    await call('PATCH', '/maintenance/' + id, { status: 'resolved' });
    showToast('✓ Request resolved', 'success');
    const active = document.querySelector('.page.active')?.id.replace('page-', '');
    if (loaders[active]) loaders[active]().catch(() => {});
  } catch { btn.disabled = false; }
}

async function loadMaintenanceFormOptions() {
  try {
    const [rooms, tenants] = await Promise.all([call('GET', '/rooms'), call('GET', '/tenants')]);
    $('mf-room').innerHTML =
      `<optgroup label="Hotel">${rooms.map(r => `<option value="Room ${esc(r.number)}">Room ${esc(r.number)}</option>`).join('')}</optgroup>` +
      `<optgroup label="Residence">${tenants.map(t => `<option value="${esc(t.apt_id)}">${esc(t.apt_id)} — ${esc(t.name)}</option>`).join('')}</optgroup>`;
  } catch { /* handled by call() */ }
}

function openNewMaintenance() {
  const f = $('new-maintenance-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function submitMaintenance() {
  const description = $('mf-desc').value.trim();
  if (!description) { showToast('Please describe the issue', 'error'); return; }
  try {
    await call('POST', '/maintenance', {
      location: $('mf-room').value,
      priority: $('mf-priority').value,
      description,
      assigned_to: $('mf-assign').value,
    });
    $('mf-desc').value = '';
    $('new-maintenance-form').style.display = 'none';
    showToast('✓ Maintenance request logged', 'success');
    loadMaintenance();
  } catch { /* toast already shown */ }
}

/* ── Housekeeping ──────────────────────── */
async function loadHousekeeping() {
  const rows = await call('GET', '/housekeeping');
  $('housekeeping-body').innerHTML = rows.map(r => {
    const occupied = r.status === 'occupied';
    const status = r.status === 'maintenance' ? badge('Maintenance', 'badge-amber')
      : r.clean_status === 'due' ? badge('Due', 'badge-amber') : badge('Clean', 'badge-green');
    return `<tr><td>${esc(r.number)}</td><td>${esc(r.type_name.split(' ')[0])}</td>
      <td>${r.last_cleaned ? `${fmtDate(r.last_cleaned)} ${fmtTime(r.last_cleaned)}` : '—'}</td>
      <td>${status}${occupied ? ' ' + badge('Occupied', 'badge-red') : ''}</td><td>${esc(r.housekeeper || 'Unassigned')}</td>
      <td><button class="btn-sm ${r.clean_status === 'due' ? 'primary' : 'ghost'}" onclick="markClean(this, '${esc(r.number)}')">Mark Clean</button></td></tr>`;
  }).join('');
}

async function markClean(btn, number) {
  btn.disabled = true;
  try {
    await call('POST', `/housekeeping/${encodeURIComponent(number)}/clean`, {});
    showToast(`Room ${number} marked clean`, 'success');
    loadHousekeeping();
  } catch { btn.disabled = false; }
}

/* ── Café ──────────────────────────────── */
async function loadCafe() {
  const c = await call('GET', '/cafe-orders');
  $('cafe-count').textContent = c.stats.total_orders;
  $('cafe-revenue').textContent = fmtMoney(c.stats.revenue_mvr);
  $('cafe-avg').textContent = fmtMoney(c.stats.average_order_mvr);
  const label = { delivered: ['Delivered', 'badge-green'], in_progress: ['In Progress', 'badge-amber'], cancelled: ['Cancelled', 'badge-gray'] };
  $('cafe-body').innerHTML = c.orders.length ? c.orders.map(o => `
    <tr><td>#${String(o.id).padStart(3, '0')}</td><td>${esc(o.location)}</td><td>${esc(o.items)}</td>
    <td>${fmtMoney(o.total_mvr)}</td><td>${fmtTime(o.created_at)}</td>
    <td>${o.status === 'in_progress'
      ? `<button class="btn-sm ghost" onclick="deliverOrder(${o.id})">Mark Delivered</button>`
      : badge(...label[o.status])}</td></tr>`).join('')
    : emptyRow(6, 'No orders yet today');
}

async function deliverOrder(id) {
  try {
    await call('PATCH', '/cafe-orders/' + id, { status: 'delivered' });
    showToast('Order marked delivered', 'success');
    loadCafe();
  } catch { /* toast already shown */ }
}

/* ── Tenants ───────────────────────────── */
async function loadTenants() {
  const rows = await call('GET', '/tenants');
  const lease = { active: ['Active', 'badge-green'], renewal_due: ['Renewal Due', 'badge-amber'], expired: ['Expired', 'badge-red'] };
  $('tenants-body').innerHTML = rows.map(t => `
    <tr><td>${esc(t.apt_id)}</td><td>${esc(t.name)}</td><td>${esc(t.unit_type)}</td><td>${esc(t.floor.split(' ')[0])}</td>
    <td>${fmtDate(t.lease_end, { month: 'short', year: 'numeric' })}</td><td>${badge(...lease[t.lease_status])}</td>
    <td>${t.portal_active ? badge('Active', 'badge-blue') : badge('Inactive', 'badge-gray')}</td></tr>`).join('');
}

/* ── Website inbox ─────────────────────── */
const ENQ_STATUS = {
  new: ['New', 'badge-blue'], contacted: ['Contacted', 'badge-amber'],
  booked: ['Booked', 'badge-green'], closed: ['Closed', 'badge-gray'],
};
const MSG_STATUS = { new: ['New', 'badge-blue'], replied: ['Replied', 'badge-green'], closed: ['Closed', 'badge-gray'] };
const received = d => `${fmtDate(d)}, ${fmtTime(d)}`;
// Emails are validated server-side (no spaces or reserved characters), so the address itself needs no encoding.
const mailto = (email, subject) => `mailto:${email}?subject=${encodeURIComponent(subject)}`;
let enquiryCache = [];

async function loadInbox() {
  const [enquiries, messages] = await Promise.all([call('GET', '/enquiries'), call('GET', '/messages')]);
  enquiryCache = enquiries;

  const newEnq = enquiries.filter(e => e.status === 'new').length;
  $('enquiries-count').textContent = `${newEnq} new`;
  $('enquiries-body').innerHTML = enquiries.length ? enquiries.map(e => {
    const contact = e.email
      ? `<span class="cell-sub"><a href="${esc(mailto(e.email, 'Your Paralian stay enquiry'))}">${esc(e.email)}</a>${e.phone ? ' · ' + esc(e.phone) : ''}</span>`
      : '<span class="cell-sub">No contact details</span>';
    const stay = `${fmtDate(e.check_in)} – ${fmtDate(e.check_out)}`;
    const actions = [];
    if (e.status !== 'booked' && e.status !== 'closed') {
      actions.push(`<button class="btn-sm primary" onclick="bookFromEnquiry(${e.id})">Create Booking</button>`);
      if (e.status === 'new') actions.push(`<button class="btn-sm outline" onclick="setEnquiryStatus(${e.id}, 'contacted')">Mark Contacted</button>`);
      actions.push(`<button class="btn-sm ghost" onclick="setEnquiryStatus(${e.id}, 'closed')">Close</button>`);
    } else if (e.booking_ref) {
      actions.push(`<button class="btn-sm ghost" onclick="viewBooking('${esc(e.booking_ref)}')">View ${esc(e.booking_ref)}</button>`);
    } else {
      actions.push(`<button class="btn-sm ghost" onclick="setEnquiryStatus(${e.id}, 'new')">Reopen</button>`);
    }
    return `<tr><td>${received(e.created_at)}</td><td>${esc(e.name || '—')}${contact}</td><td>${stay}</td>
      <td>${esc(e.type_name || 'Any type')}</td><td>${e.guests}</td><td>${badge(...ENQ_STATUS[e.status])}</td>
      <td><div class="row-actions">${actions.join('')}</div></td></tr>`;
  }).join('') : emptyRow(7, 'No booking enquiries yet');

  const newMsg = messages.filter(m => m.status === 'new').length;
  $('messages-count').textContent = `${newMsg} new`;
  $('messages-list').innerHTML = messages.length ? messages.map(m => {
    const name = `${m.first_name} ${m.last_name}`;
    const replyLink = `<a class="btn-sm primary" style="text-decoration:none" href="${esc(mailto(m.email, 'Re: ' + (m.subject || 'Your message to Paralian')))}" onclick="setMessageStatus(${m.id}, 'replied', true)">Reply by Email</a>`;
    const actions = m.status === 'new'
      ? `${replyLink}<button class="btn-sm ghost" onclick="setMessageStatus(${m.id}, 'closed')">Close</button>`
      : `<button class="btn-sm ghost" onclick="setMessageStatus(${m.id}, 'new')">Reopen</button>`;
    return `
      <div class="request-item">
        <div class="request-dot ${m.status === 'new' ? 'medium' : 'low'}"></div>
        <div class="request-body">
          <strong>${esc(m.subject || 'General Enquiry')} — ${esc(name)}</strong>
          <p class="msg-text">${esc(m.message)}</p>
          <div class="request-meta">${received(m.created_at)} · <a href="${esc(mailto(m.email, 'Re: ' + (m.subject || 'Your message to Paralian')))}">${esc(m.email)}</a></div>
        </div>
        <div style="display:flex;gap:.5rem;flex-direction:column;align-items:flex-end">
          ${badge(...MSG_STATUS[m.status])}<div class="row-actions">${actions}</div>
        </div>
      </div>`;
  }).join('') : '<div class="empty-cell">No messages yet</div>';
}

async function setEnquiryStatus(id, status) {
  try {
    await call('PATCH', '/enquiries/' + id, { status });
    showToast(`Enquiry marked ${status}`, 'success');
    loadInbox().catch(() => {});
    refreshBadges();
  } catch { /* toast already shown */ }
}

async function setMessageStatus(id, status, quiet = false) {
  try {
    await call('PATCH', '/messages/' + id, { status });
    if (!quiet) showToast(`Message marked ${status}`, 'success');
    loadInbox().catch(() => {});
    refreshBadges();
  } catch { /* toast already shown */ }
}

/** Opens the New Booking form pre-filled from a website enquiry. */
function bookFromEnquiry(id) {
  const e = enquiryCache.find(x => x.id === id);
  if (!e) return;
  bookingFromEnquiry = id;
  navTo('new-booking');
  const [first, ...rest] = (e.name || '').split(' ');
  $('nb-first').value = first || '';
  $('nb-last').value = rest.join(' ');
  $('nb-email').value = e.email || '';
  $('nb-phone').value = e.phone || '';
  $('nb-checkin').value = e.check_in < hotelToday() ? '' : e.check_in;
  $('nb-checkout').value = e.check_out;
  if (e.type_code) $('nb-room').value = e.type_code;
  $('nb-guests').value = String(Math.min(e.guests, 4));
  $('nb-source').value = 'Direct';
  $('nb-notes').value = '';
  const banner = $('nb-from-enquiry');
  banner.textContent = `Creating a booking from ${e.name || 'a website'}'s enquiry. Check the details, then click Create Booking — the enquiry will be marked as booked.`;
  banner.style.display = '';
}

/* ── Residence cleaning requests ───────── */
const CLEAN_STATUS = {
  pending: ['Pending', 'badge-amber'], in_progress: ['In Progress', 'badge-blue'],
  done: ['Done', 'badge-green'], cancelled: ['Cancelled', 'badge-gray'],
};
const SERVICE = { standard: 'Standard Clean', deep: 'Deep Clean', linen: 'Linen Change', laundry: 'Laundry Service' };

async function loadCleaning() {
  const rows = await call('GET', '/cleaning-requests');
  $('cleaning-body').innerHTML = rows.length ? rows.map(c => {
    const actions = [];
    if (c.status === 'pending') actions.push(`<button class="btn-sm primary" onclick="setCleaningStatus(${c.id}, 'in_progress')">Start</button>`);
    if (c.status === 'in_progress') actions.push(`<button class="btn-sm primary" onclick="setCleaningStatus(${c.id}, 'done')">Mark Done</button>`);
    if (c.status === 'pending' || c.status === 'in_progress') {
      actions.push(`<button class="btn-sm ghost" onclick="cancelCleaning(${c.id})">Cancel</button>`);
    }
    return `<tr><td>${esc(c.tenant_apt)}</td><td>${esc(c.tenant_name)}</td><td>${esc(SERVICE[c.service_type] || c.service_type)}</td>
      <td>${esc(c.areas.join(', ') || '—')}</td>
      <td>${fmtDate(c.preferred_date, { weekday: 'short', day: 'numeric', month: 'short' })}${c.time_slot ? `<span class="cell-sub">${esc(c.time_slot)}</span>` : ''}</td>
      <td>${esc(c.notes || '—')}</td><td>${badge(...CLEAN_STATUS[c.status])}</td>
      <td><div class="row-actions">${actions.join('') || '—'}</div></td></tr>`;
  }).join('') : emptyRow(8, 'No cleaning requests');
}

async function setCleaningStatus(id, status) {
  try {
    await call('PATCH', '/cleaning-requests/' + id, { status });
    showToast(status === 'done' ? '✓ Cleaning marked done' : 'Cleaning started', 'success');
    loadCleaning().catch(() => {});
    refreshBadges();
  } catch { /* toast already shown */ }
}

function cancelCleaning(id) {
  if (!confirm('Cancel this cleaning request?')) return;
  setCleaningStatus(id, 'cancelled');
}

/* ── Toast ──────────────────────────────── */
function toastEl() {
  let t = $('admin-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'admin-toast';
    t.style.cssText = 'position:fixed;bottom:2rem;right:2rem;background:var(--navy);color:white;padding:1rem 1.5rem;border-radius:10px;font-size:.88rem;box-shadow:0 8px 32px rgba(0,0,0,.18);z-index:3000;transition:all .3s;transform:translateY(8px);opacity:0;font-family:Inter,sans-serif;';
    document.body.appendChild(t);
  }
  return t;
}

function showToast(msg, type) {
  const t = toastEl();
  t.textContent = msg;
  t.style.borderLeft = type === 'success' ? '3px solid #4CAF50'
    : type === 'info' ? '3px solid #2196F3' : '3px solid var(--coral)';
  t.style.opacity = '1'; t.style.transform = 'translateY(0)';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, 3000);
}
