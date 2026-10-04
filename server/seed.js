'use strict';

/*
 * Demo data mirroring what the static pages used to hardcode.
 * Dates are relative to "today" so the dashboards always look current.
 *
 * Run `npm run seed` to wipe and re-seed the configured database.
 */

const { hashPassword } = require('./auth');
const { transaction } = require('./db');
const { today } = require('./util');

const at = (offsetDays, time = '09:00') => `${today(offsetDays)}T${time}:00+05:00`;
const iso = (offsetDays, time) => new Date(at(offsetDays, time)).toISOString();
const monthLabel = offsetMonths => {
  const d = new Date(today());
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offsetMonths);
  return d.toISOString().slice(0, 7);
};

const ROOM_TYPES = [
  ['suite', 'Signature Suite', 185, 3],
  ['sunrise', 'Sunrise Suite', 165, 3],
  ['palms', 'Palms View Deluxe', 120, 2],
  ['classic', 'Classic Room', 95, 2],
  ['nest', 'Dwellers Nest', 79, 1],
];

const ROOMS = [
  ['101', 'classic'], ['102', 'classic'], ['103', 'classic'], ['104', 'classic'], ['105', 'nest'],
  ['201', 'palms'], ['202', 'classic'], ['203', 'classic'], ['204', 'palms'], ['205', 'palms'],
  ['301', 'sunrise'], ['302', 'sunrise'], ['303', 'classic'], ['304', 'classic'],
  ['401', 'suite'], ['402', 'suite'], ['403', 'suite'], ['501', 'suite'], ['502', 'suite'],
  ['503', 'classic'], ['601', 'suite'], ['602', 'suite'],
];
const MAINTENANCE_ROOMS = ['203', '502'];

const STAFF = [
  ['admin', 'Admin', 'Hotel Manager', 'paralian2025'],
  ['manager', 'Manager', 'Operations Manager', 'paralian2025'],
  ['front', 'Front Desk', 'Front Desk', 'desk2025'],
];

const TENANTS = [
  ['APT-101', 'Ahmed Hassan', '1st Floor', 'Studio', 90, 5500],
  ['APT-102', 'Mariyam Khalid', '1st Floor', 'Studio', 45, 5500],
  ['APT-201', 'Mohamed Ibrahim', '2nd Floor', '1-Bedroom', 160, 7500],
  ['APT-202', 'Fathimath Ali', '2nd Floor', '1-Bedroom', 130, 7500],
  ['APT-301', 'Ali Rasheed', '3rd Floor', '2-Bedroom', 250, 9500],
  ['APT-302', 'Aminath Saeed', '3rd Floor', '2-Bedroom', 30, 9500],
  ['APT-401', 'Hassan Shareef', '4th Floor', 'Studio', -20, 5500],
  ['APT-501', 'Zaha Waheed', '5th Floor', '2-Bedroom', 320, 9500],
];

// [ref, guest, email, room, type, ciOffset, coOffset, guests, source, status, balance, eta, notes]
const BOOKINGS = [
  ['PRL-001', 'Ahmed Al-Rashid', 'ahmed.r@example.com', '401', 'suite', 0, 4, 2, 'Direct', 'checked_in', 0, '14:00', 'VIP — anniversary trip'],
  ['PRL-002', 'Sofia Mendes', 'sofia.m@example.com', '202', 'classic', 0, 3, 1, 'Direct', 'checked_in', 0, '15:30', 'Solo traveller'],
  ['PRL-003', 'Lena Hartmann', 'lena.h@example.com', '301', 'sunrise', 0, 7, 2, 'Booking.com', 'confirmed', 0, '16:00', 'Honeymoon — special setup requested'],
  ['PRL-004', 'Yuki Tanaka', 'yuki.t@example.com', '105', 'nest', 0, 2, 1, 'Direct', 'confirmed', 0, '17:00', null],
  ['PRL-005', 'Carlos Rivera', 'carlos.r@example.com', '201', 'palms', 1, 5, 2, 'Expedia', 'confirmed', 0, '18:00', null],
  ['PRL-006', 'Wang Fang', 'wang.f@example.com', '103', 'classic', -4, 0, 1, 'Direct', 'checked_out', 0, null, 'Business travel'],
  ['PRL-007', 'Priya Nair', 'priya.n@example.com', '302', 'sunrise', -2, 0, 2, 'Direct', 'checked_in', 240, null, 'Early breakfast (7 AM)'],
  ['PRL-008', "James O'Brien", 'james.ob@example.com', '205', 'palms', -5, 0, 2, 'Direct', 'checked_in', 0, null, null],
];

function seed(db, { reset = false } = {}) {
  const hasData = db.prepare('SELECT COUNT(*) AS n FROM staff_users').get().n > 0;
  if (hasData && !reset) return false;

  transaction(db, () => {
    if (reset) {
      for (const t of ['sessions', 'notices', 'packages', 'invoices', 'cafe_orders', 'cleaning_requests',
        'maintenance_requests', 'contact_messages', 'enquiries', 'bookings', 'rooms', 'room_types',
        'tenants', 'staff_users']) {
        db.exec(`DELETE FROM ${t}`);
      }
      db.exec("DELETE FROM sqlite_sequence");
    }

    const insStaff = db.prepare('INSERT INTO staff_users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)');
    for (const [u, name, role, pass] of STAFF) insStaff.run(u, name, role, hashPassword(pass));

    const insType = db.prepare('INSERT INTO room_types (code, name, price_usd, max_guests) VALUES (?, ?, ?, ?)');
    for (const t of ROOM_TYPES) insType.run(...t);

    const insRoom = db.prepare('INSERT INTO rooms (number, type_code, status, last_cleaned, clean_status, housekeeper) VALUES (?, ?, ?, ?, ?, ?)');
    const keepers = ['Hawa', 'Shifza'];
    ROOMS.forEach(([num, type], i) => {
      const status = MAINTENANCE_ROOMS.includes(num) ? 'maintenance' : 'available';
      const due = num === '104';
      insRoom.run(num, type, status, iso(due ? -1 : 0, due ? '08:00' : '08:30'), due ? 'due' : 'clean',
        due ? null : keepers[i % 2]);
    });

    const insBooking = db.prepare(`
      INSERT INTO bookings (ref, guest_name, email, room_number, type_code, check_in, check_out, guests,
        source, payment_method, status, total_usd, balance_usd, eta, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const price = Object.fromEntries(ROOM_TYPES.map(([c, , p]) => [c, p]));
    for (const [ref, guest, email, room, type, ci, co, guests, source, status, balance, eta, notes] of BOOKINGS) {
      insBooking.run(ref, guest, email, room, type, today(ci), today(co), guests, source, 'BML Transfer',
        status, price[type] * (co - ci), balance, eta, notes, iso(ci - 14));
      if (status === 'checked_in') db.prepare("UPDATE rooms SET status = 'occupied' WHERE number = ?").run(room);
    }

    const insTenant = db.prepare(`
      INSERT INTO tenants (apt_id, name, floor, unit_type, lease_end, portal_active, monthly_rent, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insInvoice = db.prepare(`
      INSERT INTO invoices (tenant_apt, period, line_items, total_mvr, due_date, status, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const [apt, name, floor, type, leaseOffset, rent] of TENANTS) {
      insTenant.run(apt, name, floor, type, today(leaseOffset), leaseOffset < 0 ? 0 : 1, rent, hashPassword('paralian2025'));

      for (let m = -5; m <= 0; m++) {
        const items = [
          { label: 'Monthly Rent', amount_mvr: rent },
          { label: 'Water & Electricity', amount_mvr: 300 + ((m + 6) * 40) % 160 },
          { label: 'Internet', amount_mvr: 180 },
        ];
        if (m === 0) items.push({ label: 'Cleaning Service', amount_mvr: 100 });
        const total = items.reduce((s, i) => s + i.amount_mvr, 0);
        const period = monthLabel(m);
        insInvoice.run(apt, period, JSON.stringify(items), total, `${period}-05`,
          m === 0 ? 'due' : 'paid', m === 0 ? null : new Date(`${period}-03T10:00:00+05:00`).toISOString());
      }
    }

    const insMaint = db.prepare(`
      INSERT INTO maintenance_requests (location, tenant_apt, category, title, description, priority,
        assigned_to, preferred_time, status, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insMaint.run('Room 302', null, 'Air Conditioning', 'AC not cooling', 'Guest reported the room is warm. Air conditioning not reaching set temperature.', 'high', 'Ali (Maintenance)', null, 'pending', iso(0, '09:14'), null);
    insMaint.run('Room 104', null, 'Plumbing', 'Shower drain slow', 'Water draining slowly in the en-suite shower.', 'medium', 'Plumbing team', null, 'pending', iso(-1, '16:30'), null);
    insMaint.run('Room 501', null, 'Electrical', 'Light bulb replacement', 'Bathroom light flickering. Needs bulb replacement.', 'low', 'Maintenance', null, 'resolved', iso(-2, '14:00'), iso(-1, '10:00'));
    insMaint.run('APT-101', 'APT-101', 'Air Conditioning', 'Air conditioning not cooling properly', 'Bedroom AC unit is running but not cooling.', 'medium', null, null, 'pending', iso(-4, '10:20'), null);
    insMaint.run('APT-101', 'APT-101', 'Plumbing', 'Kitchen tap leaking', 'Constant drip from the kitchen tap.', 'low', 'Plumbing team', null, 'resolved', iso(-17, '11:00'), iso(-15, '15:00'));

    const insClean = db.prepare(`
      INSERT INTO cleaning_requests (tenant_apt, service_type, areas, preferred_date, time_slot, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insClean.run('APT-101', 'standard', JSON.stringify(['Living Room', 'Bedroom', 'Bathroom']), today(2), '8–10 AM', 'in_progress', iso(-2), null);
    insClean.run('APT-101', 'linen', '[]', today(-7), '10–12 PM', 'done', iso(-9), iso(-7, '11:30'));
    insClean.run('APT-101', 'deep', JSON.stringify(['Kitchen', 'Bathroom', 'Balcony']), today(-24), '1–3 PM', 'done', iso(-26), iso(-24, '15:00'));

    const insCafe = db.prepare('INSERT INTO cafe_orders (location, items, total_mvr, status, created_at) VALUES (?, ?, ?, ?, ?)');
    insCafe.run('Table 1', 'Avocado Toast × 1, Latte × 2', 430, 'delivered', iso(0, '08:30'));
    insCafe.run('Room 301', 'Eggs Your Way, Fresh Juice', 270, 'in_progress', iso(0, '08:45'));
    insCafe.run('Table 3', 'Cappuccino × 3, Croissant × 2', 385, 'delivered', iso(0, '09:00'));
    insCafe.run('Room 401', 'Full Breakfast × 2', 560, 'delivered', iso(0, '09:05'));

    const insPkg = db.prepare(`
      INSERT INTO packages (tenant_apt, carrier, description, status, arrived_at, expected_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    insPkg.run('APT-101', 'Amazon', 'Small parcel', 'arrived', iso(-1, '13:00'), null);
    insPkg.run('APT-101', 'DHL', 'Medium box', 'expected', null, today(3));
    insPkg.run('APT-302', 'Aramex', 'Document envelope', 'arrived', iso(0, '10:15'), null);

    const insNotice = db.prepare('INSERT INTO notices (title, body, important, posted_at) VALUES (?, ?, ?, ?)');
    insNotice.run('Paralian Café — Resident Discount',
      'All Paralian Residence tenants are entitled to a 10% discount on all food and beverage orders at Paralian Café. Simply show your apartment key card or mention your apartment number when ordering. This discount applies to dine-in only and cannot be combined with other offers.',
      0, iso(-60));
    insNotice.run('Rooftop Pool Hours Update',
      'The rooftop pool is now open from 6:00 AM – 10:00 PM daily. The early morning slot is reserved for lap swimmers; general use begins at 7 AM. Pool towels are available at the front desk. Children under 12 must be accompanied by an adult at all times.',
      0, iso(-14));
    insNotice.run(`Water Supply Interruption — ${new Date(today(5) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      'Scheduled water maintenance will interrupt supply to all apartments from 9:00 AM – 1:00 PM. Please store adequate water in advance. Hot water will also be unavailable during this period. We apologise for any inconvenience and thank you for your patience.',
      1, iso(-1));
  });
  return true;
}

module.exports = { seed };

if (require.main === module) {
  const { openDb } = require('./db');
  const config = require('./config');
  const db = openDb(config.dbPath);
  seed(db, { reset: process.argv.includes('--reset') });
  console.log(`Seeded ${config.dbPath}`);
}
