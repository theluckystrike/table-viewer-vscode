'use strict';
// Column store with a sorted/filtered view, paging, and copy-as-CSV/TSV/JSON.

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOL_RE = /^(true|false|TRUE|FALSE|True|False)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_CELL_CHARS = 2000;

/** Infer a type for a column of strings ('' = empty). Returns 'int'|'float'|'bool'|'date'|'string'|'empty'. */
function inferStringType(values, limit = values.length) {
  let int = true, float = true, bool = true, date = true, seen = 0;
  for (let i = 0; i < limit; i++) {
    const v = values[i];
    if (v === '' || v === null || v === undefined) continue;
    seen++;
    if (int && !INT_RE.test(v)) int = false;
    if (float && !int && !FLOAT_RE.test(v)) float = false;
    if (bool && !BOOL_RE.test(v)) bool = false;
    if (date && !DATE_RE.test(v)) date = false;
    if (!int && !float && !bool && !date) return 'string';
  }
  if (seen === 0) return 'empty';
  if (int) return 'int';
  if (float) return 'float';
  if (bool) return 'bool';
  if (date) return 'date';
  return 'string';
}

/**
 * Turn a string column into typed storage. Numbers go to a Float64Array with a null mask.
 * Ints beyond 2^53 stay strings so no digits are lost.
 */
function convertStringColumn(values, type) {
  const n = values.length;
  if (type === 'int' || type === 'float') {
    const out = new Float64Array(n);
    let nulls = null;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === '' || v === undefined) { (nulls || (nulls = new Uint8Array(n)))[i] = 1; continue; }
      const num = Number(v);
      if (type === 'int' && !Number.isSafeInteger(num)) return { values, nulls: null, type: 'string' };
      out[i] = num;
    }
    return { values: out, nulls, type };
  }
  if (type === 'bool') {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      out[i] = v === '' || v === undefined ? null : v.toLowerCase() === 'true';
    }
    return { values: out, nulls: null, type };
  }
  // strings and ISO dates stay strings (ISO sorts correctly as text); '' means empty
  return { values, nulls: null, type: type === 'empty' ? 'string' : type };
}

/** Store an all-number column as a Float64Array with a null mask (faster sort, less memory). */
function packNumeric(col) {
  const v = col.values;
  if (v instanceof Float64Array) return col;
  const n = v.length;
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x !== null && x !== undefined && typeof x !== 'number') return col;
  }
  const out = new Float64Array(n);
  let nulls = null;
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x === null || x === undefined) (nulls || (nulls = new Uint8Array(n)))[i] = 1;
    else out[i] = x;
  }
  return { values: out, nulls };
}

function isNullish(v) { return v === null || v === undefined; }

function bytesToHex(b) {
  const max = Math.min(b.length, 32);
  let s = '0x';
  for (let i = 0; i < max; i++) s += b[i].toString(16).padStart(2, '0');
  if (b.length > max) s += `… (${b.length} bytes)`;
  return s;
}

function jsonReplacer(_k, v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return bytesToHex(v);
  return v;
}

/** Text for one value. type helps with dates. */
function formatValue(v, type) {
  if (isNullish(v)) return null;
  switch (typeof v) {
    case 'string': return v;
    case 'number': return Number.isFinite(v) ? String(v) : String(v);
    case 'bigint': return v.toString();
    case 'boolean': return v ? 'true' : 'false';
    default: break;
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return 'Invalid date';
    const iso = v.toISOString();
    if (type === 'date' && iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
    return iso.endsWith('.000Z') ? iso.slice(0, 19) + 'Z' : iso;
  }
  if (v instanceof Uint8Array) return bytesToHex(v);
  try { return JSON.stringify(v, jsonReplacer); } catch { return String(v); }
}

/** Value for JSON output (keeps numbers and booleans as JSON types). */
function jsonValue(v, type) {
  if (isNullish(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof Date || v instanceof Uint8Array) return formatValue(v, type);
  return JSON.parse(JSON.stringify(v, jsonReplacer));
}

/** Sort key: number, bigint or string. null stays null (always last). */
function sortKey(v) {
  if (isNullish(v)) return null;
  const t = typeof v;
  if (t === 'number' || t === 'bigint' || t === 'string') return v;
  if (t === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  return formatValue(v);
}

function compareKeys(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ta = typeof a, tb = typeof b;
  if (ta === tb || (ta !== 'string' && tb !== 'string')) return a < b ? -1 : a > b ? 1 : 0;
  // mixed number/text: numbers first
  return ta === 'string' ? 1 : -1;
}

/** Parse a column filter. Numbers accept >, >=, <, <=, =, !=, a..b. Text: contains, =exact, !not, "empty"/"!empty". */
function parseFilter(expr, numeric) {
  const raw = String(expr || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  if (low === 'empty' || low === 'null') return v => isNullish(v) || v === '';
  if (low === '!empty' || low === '!null') return v => !(isNullish(v) || v === '');
  if (numeric) {
    const range = raw.match(/^(-?[\d.eE+]+)\s*\.\.\s*(-?[\d.eE+]+)$/);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return v => !isNullish(v) && Number(v) >= a && Number(v) <= b;
    }
    const m = raw.match(/^(>=|<=|!=|>|<|=)\s*(-?[\d.eE+]+)$/);
    if (m) {
      const x = Number(m[2]);
      if (!Number.isNaN(x)) {
        const op = m[1];
        return v => {
          if (isNullish(v) || v === '') return false;
          const n = Number(v);
          switch (op) {
            case '>': return n > x;
            case '>=': return n >= x;
            case '<': return n < x;
            case '<=': return n <= x;
            case '=': return n === x;
            default: return n !== x;
          }
        };
      }
    }
  }
  if (raw.startsWith('=')) {
    const t = raw.slice(1).toLowerCase();
    return v => !isNullish(v) && String(formatValue(v)).toLowerCase() === t;
  }
  if (raw.startsWith('!') && raw.length > 1) {
    const t = raw.slice(1).toLowerCase();
    return v => isNullish(v) || !String(formatValue(v)).toLowerCase().includes(t);
  }
  return v => !isNullish(v) && String(formatValue(v)).toLowerCase().includes(low);
}

function csvEscape(s, d) {
  if (s === null) return '';
  if (s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const NUMERIC = new Set(['int', 'float', 'decimal', 'bigint']);

class Table {
  /**
   * @param {{name:string,type:string,detail?:string}[]} columns
   * @param {{values:ArrayLike<any>, nulls?:Uint8Array|null}[]} data column storage
   * @param {number} rowCount
   */
  constructor(columns, data, rowCount) {
    this.columns = uniqueNames(columns);
    this.data = data;
    this.rowCount = rowCount;
    this.index = null; // Uint32Array of row ids in view order, or null for identity
    this.sort = null; // {col, dir}
    this.filters = { global: '', columns: {} };
  }

  get(row, col) {
    const c = this.data[col];
    if (c.nulls && c.nulls[row]) return null;
    const v = c.values[row];
    return v === undefined ? null : v;
  }

  get viewCount() { return this.index ? this.index.length : this.rowCount; }

  rowId(viewRow) { return this.index ? this.index[viewRow] : viewRow; }

  /** Rows [start, start+count) of the view as display strings (null for empty). */
  getRows(start, count) {
    const end = Math.min(this.viewCount, start + count);
    const out = [];
    const nc = this.columns.length;
    for (let r = Math.max(0, start); r < end; r++) {
      const id = this.rowId(r);
      const row = new Array(nc);
      for (let c = 0; c < nc; c++) {
        let s = formatValue(this.get(id, c), this.columns[c].type);
        if (s !== null && s.length > MAX_CELL_CHARS) s = s.slice(0, MAX_CELL_CHARS) + '…';
        row[c] = s;
      }
      out.push({ id, cells: row });
    }
    return out;
  }

  setSort(col, dir) {
    if (col === null || col === undefined || dir === null || dir === undefined) this.sort = null;
    else this.sort = { col, dir: dir === 'desc' ? 'desc' : 'asc' };
    this.rebuild();
  }

  setFilters(filters) {
    this.filters = { global: String(filters.global || ''), columns: { ...(filters.columns || {}) } };
    this.rebuild();
  }

  rebuild() {
    const n = this.rowCount;
    const preds = [];
    for (const [k, expr] of Object.entries(this.filters.columns)) {
      const col = Number(k);
      if (!Number.isInteger(col) || col < 0 || col >= this.columns.length) continue;
      const p = parseFilter(expr, NUMERIC.has(this.columns[col].type));
      if (p) preds.push([col, p]);
    }
    const g = this.filters.global.trim().toLowerCase();
    let ids = null;
    if (preds.length || g) {
      const keep = new Uint32Array(n);
      let m = 0;
      const nc = this.columns.length;
      for (let r = 0; r < n; r++) {
        let ok = true;
        for (let i = 0; i < preds.length; i++) {
          if (!preds[i][1](this.get(r, preds[i][0]))) { ok = false; break; }
        }
        if (ok && g) {
          ok = false;
          for (let c = 0; c < nc; c++) {
            const v = this.get(r, c);
            if (!isNullish(v) && String(formatValue(v)).toLowerCase().includes(g)) { ok = true; break; }
          }
        }
        if (ok) keep[m++] = r;
      }
      ids = keep.slice(0, m);
    }
    if (this.sort) {
      if (!ids) { ids = new Uint32Array(n); for (let i = 0; i < n; i++) ids[i] = i; }
      const col = this.sort.col;
      const c = this.data[col];
      const sign = this.sort.dir === 'desc' ? -1 : 1;
      if (c.values instanceof Float64Array) {
        const v = c.values, nulls = c.nulls;
        ids.sort((a, b) => {
          const na = nulls && nulls[a], nb = nulls && nulls[b];
          if (na || nb) return na && nb ? a - b : na ? 1 : -1;
          return (v[a] - v[b]) * sign || a - b;
        });
      } else {
        const keys = new Array(n);
        for (let i = 0; i < ids.length; i++) keys[ids[i]] = sortKey(this.get(ids[i], col));
        ids.sort((a, b) => {
          const ka = keys[a], kb = keys[b];
          if (ka === null || kb === null) return ka === kb ? a - b : ka === null ? 1 : -1;
          return compareKeys(ka, kb) * sign || a - b;
        });
      }
    }
    this.index = ids;
  }

  /**
   * Text for a rectangular selection of the view. format: 'csv' | 'tsv' | 'json'.
   * Returns {text, rows, truncated}.
   */
  copy(sel, format, maxRows = 100000) {
    const r0 = clamp(Math.min(sel.r0, sel.r1), 0, this.viewCount - 1);
    const r1 = clamp(Math.max(sel.r0, sel.r1), 0, this.viewCount - 1);
    const c0 = clamp(Math.min(sel.c0, sel.c1), 0, this.columns.length - 1);
    const c1 = clamp(Math.max(sel.c0, sel.c1), 0, this.columns.length - 1);
    if (this.viewCount === 0 || this.columns.length === 0) return { text: '', rows: 0, truncated: false };
    let last = r1;
    const truncated = r1 - r0 + 1 > maxRows;
    if (truncated) last = r0 + maxRows - 1;
    const cols = [];
    for (let c = c0; c <= c1; c++) cols.push(c);
    const parts = [];
    if (format === 'json') {
      const arr = [];
      for (let r = r0; r <= last; r++) {
        const id = this.rowId(r);
        const o = {};
        for (const c of cols) o[this.columns[c].name] = jsonValue(this.get(id, c), this.columns[c].type);
        arr.push(o);
      }
      return { text: JSON.stringify(arr, null, 2), rows: arr.length, truncated };
    }
    const d = format === 'tsv' ? '\t' : ',';
    const withHeader = sel.header !== false;
    if (withHeader) parts.push(cols.map(c => csvEscape(this.columns[c].name, d)).join(d));
    for (let r = r0; r <= last; r++) {
      const id = this.rowId(r);
      parts.push(cols.map(c => csvEscape(formatValue(this.get(id, c), this.columns[c].type), d)).join(d));
    }
    return { text: parts.join('\r\n'), rows: last - r0 + 1, truncated };
  }
}

function clamp(v, lo, hi) { v = Math.floor(Number(v)); if (Number.isNaN(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }

function uniqueNames(columns) {
  const seen = new Map();
  return columns.map((c, i) => {
    let name = c.name === undefined || c.name === null || String(c.name).trim() === '' ? `column_${i + 1}` : String(c.name);
    if (seen.has(name)) {
      let k = seen.get(name) + 1;
      while (seen.has(`${name}_${k}`)) k++;
      seen.set(name, k);
      name = `${name}_${k}`;
    }
    seen.set(name, 1);
    return { ...c, name };
  });
}

/** Build a Table from string rows (CSV/TSV). First row is the header when header=true. */
function tableFromStringColumns(header, cols, rowCount) {
  const columns = [];
  const data = [];
  for (let c = 0; c < cols.length; c++) {
    const t = inferStringType(cols[c]);
    const conv = convertStringColumn(cols[c], t);
    columns.push({ name: header[c], type: conv.type });
    data.push({ values: conv.values, nulls: conv.nulls });
  }
  return new Table(columns, data, rowCount);
}

module.exports = {
  Table, inferStringType, convertStringColumn, formatValue, jsonValue, parseFilter, csvEscape,
  compareKeys, sortKey, tableFromStringColumns, packNumeric, uniqueNames, NUMERIC,
};
