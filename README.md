# Paralian Hotel & Residence

The Paralian website (hotel, residence, staff dashboard and tenant portal) plus the
backend API that powers it.

```
index.html, hotel/, residence/, admin/, assets/   ← static website
server/                                           ← Node.js + Express API
test/                                             ← API tests
```

## Running it

Requires **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module, so there's no
database server to install).

```bash
npm install
npm start
#  Paralian website:  http://localhost:3000            (public site + tenant portal)
#  Staff portal:      http://localhost:3001/admin/     (separate — see below)
```

On first start the server creates `data/paralian.db` and fills it with demo data. Other scripts:

| Command        | What it does                                   |
| -------------- | ---------------------------------------------- |
| `npm run dev`  | Start with auto-restart on file changes        |
| `npm run seed` | Wipe the database and reload the demo data     |
| `npm test`     | Run the API test suite (in-memory database)    |

Configuration is via environment variables or a `.env` file — see [`.env.example`](.env.example).

### The staff portal is kept off the public website

The public website (and the tenant portal) never serves the staff portal: `/admin/`, the staff
login and the whole `/api/admin` API return *404 Not found* there, and no public page links to it.
The staff portal runs as a separate server that serves nothing else. Choose how to expose it:

| Setup | How | Good for |
| --- | --- | --- |
| **Own port** (default) | `ADMIN_PORT=3001`. Firewall that port, or set `ADMIN_BIND=127.0.0.1` so only the server itself can reach it and staff connect through a VPN or SSH tunnel. | A VPS / your own server |
| **Own web address** | `ADMIN_HOST=staff.paralian.mv` (point that DNS name at the same server). The staff portal answers only on that hostname; the public address never shows it. | Hosts that give you a single port (Render, Railway, …) |

On top of either, `ADMIN_ALLOWED_IPS=203.0.113.7,198.51.100.20` limits the staff portal to the
hotel's own internet connections — everyone else gets *404*. If the app sits behind a load
balancer, set `TRUST_PROXY=1` so the real client IP is used.

Keeping the address private is an extra layer, not the main protection: staff still need their
password, failed logins are rate-limited, and the pages are marked `noindex` so search engines
skip them.

If the website is hosted separately from the API (e.g. on GitHub Pages), set `CORS_ORIGIN`
to the site's origin on the server, and add this before the other scripts on each page:

```html
<script>window.PARALIAN_API_BASE = 'https://api.example.com';</script>
```

### Demo logins

| Portal                      | Login                                       |
| --------------------------- | ------------------------------------------- |
| Staff (`http://localhost:3001/admin/`) | `admin` / `paralian2025`, `front` / `desk2025` |
| Tenant (`/residence/tenant.html`) | apartment number such as `APT-101` (or just `101`), password `paralian2025` (APT-401's portal is deactivated) |

**Change these before going live.** Tenants can change their own password
(`POST /api/tenant/password`), and staff can reset a tenant's with
`PATCH /api/admin/tenants/:apt`. Passwords are stored as salted scrypt hashes.

## Staff dashboard

Besides the hotel pages (bookings, rooms, guests, housekeeping, café) and residence pages
(tenants, maintenance), the dashboard has:

- **Website Inbox** — booking enquiries and contact messages sent from the website, newest and
  unhandled first. Enquiries can be turned into a booking in one click (the New Booking form is
  pre-filled and the enquiry is marked *booked*), marked contacted, or closed. Messages have a
  *Reply by Email* button that opens your mail app.
- **Cleaning Requests** — cleaning booked by tenants in the portal; start, mark done or cancel.

Sidebar badges show how many items are waiting on each page.

## API

All endpoints take and return JSON. Signed-in endpoints need an
`Authorization: Bearer <token>` header using the token returned by a login call. Errors look like
`{ "error": "message", "details": { "field": "problem" } }`.

Dates are `YYYY-MM-DD`; "today" is Maldives time (UTC+5). Hotel prices are USD, residence
amounts are MVR.

### Public

| Method & path | Purpose |
| --- | --- |
| `GET  /api/health` | Health check |
| `GET  /api/room-types` | Room types, nightly prices and capacity |
| `GET  /api/availability?checkin=&checkout=&guests=&room=` | Free rooms per type for a date range |
| `POST /api/enquiries` | Hotel quick-enquiry form `{checkin, checkout, name, email, phone?, room?, guests?}`; saves the lead and returns availability |
| `POST /api/contact` | Contact form `{first_name, last_name, email, subject?, message}` |
| `POST /api/auth/staff/login` | `{username, password}` → `{token, expiresAt, user}` — staff server only |
| `POST /api/auth/tenant/login` | `{apt, password}` → `{token, expiresAt, tenant}` — public server only |
| `POST /api/auth/logout` | Ends the current session |
| `GET  /api/auth/me` | Who the current token belongs to |

Failed logins are rate-limited (10 per 15 minutes per IP).

### Staff — `/api/admin/*` (staff server only)

| Method & path | Purpose |
| --- | --- |
| `GET /overview` | Dashboard stats, today's arrivals/departures, open requests, badge counts |
| `GET /bookings?status=&from=&to=` | List bookings |
| `POST /bookings` | Create; auto-assigns a free room (or pass `room_number`). 409 if fully booked |
| `GET` / `PATCH /bookings/:ref` | View / edit (dates, room, contact details, notes…) |
| `POST /bookings/:ref/check-in` · `/check-out` · `/cancel` · `/settle` | Booking lifecycle; `settle` takes optional `{amount_usd}` |
| `GET /rooms` · `PATCH /rooms/:number` | Room board; set `{status: "available" \| "maintenance"}` |
| `GET /guests` | Guests currently checked in |
| `GET /housekeeping` · `POST /housekeeping/:number/clean` · `PATCH /housekeeping/:number` | Cleaning board |
| `GET` / `POST /maintenance` · `PATCH /maintenance/:id` | Hotel and residence maintenance (`?scope=hotel\|residence&status=open`) |
| `GET /cleaning-requests` · `PATCH /cleaning-requests/:id` | Tenant cleaning requests |
| `GET /cafe-orders?date=` · `POST` · `PATCH /cafe-orders/:id` | Café orders with daily totals |
| `GET /tenants` · `PATCH /tenants/:apt` | Tenants, lease status, balances; edit lease, deactivate portal, reset password |
| `GET` / `POST /invoices` · `POST /invoices/:id/pay` | Tenant billing |
| `GET` / `POST /packages` · `PATCH /packages/:id` | Parcels held at the front desk |
| `GET` / `POST /notices` · `DELETE /notices/:id` | Residence announcements |
| `GET /enquiries` · `PATCH /enquiries/:id` | Website booking enquiries; status `new \| contacted \| booked \| closed`, optional `booking_ref` |
| `GET /messages` · `PATCH /messages/:id` | Website contact messages |

### Tenant — `/api/tenant/*`

Each tenant only ever sees their own apartment's data.

| Method & path | Purpose |
| --- | --- |
| `GET /me` | Profile and dashboard summary |
| `POST /password` | `{current_password, new_password}`; signs out other devices |
| `GET` / `POST /cleaning` | Cleaning requests `{service_type, areas[], preferred_date, time_slot?, notes?}` |
| `GET` / `POST /maintenance` | Repair requests `{category, description, priority, preferred_time?, notes?}` |
| `GET /history` | Cleaning and maintenance requests combined, newest first |
| `GET /billing` | Current statement, outstanding balance and payment history |
| `GET /packages` | Parcels waiting or on the way |
| `GET /notices` | Announcements |
