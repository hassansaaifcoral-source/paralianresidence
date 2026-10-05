'use strict';

const { HttpError, nightsBetween, today } = require('./util');

/** Front-end aliases for room types (the hotel quick-enquiry form uses "studio" for the Nest). */
const TYPE_ALIASES = { studio: 'nest', signature: 'suite', dwellers: 'nest' };

function normaliseType(code) {
  if (!code) return null;
  const c = String(code).toLowerCase().trim();
  return TYPE_ALIASES[c] || c;
}

const ACTIVE_STATUSES = "('confirmed', 'checked_in')";

/** Rooms of a type that are free for the whole [checkIn, checkOut) window. */
function freeRooms(db, typeCode, checkIn, checkOut, { excludeRef = null } = {}) {
  return db.prepare(`
    SELECT r.number FROM rooms r
    WHERE r.type_code = ?
      AND r.status != 'maintenance'
      AND NOT EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.room_number = r.number
          AND b.status IN ${ACTIVE_STATUSES}
          AND b.check_in < ? AND b.check_out > ?
          AND (? IS NULL OR b.ref != ?)
      )
    ORDER BY r.number
  `).all(typeCode, checkOut, checkIn, excludeRef, excludeRef).map(r => r.number);
}

/** Availability summary for every room type (or just one) over a date range. */
function availability(db, checkIn, checkOut, guests, typeCode = null) {
  const types = db.prepare('SELECT * FROM room_types ORDER BY price_usd DESC').all()
    .filter(t => !typeCode || t.code === typeCode);
  const nights = nightsBetween(checkIn, checkOut);
  return types.map(t => {
    const available = freeRooms(db, t.code, checkIn, checkOut).length;
    return {
      type: t.code,
      name: t.name,
      price_usd: t.price_usd,
      max_guests: t.max_guests,
      fits_party: guests <= t.max_guests,
      rooms_available: available,
      nights,
      estimated_total_usd: t.price_usd * nights,
    };
  });
}

function checkDates(checkIn, checkOut, { allowPast = false } = {}) {
  if (checkOut <= checkIn) throw new HttpError(400, 'Check-out must be after check-in');
  if (!allowPast && checkIn < today()) throw new HttpError(400, 'Check-in cannot be in the past');
  if (nightsBetween(checkIn, checkOut) > 90) throw new HttpError(400, 'Stays are limited to 90 nights');
}

function nextRef(db) {
  const row = db.prepare(
    "SELECT MAX(CAST(SUBSTR(ref, 5) AS INTEGER)) AS n FROM bookings WHERE ref LIKE 'PRL-%'"
  ).get();
  return 'PRL-' + String((row.n || 0) + 1).padStart(3, '0');
}

/**
 * Display status used by the dashboard badges — derived from the stored
 * lifecycle status, today's date and outstanding balance.
 */
function displayStatus(b, now = today()) {
  if (b.status === 'cancelled') return 'Cancelled';
  if (b.status === 'checked_out') return b.balance_usd > 0 ? 'Pending Payment' : 'Checked Out';
  if (b.status === 'checked_in') {
    if (b.balance_usd > 0 && b.check_out <= now) return 'Pending Payment';
    return 'Active';
  }
  if (b.check_in <= now) return 'Arriving';
  return 'Upcoming';
}

function presentBooking(b) {
  return {
    ...b,
    nights: nightsBetween(b.check_in, b.check_out),
    display_status: displayStatus(b),
  };
}

module.exports = {
  normaliseType,
  freeRooms,
  availability,
  checkDates,
  nextRef,
  displayStatus,
  presentBooking,
};
