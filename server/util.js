'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Today's date as YYYY-MM-DD in the hotel's timezone (Maldives, UTC+5). */
function today(offsetDays = 0) {
  const now = new Date(Date.now() + 5 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}

function nightsBetween(checkIn, checkOut) {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000);
}

/**
 * Tiny declarative validator. `spec` maps field -> rule object:
 *   { type: 'string'|'int'|'date'|'email'|'enum'|'array', required, max, min, values }
 * Returns a cleaned object or throws a 400 HttpError listing every problem.
 */
function validate(body, spec) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};
  const errors = {};

  for (const [field, rule] of Object.entries(spec)) {
    let value = input[field];
    if (typeof value === 'string') value = value.trim();
    const missing = value === undefined || value === null || value === '';

    if (missing) {
      if (rule.required) errors[field] = 'is required';
      else if (rule.default !== undefined) out[field] = rule.default;
      continue;
    }

    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') { errors[field] = 'must be a string'; break; }
        if (rule.max && value.length > rule.max) { errors[field] = `must be at most ${rule.max} characters`; break; }
        out[field] = value;
        break;
      case 'email':
        if (typeof value !== 'string' || !EMAIL.test(value) || value.length > 254) {
          errors[field] = 'must be a valid email address'; break;
        }
        out[field] = value.toLowerCase();
        break;
      case 'int': {
        const n = typeof value === 'number' ? value : parseInt(value, 10);
        if (!Number.isInteger(n)) { errors[field] = 'must be a whole number'; break; }
        if (rule.min !== undefined && n < rule.min) { errors[field] = `must be at least ${rule.min}`; break; }
        if (rule.max !== undefined && n > rule.max) { errors[field] = `must be at most ${rule.max}`; break; }
        out[field] = n;
        break;
      }
      case 'date':
        if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
          errors[field] = 'must be a date in YYYY-MM-DD format'; break;
        }
        out[field] = value;
        break;
      case 'enum': {
        const v = typeof value === 'string' ? value.toLowerCase() : value;
        if (!rule.values.includes(v)) { errors[field] = `must be one of: ${rule.values.join(', ')}`; break; }
        out[field] = v;
        break;
      }
      case 'array':
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
          errors[field] = 'must be a list of strings'; break;
        }
        if (rule.max && value.length > rule.max) { errors[field] = `must have at most ${rule.max} items`; break; }
        out[field] = value.map(v => v.trim().slice(0, 100)).filter(Boolean);
        break;
      default:
        throw new Error(`Unknown rule type ${rule.type}`);
    }
  }

  if (Object.keys(errors).length) throw new HttpError(400, 'Validation failed', errors);
  return out;
}

/** Wraps a sync or async route handler so thrown errors reach the error middleware. */
const route = fn => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

module.exports = { HttpError, validate, route, today, nightsBetween };
