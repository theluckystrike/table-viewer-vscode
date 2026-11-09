'use strict';
// Values, comparison, hashing and the scalar functions of the Query panel.
// A value is null, number, string, boolean, Date, bigint, Uint8Array or a plain object (Parquet structs).

const { formatValue } = require('../table');

const NUM_RE = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

function isNull(v) { return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)); }

/** Number for a value, or null. Numeric text counts (CSV cells are text). */
function num(v) {
  switch (typeof v) {
    case 'number': return Number.isNaN(v) ? null : v;
    case 'bigint': return Number(v);
    case 'boolean': return v ? 1 : 0;
    case 'string': return v !== '' && v.length < 400 && NUM_RE.test(v) ? Number(v) : null;
    default: return null;
  }
}

/** Text for a value (dates as ISO, like the grid). */
function text(v) {
  if (isNull(v)) return null;
  if (typeof v === 'string') return v;
  return formatValue(v, v instanceof Date && isMidnight(v) ? 'date' : null);
}

function isMidnight(d) { return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0; }

/** Date for a value (Date, ISO text), or null. Text without a zone is read as UTC, like the grid shows it. */
function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const m = ISO_RE.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', zone] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${frac.slice(0, 4)}${zone ? (zone === 'Z' ? 'Z' : zone.length === 5 ? zone.slice(0, 3) + ':' + zone.slice(3) : zone) : 'Z'}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

function truthy(v) {
  if (isNull(v)) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const l = v.toLowerCase(); if (l === 'true') return true; if (l === 'false') return false; }
  const n = num(v);
  return n === null ? null : n !== 0;
}

function rank(v) {
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number' || typeof v === 'bigint') return 2;
  if (v instanceof Date) return 3;
  return 4;
}

/**
 * Compare two non-null values: -1, 0, 1. Numbers and numeric text compare as numbers, dates by time,
 * the rest as text (code unit order, like most databases with a binary collation).
 */
function cmp(a, b) {
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'string' && tb === 'string') {
    const na = num(a), nb = num(b);
    if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
    // Numbers before other text, so a mixed column has one consistent order (2.5, 9, 10, 2026-01-01, abc).
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (a instanceof Date || b instanceof Date) {
    const da = toDate(a), db = toDate(b);
    if (da && db) { const x = da.getTime(), y = db.getTime(); return x < y ? -1 : x > y ? 1 : 0; }
  }
  if (ta === 'boolean' || tb === 'boolean') {
    const x = truthy(a), y = truthy(b);
    if (x !== null && y !== null) return x === y ? 0 : x ? 1 : -1;
  }
  const na = num(a), nb = num(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (na !== null || nb !== null) {
    // A number against text that is not a number: numbers first, so mixed columns sort in two blocks.
    const ra = na !== null ? 2 : rank(a), rb = nb !== null ? 2 : rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
  }
  const sa = text(a), sb = text(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Sort comparator with nulls last (ascending), as PostgreSQL and DuckDB do. */
function sortCmp(a, b) {
  const na = isNull(a), nb = isNull(b);
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  return cmp(a, b);
}

/** Hash key for GROUP BY, DISTINCT and JOIN: equal values give equal keys (1, 1.0 and '1' are one key). */
function keyOf(v) {
  if (isNull(v)) return '\u0000';
  switch (typeof v) {
    case 'number': return 'n' + v;
    case 'string': { const n = num(v); return n !== null ? 'n' + n : 's' + v; }
    case 'boolean': return v ? 'b1' : 'b0';
    case 'bigint': return 'n' + Number(v);
    default: break;
  }
  if (v instanceof Date) return 't' + v.getTime();
  return 's' + text(v);
}

function likeRegex(pattern, ci) {
  let re = '';
  for (const ch of String(pattern)) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ci ? 'is' : 's');
}

// ---------- dates ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
function isoDate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }

function truncDate(unit, d) {
  const u = String(unit || '').toLowerCase().replace(/s$/, '');
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  switch (u) {
    case 'year': return new Date(Date.UTC(y, 0, 1));
    case 'quarter': return new Date(Date.UTC(y, m - (m % 3), 1));
    case 'month': return new Date(Date.UTC(y, m, 1));
    case 'week': { const wd = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(y, m, day - wd)); }
    case 'day': return new Date(Date.UTC(y, m, day));
    case 'hour': return new Date(Date.UTC(y, m, day, d.getUTCHours()));
    case 'minute': return new Date(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes()));
    case 'second': return new Date(Math.floor(d.getTime() / 1000) * 1000);
    default: throw fnError(`DATE_TRUNC does not know the unit '${unit}'. Use year, quarter, month, week, day, hour, minute or second.`);
  }
}

const MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
function dateDiff(unit, a, b) {
  const u = String(unit || '').toLowerCase().replace(/s$/, '');
  if (MS[u]) return Math.trunc((b.getTime() - a.getTime()) / MS[u]);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (u === 'month') return months;
  if (u === 'quarter') return Math.trunc(months / 3);
  if (u === 'year') return b.getUTCFullYear() - a.getUTCFullYear();
  throw fnError(`DATE_DIFF does not know the unit '${unit}'.`);
}

function dateAdd(unit, n, d) {
  const u = String(unit || '').toLowerCase().replace(/s$/, '');
  if (MS[u]) return new Date(d.getTime() + n * MS[u]);
  const r = new Date(d.getTime());
  if (u === 'month') r.setUTCMonth(r.getUTCMonth() + n);
  else if (u === 'quarter') r.setUTCMonth(r.getUTCMonth() + 3 * n);
  else if (u === 'year') r.setUTCFullYear(r.getUTCFullYear() + n);
  else throw fnError(`DATE_ADD does not know the unit '${unit}'.`);
  return r;
}

function strftime(fmt, d) {
  return String(fmt).replace(/%([YmdHMSjwyfF%])/g, (m, c) => {
    switch (c) {
      case 'Y': return String(d.getUTCFullYear());
      case 'y': return pad(d.getUTCFullYear() % 100);
      case 'm': return pad(d.getUTCMonth() + 1);
      case 'd': return pad(d.getUTCDate());
      case 'H': return pad(d.getUTCHours());
      case 'M': return pad(d.getUTCMinutes());
      case 'S': return pad(d.getUTCSeconds());
      case 'f': return pad(d.getUTCMilliseconds(), 3);
      case 'F': return isoDate(d);
      case 'w': return String(d.getUTCDay());
      case 'j': return pad(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1, 3);
      default: return '%';
    }
  });
}

function fnError(message) { const e = new Error(message); e.code = 'SQL'; return e; }

// ---------- CAST ----------
function cast(v, to) {
  if (isNull(v)) return null;
  switch (to) {
    case 'INT': case 'INTEGER': case 'BIGINT': case 'SMALLINT': case 'TINYINT': case 'HUGEINT': {
      const n = num(v);
      return n === null ? null : Math.trunc(n);
    }
    case 'REAL': case 'FLOAT': case 'DOUBLE': case 'NUMERIC': case 'DECIMAL': case 'NUMBER': return num(v);
    case 'TEXT': case 'VARCHAR': case 'STRING': case 'CHAR': case 'NVARCHAR': return text(v);
    case 'DATE': { const d = toDate(v); return d ? isoDate(d) : null; }
    case 'TIMESTAMP': case 'DATETIME': return toDate(v);
    case 'BOOLEAN': case 'BOOL': return truthy(v);
    default: throw fnError(`CAST does not know the type ${to}. Use INTEGER, DOUBLE, VARCHAR, DATE, TIMESTAMP or BOOLEAN.`);
  }
}

// ---------- scalar functions ----------
// Each takes already computed argument values. min/max: argument count.
const n1 = f => a => { const x = num(a[0]); return x === null ? null : f(x); };
const s1 = f => a => { const s = text(a[0]); return s === null ? null : f(s); };
const d1 = f => a => { const d = toDate(a[0]); return d ? f(d) : null; };

const FUNCTIONS = {
  // text
  LOWER: [1, 1, s1(s => s.toLowerCase())],
  UPPER: [1, 1, s1(s => s.toUpperCase())],
  LENGTH: [1, 1, s1(s => [...s].length)],
  LEN: [1, 1, s1(s => [...s].length)],
  CHAR_LENGTH: [1, 1, s1(s => [...s].length)],
  TRIM: [1, 1, s1(s => s.trim())],
  LTRIM: [1, 1, s1(s => s.replace(/^\s+/, ''))],
  RTRIM: [1, 1, s1(s => s.replace(/\s+$/, ''))],
  REVERSE: [1, 1, s1(s => [...s].reverse().join(''))],
  SUBSTR: [2, 3, a => substr(a)],
  SUBSTRING: [2, 3, a => substr(a)],
  LEFT: [2, 2, a => { const s = text(a[0]), n = num(a[1]); return s === null || n === null ? null : [...s].slice(0, Math.max(0, n)).join(''); }],
  RIGHT: [2, 2, a => { const s = text(a[0]), n = num(a[1]); if (s === null || n === null) return null; const c = [...s]; return n <= 0 ? '' : c.slice(-n).join(''); }],
  REPLACE: [3, 3, a => { const s = text(a[0]), f = text(a[1]), t = text(a[2]); return s === null || f === null || t === null ? null : f === '' ? s : s.split(f).join(t); }],
  INSTR: [2, 2, a => { const s = text(a[0]), f = text(a[1]); return s === null || f === null ? null : s.indexOf(f) + 1; }],
  STRPOS: [2, 2, a => { const s = text(a[0]), f = text(a[1]); return s === null || f === null ? null : s.indexOf(f) + 1; }],
  CONCAT: [1, 100, a => a.map(v => (isNull(v) ? '' : text(v))).join('')],
  CONCAT_WS: [2, 100, a => { const sep = text(a[0]); return sep === null ? null : a.slice(1).filter(v => !isNull(v)).map(text).join(sep); }],
  STARTS_WITH: [2, 2, a => { const s = text(a[0]), f = text(a[1]); return s === null || f === null ? null : s.startsWith(f); }],
  CONTAINS: [2, 2, a => { const s = text(a[0]), f = text(a[1]); return s === null || f === null ? null : s.includes(f); }],
  LPAD: [2, 3, a => { const s = text(a[0]), n = num(a[1]); return s === null || n === null ? null : s.padStart(n, a[2] === undefined ? ' ' : text(a[2]) || ' ').slice(0, n); }],
  RPAD: [2, 3, a => { const s = text(a[0]), n = num(a[1]); return s === null || n === null ? null : s.padEnd(n, a[2] === undefined ? ' ' : text(a[2]) || ' ').slice(0, n); }],
  SPLIT_PART: [3, 3, a => { const s = text(a[0]), d = text(a[1]), i = num(a[2]); if (s === null || d === null || i === null) return null; const parts = d === '' ? [s] : s.split(d); return parts[i - 1] === undefined ? '' : parts[i - 1]; }],
  REGEXP_MATCHES: [2, 2, a => { const s = text(a[0]), r = text(a[1]); return s === null || r === null ? null : safeRegex(r).test(s); }],
  // numbers
  ABS: [1, 1, n1(Math.abs)],
  ROUND: [1, 2, a => { const x = num(a[0]); if (x === null) return null; const d = a.length > 1 ? num(a[1]) || 0 : 0; const f = 10 ** d; return Math.round((x + (x >= 0 ? Number.EPSILON : -Number.EPSILON)) * f) / f; }],
  FLOOR: [1, 1, n1(Math.floor)],
  CEIL: [1, 1, n1(Math.ceil)],
  CEILING: [1, 1, n1(Math.ceil)],
  TRUNC: [1, 1, n1(Math.trunc)],
  SQRT: [1, 1, n1(x => (x < 0 ? null : Math.sqrt(x)))],
  POWER: [2, 2, a => { const x = num(a[0]), y = num(a[1]); return x === null || y === null ? null : x ** y; }],
  POW: [2, 2, a => { const x = num(a[0]), y = num(a[1]); return x === null || y === null ? null : x ** y; }],
  MOD: [2, 2, a => { const x = num(a[0]), y = num(a[1]); return x === null || y === null || y === 0 ? null : x % y; }],
  LN: [1, 1, n1(x => (x <= 0 ? null : Math.log(x)))],
  LOG: [1, 2, a => { if (a.length === 2) { const b = num(a[0]), x = num(a[1]); return b === null || x === null || x <= 0 || b <= 0 ? null : Math.log(x) / Math.log(b); } const x = num(a[0]); return x === null || x <= 0 ? null : Math.log10(x); }],
  LOG10: [1, 1, n1(x => (x <= 0 ? null : Math.log10(x)))],
  EXP: [1, 1, n1(Math.exp)],
  SIGN: [1, 1, n1(Math.sign)],
  GREATEST: [1, 100, a => { let best = null; for (const v of a) if (!isNull(v) && (best === null || cmp(v, best) > 0)) best = v; return best; }],
  LEAST: [1, 100, a => { let best = null; for (const v of a) if (!isNull(v) && (best === null || cmp(v, best) < 0)) best = v; return best; }],
  // nulls
  COALESCE: [1, 100, a => { for (const v of a) if (!isNull(v)) return v; return null; }],
  IFNULL: [2, 2, a => (isNull(a[0]) ? a[1] : a[0])],
  NVL: [2, 2, a => (isNull(a[0]) ? a[1] : a[0])],
  NULLIF: [2, 2, a => (!isNull(a[0]) && !isNull(a[1]) && cmp(a[0], a[1]) === 0 ? null : a[0])],
  IF: [3, 3, a => (truthy(a[0]) === true ? a[1] : a[2])],
  IIF: [3, 3, a => (truthy(a[0]) === true ? a[1] : a[2])],
  TYPEOF: [1, 1, a => { const v = a[0]; if (isNull(v)) return 'null'; if (v instanceof Date) return 'timestamp'; if (typeof v === 'string') return num(v) !== null ? 'number (text)' : 'text'; return typeof v; }],
  // dates
  DATE: [1, 1, d1(isoDate)],
  YEAR: [1, 1, d1(d => d.getUTCFullYear())],
  MONTH: [1, 1, d1(d => d.getUTCMonth() + 1)],
  DAY: [1, 1, d1(d => d.getUTCDate())],
  HOUR: [1, 1, d1(d => d.getUTCHours())],
  MINUTE: [1, 1, d1(d => d.getUTCMinutes())],
  SECOND: [1, 1, d1(d => d.getUTCSeconds())],
  QUARTER: [1, 1, d1(d => Math.floor(d.getUTCMonth() / 3) + 1)],
  DAYOFWEEK: [1, 1, d1(d => d.getUTCDay())],
  DAYOFYEAR: [1, 1, d1(d => Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1)],
  DATE_TRUNC: [2, 2, a => { const d = toDate(a[1]); return d ? truncDate(text(a[0]), d) : null; }],
  DATE_PART: [2, 2, a => datePart(a)],
  EXTRACT: [2, 2, a => datePart(a)],
  DATE_DIFF: [3, 3, a => { const x = toDate(a[1]), y = toDate(a[2]); return x && y ? dateDiff(text(a[0]), x, y) : null; }],
  DATEDIFF: [3, 3, a => { const x = toDate(a[1]), y = toDate(a[2]); return x && y ? dateDiff(text(a[0]), x, y) : null; }],
  DATE_ADD: [3, 3, a => { const n = num(a[1]), d = toDate(a[2]); return n === null || !d ? null : dateAdd(text(a[0]), n, d); }],
  STRFTIME: [2, 2, a => { const d = toDate(a[1]); return d ? strftime(text(a[0]), d) : null; }],
  TO_TIMESTAMP: [1, 1, a => { const n = num(a[0]); return n === null ? toDate(a[0]) : new Date(n * 1000); }],
  EPOCH: [1, 1, d1(d => d.getTime() / 1000)],
};

function datePart(a) {
  const d = toDate(a[1]);
  if (!d) return null;
  const u = String(text(a[0]) || '').toUpperCase();
  const f = FUNCTIONS[u === 'DOW' ? 'DAYOFWEEK' : u === 'DOY' ? 'DAYOFYEAR' : u];
  if (!f || !['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'QUARTER', 'DAYOFWEEK', 'DAYOFYEAR'].includes(u === 'DOW' ? 'DAYOFWEEK' : u === 'DOY' ? 'DAYOFYEAR' : u)) throw fnError(`DATE_PART does not know '${a[0]}'.`);
  return f[2]([d]);
}

function substr(a) {
  const s = text(a[0]);
  const start = num(a[1]);
  if (s === null || start === null) return null;
  const chars = [...s];
  const from = start > 0 ? start - 1 : start < 0 ? Math.max(0, chars.length + start) : 0;
  if (a.length > 2) { const len = num(a[2]); if (len === null) return null; return chars.slice(from, from + Math.max(0, len)).join(''); }
  return chars.slice(from).join('');
}

const regexCache = new Map();
function safeRegex(src) {
  let re = regexCache.get(src);
  if (!re) {
    if (src.length > 500) throw fnError('The regular expression is longer than 500 characters.');
    try { re = new RegExp(src, 'u'); } catch (e) { throw fnError(`Bad regular expression: ${e.message}`); }
    if (regexCache.size > 100) regexCache.clear();
    regexCache.set(src, re);
  }
  return re;
}

/** Arithmetic and || with SQL null rules. Division by zero gives null. */
function binary(op, a, b) {
  if (op === '||') return isNull(a) || isNull(b) ? null : text(a) + text(b);
  if (isNull(a) || isNull(b)) return null;
  if ((op === '+' || op === '-') && (a instanceof Date || b instanceof Date)) {
    // date + number of days
    const d = toDate(a instanceof Date ? a : b), n = num(a instanceof Date ? b : a);
    if (d && n !== null) return new Date(d.getTime() + (op === '+' ? 1 : -1) * n * 86400000);
    if (op === '-' && toDate(a) && toDate(b)) return (toDate(a).getTime() - toDate(b).getTime()) / 86400000;
  }
  const x = num(a), y = num(b);
  if (x === null || y === null) return null;
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? null : x / y;
    case '%': return y === 0 ? null : x % y;
    default: return null;
  }
}

module.exports = { isNull, num, text, toDate, truthy, cmp, sortCmp, keyOf, likeRegex, cast, binary, FUNCTIONS, fnError, isoDate };
