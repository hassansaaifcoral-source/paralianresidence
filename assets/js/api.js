/* ═══════════════════════════════════════════════════════════
   PARALIAN — API client
   Set window.PARALIAN_API_BASE before this script loads if the
   backend is hosted on a different origin than the website.
   ═══════════════════════════════════════════════════════════ */
(function () {
  const BASE = (window.PARALIAN_API_BASE || '').replace(/\/$/, '') + '/api';

  class ApiError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  async function request(method, path, { body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, 'Could not reach the server. Please check your connection and try again.');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) {
      let msg = (data && data.error) || `Request failed (${res.status})`;
      if (data && data.details) {
        const first = Object.entries(data.details)[0];
        if (first) msg = `${first[0].replace(/_/g, ' ')} ${first[1]}`;
      }
      throw new ApiError(res.status, msg, data && data.details);
    }
    return data;
  }

  /** A client bound to a session token stored in sessionStorage under `key`. */
  function session(key) {
    const read = () => { try { return sessionStorage.getItem(key); } catch { return null; } };
    return {
      get token() { return read(); },
      set(token) { try { sessionStorage.setItem(key, token); } catch { /* storage unavailable */ } },
      clear() { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } },
      call(method, path, body) { return request(method, path, { body, token: read() }); },
    };
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // All dates and times are shown in hotel-local time (Maldives, UTC+5), whatever the viewer's timezone.
  const TZ = 'Indian/Maldives';
  // Date-only values (YYYY-MM-DD) are anchored at midday UTC so they never slip a day when formatted.
  const toDate = d => new Date(d.length === 10 ? d + 'T12:00:00Z' : d);
  const fmtDate = (d, opts = { month: 'short', day: 'numeric' }) =>
    d ? toDate(d).toLocaleDateString('en-GB', { ...opts, timeZone: TZ }) : '—';
  const fmtTime = d => d ? new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
  const fmtMoney = (n, cur = 'MVR') => cur === 'USD' ? '$' + Number(n).toLocaleString('en-US') : cur + ' ' + Number(n).toLocaleString('en-US');
  /** Today's date (YYYY-MM-DD) at the hotel. */
  const hotelToday = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);

  window.ParalianAPI = { request, session, ApiError, esc, fmtDate, fmtTime, fmtMoney, hotelToday };
})();
