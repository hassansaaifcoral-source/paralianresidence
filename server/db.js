'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS staff_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  apt_id        TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  floor         TEXT NOT NULL,
  unit_type     TEXT NOT NULL,
  lease_end     TEXT NOT NULL,
  lease_status  TEXT NOT NULL DEFAULT 'active',
  portal_active INTEGER NOT NULL DEFAULT 1,
  monthly_rent  INTEGER NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('staff', 'tenant')),
  subject    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_types (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  price_usd     INTEGER NOT NULL,
  max_guests    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  number      TEXT PRIMARY KEY,
  type_code   TEXT NOT NULL REFERENCES room_types(code),
  status      TEXT NOT NULL DEFAULT 'available'
              CHECK (status IN ('available', 'occupied', 'maintenance')),
  last_cleaned TEXT,
  clean_status TEXT NOT NULL DEFAULT 'clean' CHECK (clean_status IN ('clean', 'due')),
  housekeeper  TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  ref            TEXT PRIMARY KEY,
  guest_name     TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  room_number    TEXT REFERENCES rooms(number),
  type_code      TEXT NOT NULL REFERENCES room_types(code),
  check_in       TEXT NOT NULL,
  check_out      TEXT NOT NULL,
  guests         INTEGER NOT NULL,
  source         TEXT NOT NULL DEFAULT 'Direct',
  payment_method TEXT,
  status         TEXT NOT NULL DEFAULT 'confirmed'
                 CHECK (status IN ('confirmed', 'checked_in', 'checked_out', 'cancelled')),
  total_usd      INTEGER NOT NULL DEFAULT 0,
  balance_usd    INTEGER NOT NULL DEFAULT 0,
  eta            TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enquiries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  check_in   TEXT NOT NULL,
  check_out  TEXT NOT NULL,
  type_code  TEXT,
  guests     INTEGER NOT NULL,
  name       TEXT,
  email      TEXT,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email      TEXT NOT NULL,
  subject    TEXT,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  location       TEXT NOT NULL,
  tenant_apt     TEXT REFERENCES tenants(apt_id),
  category       TEXT NOT NULL DEFAULT 'Other',
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  assigned_to    TEXT,
  preferred_time TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_progress', 'resolved')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT
);

CREATE TABLE IF NOT EXISTS cleaning_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_apt     TEXT NOT NULL REFERENCES tenants(apt_id),
  service_type   TEXT NOT NULL CHECK (service_type IN ('standard', 'deep', 'linen', 'laundry')),
  areas          TEXT NOT NULL DEFAULT '[]',
  preferred_date TEXT NOT NULL,
  time_slot      TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT
);

CREATE TABLE IF NOT EXISTS cafe_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  location   TEXT NOT NULL,
  items      TEXT NOT NULL,
  total_mvr  INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'delivered', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_apt  TEXT NOT NULL REFERENCES tenants(apt_id),
  period      TEXT NOT NULL,
  line_items  TEXT NOT NULL DEFAULT '[]',
  total_mvr   INTEGER NOT NULL,
  due_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  paid_at     TEXT,
  UNIQUE (tenant_apt, period)
);

CREATE TABLE IF NOT EXISTS packages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_apt  TEXT NOT NULL REFERENCES tenants(apt_id),
  carrier     TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'arrived', 'collected')),
  arrived_at  TEXT,
  expected_at TEXT,
  collected_at TEXT
);

CREATE TABLE IF NOT EXISTS notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  important INTEGER NOT NULL DEFAULT 0,
  posted_by TEXT NOT NULL DEFAULT 'Management',
  posted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction, rolling back if it throws. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
