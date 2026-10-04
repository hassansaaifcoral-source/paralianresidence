/* ═══════════════════════════════════════════════════════════
   PARALIAN RESIDENCE — Tenant portal (talks to /api/tenant/*)
   ═══════════════════════════════════════════════════════════ */
const { esc, fmtDate, fmtMoney, hotelToday } = window.ParalianAPI;
const api = window.ParalianAPI.session('paralian-tenant-token');
const $ = id => document.getElementById(id);

/* ── Auth ── */
async function doLogin() {
  const apt = $('aptSelect').value;
  const password = $('aptPassword').value;
  const err = $('loginError');
  err.classList.remove('visible');
  if (!apt || !password) { err.textContent = 'Please choose your apartment and enter your password.'; err.classList.add('visible'); return; }
  try {
    const res = await window.ParalianAPI.request('POST', '/auth/tenant/login', { body: { apt, password } });
    api.set(res.token);
    showPortal();
  } catch (e) {
    err.textContent = e.message;
    err.classList.add('visible');
  }
}

async function doLogout() {
  try { await api.call('POST', '/auth/logout'); } catch { /* already signed out */ }
  showLogin();
}

function showLogin(message) {
  api.clear();
  $('loginScreen').classList.remove('hidden');
  $('portal').classList.remove('active');
  $('aptPassword').value = '';
  if (message) { $('loginError').textContent = message; $('loginError').classList.add('visible'); }
}

/** Calls the tenant API, handling expired sessions and surfacing errors as toasts. */
async function call(method, path, body) {
  try {
    return await api.call(method, '/tenant' + path, body);
  } catch (err) {
    if (err.status === 401) showLogin('Your session has expired. Please sign in again.');
    else showToast(err.message, 'error', 4000);
    throw err;
  }
}

async function showPortal() {
  const me = await call('GET', '/me');
  const t = me.tenant;
  const first = t.name.split(' ')[0];
  $('loginScreen').classList.add('hidden');
  $('portal').classList.add('active');
  $('tenantName').textContent = t.name;
  $('tenantApt').textContent = t.apt_id + ' · ' + t.floor;
  $('topbarName').textContent = first;

  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  $('dashGreet').textContent = greet + ', ' + first + ' 👋';
  $('dashSub').textContent = `Here's a summary of your apartment (${t.apt_id}) activity.`;

  renderDashboard(me);

  $('cleanDate').min = hotelToday();
  $('cleanDate').value = '';
}

function renderDashboard(me) {
  const s = me.summary;
  $('statOpen').textContent = s.open_requests;
  $('statDue').textContent = fmtMoney(s.amount_due_mvr);
  $('statPackages').textContent = s.packages_arrived ? `${s.packages_arrived} Arrived` : 'None';
  $('statCleaning').textContent = s.next_cleaning ? fmtDate(s.next_cleaning.preferred_date, { day: 'numeric', month: 'short' }) : '—';
  $('recentList').innerHTML = me.recent_requests.length
    ? me.recent_requests.map(r => requestItem(r, true)).join('')
    : '<li class="request-item"><div class="request-info"><p>No requests yet.</p></div></li>';
  const a = me.announcement;
  $('dashAnnounce').style.display = a ? '' : 'none';
  if (a) {
    $('announceTitle').textContent = '📢 ' + a.title;
    $('announceBody').textContent = a.body;
  }
}

// Resume an existing session; Enter key on password.
window.addEventListener('DOMContentLoaded', () => {
  if (api.token) showPortal().catch(() => {});
  $('aptPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});

/* ── Navigation ── */
const PAGE_TITLES = {
  dashboard: 'Overview',
  cleaning: 'Request Cleaning',
  maintenance: 'Maintenance',
  history: 'Request History',
  billing: 'Billing',
  packages: 'Packages & Deliveries',
  notices: 'Notices & Announcements'
};

const LOADERS = {
  dashboard: async () => renderDashboard(await call('GET', '/me')),
  history: loadHistory,
  billing: loadBilling,
  packages: loadPackages,
  notices: loadNotices,
};

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  $('section-' + id).classList.add('active');
  $('topbarTitle').textContent = PAGE_TITLES[id] || id;
  document.querySelectorAll('.sidebar-nav a').forEach(a => {
    if (a.getAttribute('onclick')?.includes(id)) a.classList.add('active');
  });
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (LOADERS[id]) LOADERS[id]().catch(() => {});
}

/* ── Sidebar mobile ── */
function toggleSidebar() {
  $('sidebar').classList.toggle('open');
  $('sidebarOverlay').classList.toggle('open');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebarOverlay').classList.remove('open');
}

/* ── Request lists ── */
const STATUS = {
  pending: ['pending', 'Pending'],
  in_progress: ['progress', 'In Progress'],
  done: ['done', 'Done'],
  cancelled: ['done', 'Cancelled'],
};

function requestItem(r, short = false) {
  const [cls, label] = STATUS[r.status] || STATUS.pending;
  const parts = [`Requested ${fmtDate(r.created_at, { day: 'numeric', month: 'short', year: short ? undefined : 'numeric' })}`];
  if (r.kind === 'cleaning' && r.status !== 'done' && r.scheduled_date) {
    parts.push(`Scheduled for ${fmtDate(r.scheduled_date, { day: 'numeric', month: 'short' })}${r.time_slot ? ', ' + r.time_slot : ''}`);
  }
  if (r.kind === 'maintenance' && !short && r.priority) parts.push('Priority: ' + r.priority.charAt(0).toUpperCase() + r.priority.slice(1));
  if (r.completed_at) parts.push(`Completed ${fmtDate(r.completed_at, { day: 'numeric', month: 'short', year: short ? undefined : 'numeric' })}`);
  if (r.notes && !short && r.status === 'done') parts.push(r.notes);
  return `
    <li class="request-item">
      <div class="request-dot ${cls}"></div>
      <div class="request-info">
        <h4>${esc(r.title)}</h4>
        <p>${esc(parts.join(' · '))}</p>
      </div>
      <span class="request-status ${cls}">${label}</span>
    </li>`;
}

async function loadHistory() {
  const rows = await call('GET', '/history');
  $('historyList').innerHTML = rows.length ? rows.map(r => requestItem(r)).join('')
    : '<li class="request-item"><div class="request-info"><p>You have not made any requests yet.</p></div></li>';
}

/* ── Billing ── */
async function loadBilling() {
  const b = await call('GET', '/billing');
  const period = p => fmtDate(p + '-15', { month: 'long', year: 'numeric' });
  const row = (label, amount, paid) =>
    `<div class="bill-row"><span class="bill-label">${esc(label)}</span><span class="bill-amount${paid ? ' paid' : ''}">${esc(amount)}</span></div>`;

  if (b.current) {
    $('billTitle').textContent = `${period(b.current.period)} — Statement`;
    const prior = b.outstanding_mvr - b.current.total_mvr;
    $('billCurrent').innerHTML =
      b.current.line_items.map(i => row(i.label, fmtMoney(i.amount_mvr))).join('') +
      row('Prior Balance', prior > 0 ? fmtMoney(prior) : 'MVR 0 (Cleared)', prior <= 0) +
      `<div class="bill-total"><span class="tl">Total Due — ${esc(fmtDate(b.current.due_date, { day: 'numeric', month: 'short', year: 'numeric' }))}</span>
       <span class="ta">${esc(fmtMoney(b.outstanding_mvr))}</span></div>`;
  } else {
    $('billTitle').textContent = 'Current Statement';
    $('billCurrent').innerHTML = row('Balance', 'MVR 0 — all paid ✓', true);
  }
  $('billHistory').innerHTML = b.history.length
    ? b.history.map(i => row(`${period(i.period)}`, fmtMoney(i.total_mvr) + ' ✓', true)).join('')
    : row('No payments yet', '—');
}

/* ── Packages ── */
const PKG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';

async function loadPackages() {
  const rows = await call('GET', '/packages');
  $('packageList').innerHTML = rows.length ? rows.map(p => {
    const arrived = p.status === 'arrived';
    const when = arrived ? `Arrived ${fmtDate(p.arrived_at)} · Held at front desk`
      : `Expected ${fmtDate(p.expected_at)} · On the way`;
    return `
      <div class="package-item">
        <div class="pkg-icon">${PKG_ICON}</div>
        <div class="pkg-info"><h4>${esc(p.carrier)} — ${esc(p.description)}</h4><p>${esc(when)}</p></div>
        <span class="pkg-badge ${arrived ? 'arrived' : 'pending'}">${arrived ? 'Ready for pickup' : 'On the way'}</span>
      </div>`;
  }).join('') : '<p style="font-size:14px;color:var(--text-m);padding:12px 0;">No packages waiting for you.</p>';
}

/* ── Notices ── */
async function loadNotices() {
  const rows = await call('GET', '/notices');
  $('noticeList').innerHTML = rows.map(n => `
    <div class="card">
      <div class="card-header"${n.important ? ' style="background:rgba(200,89,79,0.06);"' : ''}>
        <h3${n.important ? ' style="color:var(--coral);"' : ''}>${n.important ? '⚠ ' : ''}${esc(n.title)}</h3>
      </div>
      <div class="card-body">
        <p style="font-size:14px;line-height:1.7;color:var(--text-m);">${esc(n.body)}</p>
        <p style="font-size:12px;color:var(--text-l);margin-top:10px;">Posted: ${esc(fmtDate(n.posted_at, { day: 'numeric', month: 'short', year: 'numeric' }))} · ${esc(n.posted_by)}</p>
      </div>
    </div>`).join('') || '<p style="color:var(--text-m)">No notices right now.</p>';
}

/* ── Cleaning ── */
let cleaningType = 'standard';

function selectCleaningType(el, type) {
  document.querySelectorAll('#cleaningTypes .request-type-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  cleaningType = type;
}

function toggleCheck(el) {
  el.classList.toggle('checked');
}

function selectTime(el) {
  if (el.classList.contains('unavailable')) return;
  document.querySelectorAll('.time-slot').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

async function submitCleaning() {
  const date = $('cleanDate').value;
  if (!date) { showToast('Please select a preferred date.', 'error'); return; }
  const areas = [...document.querySelectorAll('#cleaningChecklist .check-item.checked')]
    .map(el => el.querySelector('.check-label').textContent);
  if (!areas.length && ['standard', 'deep'].includes(cleaningType)) {
    showToast('Please tick at least one area to clean.', 'error'); return;
  }
  try {
    await call('POST', '/cleaning', {
      service_type: cleaningType,
      areas,
      preferred_date: date,
      time_slot: document.querySelector('.time-slot.selected')?.textContent.trim(),
      notes: $('cleanNotes').value.trim() || undefined,
    });
  } catch { return; }
  showToast('✓ Cleaning request submitted! We\'ll confirm via WhatsApp shortly.', 'success', 4000);
  $('cleanDate').value = '';
  $('cleanNotes').value = '';
  document.querySelectorAll('#cleaningChecklist .check-item').forEach(el => el.classList.remove('checked'));
  setTimeout(() => showSection('history'), 1500);
}

/* ── Maintenance ── */
function selectMaintType(el) {
  document.querySelectorAll('.section#section-maintenance .request-type-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}

function selectPriority(el) {
  document.querySelectorAll('.priority-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

async function submitMaintenance() {
  const description = $('maintDesc').value.trim();
  if (!description) { showToast('Please describe the issue before submitting.', 'error'); return; }
  try {
    await call('POST', '/maintenance', {
      category: document.querySelector('#section-maintenance .request-type-btn.selected .rt-label')?.textContent,
      description,
      priority: document.querySelector('.priority-chip.selected')?.dataset.p || 'low',
      preferred_time: $('maintTime').value || undefined,
      notes: $('maintNotes').value.trim() || undefined,
    });
  } catch { return; }
  showToast('✓ Maintenance request received! A technician will contact you within 24 hours.', 'success', 4000);
  $('maintDesc').value = '';
  $('maintNotes').value = '';
  setTimeout(() => showSection('history'), 1500);
}

/* ── Toast ── */
function showToast(msg, type = 'info', duration = 3000) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), duration);
}
