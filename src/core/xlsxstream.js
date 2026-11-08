'use strict';
// Streaming reader for .xlsx / .xlsm worksheets.
//
// SheetJS reads a whole workbook into memory as JS strings and cell objects before anything can be shown.
// This module reads the ZIP central directory itself, inflates only the parts it needs and scans the
// worksheet XML as it streams out of zlib, with a hand-written byte scanner (no DOM, no XML library).
// Cell values are decoded straight from the inflated bytes, so the sheet XML is never held as one string
// and no value keeps a large parent string alive.
//
// The output mirrors what src/core/readers.js gets from SheetJS today:
//   XLSX.read(buf, {dense:true, cellDates:true, UTC:true, ...}) +
//   XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false, UTC:true})
// (see readSheet() below for the exact contract and the few documented differences).
//
// Anything this module does not handle (Strict OOXML, prefixed main namespace, encrypted or odd ZIPs)
// throws, so the caller can fall back to SheetJS. Errors with code 'XLSX_STREAM_UNSUPPORTED' mean "valid
// file, use SheetJS"; code 'XLSX_TOO_BIG' means a safety limit was hit; anything else is a damaged file.
//
// Dependencies: fs, zlib, stream, and require('xlsx') only for XLSX.SSF (number format rendering).

const fs = require('fs');
const zlib = require('zlib');
const { Readable, pipeline } = require('stream');

const MB = 1024 * 1024;
const MAX_COLS = 16384; // Excel's column limit (XFD). Cells beyond it are ignored.
const TRUST_DIM_WIDTH = 4096; // a <dimension> wider than this does not pre-size rows (hostile/odd files)
const READ_CHUNK = 1 << 20; // bytes per read from the file
const INFLATE_CHUNK = 256 * 1024; // bytes per inflated chunk (small first chunk = fast preview)
// The scanners keep the unfinished tail of a chunk (a row, a shared string, the sheet head) and join it to the
// next chunk. A tail that keeps growing is copied again on every chunk, so one huge row (a 300 MB cell) would
// cost gigabytes of copies. Past this size the workbook goes to SheetJS instead (as in 0.3.3).
const MAX_CARRY = 8 * MB;
const carryLimit = (buf, what) => { if (buf && buf.length > MAX_CARRY) throw unsupported(`${what} is larger than ${MAX_CARRY / MB} MB`); return buf; };
const DEFAULTS = {
  maxInflatedMB: 4096, // cap on the inflated size of any one ZIP part
  maxSharedStringChars: 512 * 1024 * 1024, // cap on total characters in sharedStrings.xml
  maxSharedStrings: 50 * 1000 * 1000, // cap on the number of shared strings
  maxCells: 100 * 1000 * 1000, // cap on stored rows x width (row arrays are dense)
};

let ssfMod = null;
function SSF() {
  if (!ssfMod) ssfMod = require('xlsx').SSF;
  return ssfMod;
}

function fail(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}
const unsupported = why => fail(`Streaming reader does not support this workbook: ${why}`, 'XLSX_STREAM_UNSUPPORTED');
const tooBig = why => fail(`Workbook exceeds a safety limit: ${why}`, 'XLSX_TOO_BIG');

// ---------------------------------------------------------------------------------------------------------
// Byte source: a file path (read through a file handle / read streams) or bytes in memory.

class Source {
  static async open(desc) {
    const s = new Source();
    if (desc && desc.bytes) {
      const b = desc.bytes;
      s.bytes = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer || b, b.byteOffset || 0, b.byteLength);
      s.size = s.bytes.length;
      s.fh = null;
    } else if (desc && desc.path) {
      s.path = desc.path;
      s.fh = await fs.promises.open(desc.path, 'r');
      try {
        const st = await s.fh.stat();
        s.size = st.size;
        s.mtimeMs = st.mtimeMs;
      } catch (e) { await s.fh.close(); throw e; }
    } else {
      throw new TypeError('openXlsx: source must be {path} or {bytes}');
    }
    return s;
  }

  async read(pos, len) {
    if (!(pos >= 0) || !(len >= 0) || pos + len > this.size) throw fail('Damaged ZIP: data points outside the file');
    if (this.bytes) return this.bytes.subarray(pos, pos + len);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await this.fh.read(buf, off, len - off, pos + off);
      if (bytesRead === 0) throw fail('Damaged ZIP: unexpected end of file');
      off += bytesRead;
    }
    return buf;
  }

  /** Async iterator over [start, start+len) in chunks. */
  async *range(start, len) {
    if (len <= 0) return;
    if (this.bytes) {
      for (let i = 0; i < len; i += READ_CHUNK) yield this.bytes.subarray(start + i, start + Math.min(len, i + READ_CHUNK));
      return;
    }
    const rs = fs.createReadStream(this.path, { start, end: start + len - 1, highWaterMark: READ_CHUNK });
    let got = 0;
    try {
      for await (const c of rs) { got += c.length; yield c; }
    } finally {
      rs.destroy();
    }
    if (got < len) throw fail('Damaged ZIP: unexpected end of file');
  }

  async close() {
    if (this.fh) { const fh = this.fh; this.fh = null; await fh.close(); }
  }
}

// ---------------------------------------------------------------------------------------------------------
// ZIP: end of central directory, central directory, local headers. Stored (0) and deflate (8); zip64.

function u64(buf, off) {
  const lo = buf.readUInt32LE(off), hi = buf.readUInt32LE(off + 4);
  if (hi >= 0x200000) throw fail('Damaged ZIP: 64-bit value out of range');
  return hi * 0x100000000 + lo;
}

function normName(name) {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

async function readCentralDirectory(src) {
  const size = src.size;
  if (size < 22) throw fail('Not a ZIP file (too small)');
  const tailLen = Math.min(size, 0xffff + 22 + 20);
  const tail = await src.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06
      && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('Not a ZIP file (no end of central directory record)');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const recOff = u64(tail, loc + 8);
      const rec = await src.read(recOff, 56);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw fail('Damaged ZIP: bad zip64 end of central directory');
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOff = u64(rec, 48);
    }
  }
  if (cdOff + cdSize > size) throw fail('Damaged ZIP: central directory points outside the file');
  if (cdSize > 256 * MB) throw tooBig('ZIP central directory is larger than 256 MB');
  if (count * 46 > cdSize) throw fail('Damaged ZIP: central directory is too small for its entry count');
  const cd = Buffer.from(await src.read(cdOff, cdSize)); // copy: keep no view of a big buffer
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw fail('Damaged ZIP: bad central directory entry');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let rawSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw fail('Damaged ZIP: central directory entry overruns');
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // zip64 extended information extra field (id 1): only the fields whose 32-bit value is 0xFFFFFFFF.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        const qEnd = Math.min(eEnd, q + len);
        if (rawSize === 0xffffffff && q + 8 <= qEnd) { rawSize = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff && q + 8 <= qEnd) { compSize = u64(cd, q); q += 8; }
        if (localOffset === 0xffffffff && q + 8 <= qEnd) { localOffset = u64(cd, q); q += 8; }
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.set(normName(name), { name, flags, method, compSize, rawSize, localOffset });
  }
  return entries;
}

/** Offset of an entry's compressed data (after its local header). Checks that it lies inside the file. */
async function dataStart(src, entry) {
  if (entry.flags & 1) throw unsupported('encrypted ZIP entry');
  if (entry.method !== 0 && entry.method !== 8) throw unsupported(`ZIP compression method ${entry.method}`);
  if (entry.localOffset + 30 > src.size) throw fail('Damaged ZIP: local header points outside the file');
  const h = await src.read(entry.localOffset, 30);
  if (h.readUInt32LE(0) !== 0x04034b50) throw fail('Damaged ZIP: bad local header');
  const start = entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  if (start + entry.compSize > src.size) throw fail('Damaged ZIP: entry data runs past the end of the file');
  return start;
}

/** Whole small part as a UTF-8 string (workbook, rels, styles). */
async function readPartText(src, entry, capBytes) {
  const start = await dataStart(src, entry);
  const comp = await src.read(start, entry.compSize);
  let out;
  if (entry.method === 0) {
    if (comp.length > capBytes) throw tooBig(`${entry.name} inflates to more than the limit`);
    out = comp;
  } else {
    try {
      out = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(1, Math.min(capBytes, require('buffer').constants.MAX_LENGTH)) });
    } catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw tooBig(`${entry.name} inflates to more than the limit`);
      throw fail(`Damaged ZIP entry ${entry.name}: ${e && e.message}`);
    }
  }
  let s = out.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

/** Async iterator of inflated Buffers of one part, with the inflated-size cap enforced while streaming. */
async function* partChunks(src, entry, capBytes) {
  const start = await dataStart(src, entry);
  let total = 0;
  if (entry.method === 0) {
    for await (const c of src.range(start, entry.compSize)) {
      total += c.length;
      if (total > capBytes) throw tooBig(`${entry.name} inflates to more than the limit`);
      yield c;
    }
    return;
  }
  const inflater = zlib.createInflateRaw({ chunkSize: INFLATE_CHUNK });
  const input = Readable.from(src.range(start, entry.compSize), { objectMode: false });
  pipeline(input, inflater, () => {}); // errors surface through the inflater's async iterator
  try {
    for await (const c of inflater) {
      total += c.length;
      if (total > capBytes) throw tooBig(`${entry.name} inflates to more than the limit`);
      yield c;
    }
  } catch (e) {
    if (e && (e.code === 'XLSX_TOO_BIG' || e.code === 'XLSX_STREAM_UNSUPPORTED')) throw e;
    if (e && e.code && String(e.code).startsWith('Z_')) throw fail(`Damaged ZIP entry ${entry.name}: ${e.message}`);
    throw e;
  } finally {
    inflater.destroy();
    input.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Small XML helpers (for workbook / rels / styles, which are small strings).

const ENT_RE = /&(?:(quot)|(apos)|(gt)|(lt)|(amp)|#(x[0-9a-fA-F]+|[0-9]+));/g;
const CODE_RE = /_x([0-9a-fA-F]{4})_/gi;
function entRepl(m, quot, apos, gt, lt, amp, num) {
  if (quot) return '"';
  if (apos) return "'";
  if (gt) return '>';
  if (lt) return '<';
  if (amp) return '&';
  const code = num.charCodeAt(0) === 120 ? parseInt(num.slice(1), 16) : parseInt(num, 10);
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
}
function codeRepl(m, hex) { return String.fromCharCode(parseInt(hex, 16)); }

/**
 * XML text as SheetJS unescapexml() decodes it: the five named entities, numeric character references,
 * then Excel's _xHHHH_ escapes; with crlf, CRLF becomes LF (SheetJS does that for cell text and formulas).
 */
function unescapeXml(s, crlf) {
  if (s.indexOf('&') >= 0) s = s.replace(ENT_RE, entRepl);
  if (s.indexOf('_') >= 0) s = s.replace(CODE_RE, codeRepl);
  if (crlf && s.indexOf('\r\n') >= 0) s = s.replace(/\r\n/g, '\n');
  return s;
}

/** Attributes of one start tag (string). Keys keep their prefix ("r:id"). No prototype. */
function tagAttrs(tag) {
  const o = Object.create(null);
  const re = /([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) o[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3], false);
  return o;
}

function stripComments(s) { return s.indexOf('<!--') >= 0 ? s.replace(/<!--[\s\S]*?-->/g, '') : s; }

/** Root element start tag of an XML document (skips the declaration, comments and doctype). */
function rootTag(s) {
  let i = 0;
  for (;;) {
    i = s.indexOf('<', i);
    if (i < 0) return null;
    const c = s.charCodeAt(i + 1);
    if (c === 63 /* ? */ || c === 33 /* ! */) { i = s.indexOf('>', i); if (i < 0) return null; continue; }
    const gt = s.indexOf('>', i);
    return gt < 0 ? null : s.slice(i, gt + 1);
  }
}

const STRICT_NS = 'purl.oclc.org/ooxml';
function checkRoot(tag, part, expected) {
  if (!tag) throw fail(`Damaged workbook: ${part} has no root element`);
  const name = /^<([^\s>/]+)/.exec(tag)[1];
  if (tag.indexOf(STRICT_NS) >= 0) throw unsupported(`${part} is Strict Open XML`);
  if (name.indexOf(':') >= 0) throw unsupported(`${part} uses a namespace prefix (${name})`);
  if (expected && name !== expected) throw unsupported(`${part} root is <${name}>, expected <${expected}>`);
}

function parsexmlbool(v) { return v === '1' || v === 'true'; }

function partDir(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
function relsPathFor(p) { const i = p.lastIndexOf('/'); return `${p.slice(0, i + 1)}_rels/${p.slice(i + 1)}.rels`; }
function resolveTarget(base, target) {
  let t = target.replace(/\\/g, '/');
  const out = [];
  if (t.startsWith('/')) t = t.slice(1); else out.push(...partDir(base).split('/').filter(Boolean));
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

/** Relationships of a part: Map Id -> {type, target(path in package)} */
function parseRels(xml, basePart) {
  const rels = new Map();
  if (!xml) return rels;
  const re = /<(?:\w+:)?Relationship\b[^>]*>/g;
  let m;
  while ((m = re.exec(stripComments(xml)))) {
    const a = tagAttrs(m[0]);
    if (!a.Id || !a.Target || a.TargetMode === 'External') continue;
    rels.set(a.Id, { type: a.Type || '', target: resolveTarget(basePart, a.Target) });
  }
  return rels;
}

// ---------------------------------------------------------------------------------------------------------
// Number formats. Per workbook table (SheetJS keeps one global table; we copy its defaults).

/* SheetJS SSF_init_table */
const BUILTIN_FMT = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  12: '# ?/?', 13: '# ??/??', 14: 'm/d/yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss',
  46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@', 56: '"上午/下午 "hh"時"mm"分"ss"秒 "',
};
/* SheetJS SSFImplicit: used for ids missing from the table (copied verbatim, escapes included) */
/* eslint-disable no-useless-escape */
const IMPLICIT_FMT = {
  5: '"$"#,##0_);\\("$"#,##0\\)', 6: '"$"#,##0_);[Red]\\("$"#,##0\\)', 7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)', 23: 'General', 24: 'General', 25: 'General', 26: 'General',
  27: 'm/d/yy', 28: 'm/d/yy', 29: 'm/d/yy', 30: 'm/d/yy', 31: 'm/d/yy', 32: 'h:mm:ss', 33: 'h:mm:ss',
  34: 'h:mm:ss', 35: 'h:mm:ss', 36: 'm/d/yy',
  41: '_(* #,##0_);_(* \(#,##0\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \(#,##0\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \(#,##0.00\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \(#,##0.00\);_("$"* "-"??_);_(@_)',
  50: 'm/d/yy', 51: 'm/d/yy', 52: 'm/d/yy', 53: 'm/d/yy', 54: 'm/d/yy', 55: 'm/d/yy', 56: 'm/d/yy',
  57: 'm/d/yy', 58: 'm/d/yy', 59: '0', 60: '0.00', 61: '#,##0', 62: '#,##0.00',
  63: '"$"#,##0_);\\("$"#,##0\\)', 64: '"$"#,##0_);[Red]\\("$"#,##0\\)', 65: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  66: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)', 67: '0%', 68: '0.00%', 69: '# ?/?', 70: '# ??/??',
  71: 'm/d/yy', 72: 'm/d/yy', 73: 'd-mmm-yy', 74: 'd-mmm', 75: 'mmm-yy', 76: 'h:mm', 77: 'h:mm:ss',
  78: 'm/d/yy h:mm', 79: 'mm:ss', 80: '[h]:mm:ss', 81: 'mmss.0',
};
/* eslint-enable no-useless-escape */

/**
 * styles.xml -> per cell-xf format info: {fmt: format string, general: id 0 or "General", date: SSF.is_date}.
 * Returns null when there is no <cellXfs> (SheetJS then applies no formats and no date conversion).
 */
function parseStyles(xml) {
  if (!xml) return null;
  xml = stripComments(xml);
  const table = Object.create(null);
  for (const k of Object.keys(BUILTIN_FMT)) table[k] = BUILTIN_FMT[k];
  const nf = /<(?:\w+:)?numFmts\b[^>]*>([\s\S]*?)<\/(?:\w+:)?numFmts>/.exec(xml);
  if (nf) {
    const re = /<(?:\w+:)?numFmt\b[^>]*>/g;
    let m;
    while ((m = re.exec(nf[1]))) {
      const a = tagAttrs(m[0]);
      const id = parseInt(a.numFmtId, 10);
      if (id >= 0 && id < 100000 && typeof a.formatCode === 'string') table[id] = a.formatCode;
    }
  }
  const cx = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml);
  if (!cx) return null;
  const xfs = [];
  const cache = new Map();
  const re = /<(?:\w+:)?xf\b[^>]*>/g;
  let m;
  while ((m = re.exec(cx[1]))) {
    const a = tagAttrs(m[0]);
    const id = a.numFmtId ? parseInt(a.numFmtId, 10) || 0 : 0;
    let info = cache.get(id);
    if (!info) {
      const fmt = table[id] != null ? table[id] : (IMPLICIT_FMT[id] || 'General');
      let date = false;
      try { date = !!SSF().is_date(fmt); } catch { date = false; }
      info = { id, fmt, general: id === 0 || fmt === 'General', date };
      cache.set(id, info);
    }
    xfs.push(info);
  }
  return xfs;
}

const GENERAL_XF = { id: 0, fmt: 'General', general: true, date: false };

// ---------------------------------------------------------------------------------------------------------
// Dates, exactly as SheetJS computes them (numdate / datenum / parseDate), all in UTC.

const DNTHRESH = Date.UTC(1899, 11, 30, 0, 0, 0);
const DNTHRESH1 = Date.UTC(1899, 11, 31, 0, 0, 0);
const DNTHRESH2 = Date.UTC(1904, 0, 1, 0, 0, 0);
function numdate(v) {
  if (v >= 60 && v < 61) return v; // 1900-02-29 does not exist: SheetJS keeps the number
  const out = new Date();
  out.setTime((v > 60 ? v : (v + 1)) * 24 * 60 * 60 * 1000 + DNTHRESH); // same operation order as SheetJS
  return out;
}
function datenum(d, date1904) {
  const res = (d.getTime() - DNTHRESH) / (24 * 60 * 60 * 1000);
  if (date1904) { const r = res - 1462; return r < -1402 ? r - 1 : r; }
  return res < 60 ? res - 1 : res;
}
const PDRE1 = /^(\d+):(\d+)(:\d+)?(\.\d+)?$/;
const PDRE2 = /^(\d+)-(\d+)-(\d+)$/;
const PDRE3 = /^(\d+)-(\d+)-(\d+)[T ](\d+):(\d+)(:\d+)?(\.\d+)?$/;
function parseDate(str, date1904) {
  let m = str.match(PDRE1);
  if (m) return new Date((date1904 ? DNTHRESH2 : DNTHRESH1) + ((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 60 + (m[3] ? parseInt(m[3].slice(1), 10) : 0)) * 1000 + (m[4] ? parseInt((m[4] + '000').slice(1, 4), 10) : 0));
  m = str.match(PDRE2);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0));
  m = str.match(PDRE3);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], ((m[6] && parseInt(m[6].slice(1), 10)) || 0), ((m[7] && parseInt((m[7] + '0000').slice(1, 4), 10)) || 0)));
  return new Date(str);
}

// ---------------------------------------------------------------------------------------------------------
// Formulas: shared formula expansion (as SheetJS shift_formula_xlsx), but string literals, quoted sheet
// names and [bracketed] parts (structured refs, external book indexes) are left alone.

const CREF = /(^|[^._A-Z0-9])([$]?)([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])([$]?)(10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})(?![_.(A-Za-z0-9])/g;
function decodeCol(s) { let c = 0; for (let i = 0; i < s.length; i++) c = 26 * c + s.charCodeAt(i) - 64; return c - 1; }
function encodeCol(c) {
  if (c < 0) return '';
  let s = '';
  for (++c; c; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(((c - 1) % 26) + 65) + s;
  return s;
}
function shiftPart(s, dr, dc) {
  return s.replace(CREF, ($0, $1, $2, $3, $4, $5) => $1
    + ($2 === '$' ? $2 + $3 : encodeCol(decodeCol($3) + dc))
    + ($4 === '$' ? $4 + $5 : String(parseInt($5, 10) + dr)));
}
function shiftFormula(f, dr, dc) {
  if (!dr && !dc) return f;
  if (f.indexOf('"') < 0 && f.indexOf("'") < 0 && f.indexOf('[') < 0) return shiftPart(f, dr, dc);
  let out = '';
  let seg = 0, i = 0;
  const n = f.length;
  while (i < n) {
    const ch = f.charCodeAt(i);
    if (ch === 34 || ch === 39) { // "string" or 'sheet name' ("" / '' are escaped quotes)
      out += shiftPart(f.slice(seg, i), dr, dc);
      let j = i + 1;
      for (;;) {
        j = f.indexOf(f[i], j);
        if (j < 0) { j = n - 1; break; }
        if (f.charCodeAt(j + 1) === ch) { j += 2; continue; }
        break;
      }
      out += f.slice(i, j + 1);
      i = seg = j + 1;
    } else if (ch === 91) { // [ ... ] possibly nested
      out += shiftPart(f.slice(seg, i), dr, dc);
      let depth = 0, j = i;
      for (; j < n; j++) {
        const cj = f.charCodeAt(j);
        if (cj === 91) depth++;
        else if (cj === 93 && --depth === 0) break;
      }
      out += f.slice(i, j + 1);
      i = seg = j + 1;
    } else i++;
  }
  if (seg < n) out += shiftPart(f.slice(seg), dr, dc);
  return out;
}
const XLFN_RE = /_xlfn\./g;
function xlfn(f) { return f.indexOf('_xlfn.') >= 0 ? f.replace(XLFN_RE, '') : f; }

// ---------------------------------------------------------------------------------------------------------
// Byte-level scanning helpers (buf is a Buffer of inflated XML; a..b are byte offsets).

/** Search needles as Buffers (Buffer#indexOf with a string converts the needle on every call). */
const N_C_END = Buffer.from('</c>'), N_IS_END = Buffer.from('</is>'), N_RPH_END = Buffer.from('</rPh>');
const N_SI = Buffer.from('<si'), N_SI_END = Buffer.from('</si>'), N_ROW_END = Buffer.from('</row>');
const N_SD = Buffer.from('<sheetData'), N_SD_END = Buffer.from('</sheetData>');

/** Whitespace, '>' or '/' : the byte after a tag name. */
function isDelim(x) { return x === 32 || x === 62 || x === 47 || x === 9 || x === 10 || x === 13; }

/** XML text bytes -> string, decoded like SheetJS (see unescapeXml). Always a fresh, flat string. */
function xmlText(buf, a, b, crlf) {
  const s = buf.toString('utf8', a, b);
  if (s.indexOf('&') < 0 && s.indexOf('_') < 0 && (!crlf || s.indexOf('\r') < 0)) return s;
  return unescapeXml(s, crlf);
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16];
/**
 * <v> number -> JS number, equal to parseFloat(text). Fast path: up to 15 digits with an optional sign and
 * decimal point; n / 10^k is then correctly rounded, so it is the same double parseFloat gives.
 */
function numAt(buf, a, b) {
  let i = a, neg = false;
  if (buf[i] === 45) { neg = true; i++; }
  if (b > i && b - i <= 16) {
    let n = 0, digits = 0, frac = -1, j = i;
    for (; j < b; j++) {
      const ch = buf[j];
      if (ch >= 48 && ch <= 57) { n = n * 10 + (ch - 48); digits++; } else if (ch === 46 && frac < 0) frac = j; else break;
    }
    if (j === b && digits > 0 && digits <= 15) {
      if (frac >= 0) n /= POW10[b - frac - 1];
      return neg ? -n : n;
    }
  }
  let s = buf.toString('latin1', a, b);
  if (s.indexOf('&') >= 0 || s.indexOf('_') >= 0) s = unescapeXml(buf.toString('utf8', a, b), false);
  return parseFloat(s);
}

/** Non-negative integer at a..b (shared string index, style index); -1 if not a plain integer. */
function intAt(buf, a, b) {
  if (b <= a || b - a > 15) return -1;
  let n = 0;
  for (let j = a; j < b; j++) {
    const d = buf[j] - 48;
    if (d < 0 || d > 9) return -1;
    n = n * 10 + d;
  }
  return n;
}

/**
 * Text of a string item (<si> body or <is> body), as SheetJS parse_si: a plain <t> gives its text; rich
 * text gives the concatenation of all <t> runs outside <rPh> phonetic runs; neither gives null.
 */
function siText(buf, s, e) {
  let i = s;
  while (i < e && buf[i] <= 32) i++;
  if (i >= e) return '';
  if (buf[i] === 60 && buf[i + 1] === 116 && isDelim(buf[i + 2])) { // <t ...>
    const gt = buf.indexOf(62, i + 2);
    if (gt < 0 || gt >= e || buf[gt - 1] === 47) return '';
    let te = buf.indexOf(60, gt + 1);
    if (te < 0 || te > e) te = e;
    return xmlText(buf, gt + 1, te, true);
  }
  // rich text needs an <r> run somewhere
  let rich = false;
  for (let k = i; ;) {
    const a = buf.indexOf(60, k);
    if (a < 0 || a >= e) break;
    if (buf[a + 1] === 114 && (buf[a + 2] === 62 || buf[a + 2] === 32 || buf[a + 2] === 9 || buf[a + 2] === 10 || buf[a + 2] === 13)) { rich = true; break; }
    k = a + 1;
  }
  if (!rich) return null;
  let parts = '';
  for (let k = i; ;) {
    const a = buf.indexOf(60, k);
    if (a < 0 || a >= e) break;
    const c1 = buf[a + 1];
    if (c1 === 114 && buf[a + 2] === 80 && buf[a + 3] === 104 && isDelim(buf[a + 4])) { // <rPh> ... </rPh>
      const gt = buf.indexOf(62, a + 4);
      if (gt < 0 || gt >= e) break;
      if (buf[gt - 1] === 47) { k = gt + 1; continue; }
      const close = buf.indexOf(N_RPH_END, gt);
      if (close < 0 || close >= e) break;
      k = close + 6;
      continue;
    }
    if (c1 === 116 && isDelim(buf[a + 2])) { // <t>
      const gt = buf.indexOf(62, a + 2);
      if (gt < 0 || gt >= e) break;
      if (buf[gt - 1] === 47) { k = gt + 1; continue; }
      let te = buf.indexOf(60, gt + 1);
      if (te < 0 || te > e) te = e;
      parts += buf.toString('utf8', gt + 1, te);
      k = te;
      continue;
    }
    k = a + 1;
  }
  return unescapeXml(parts, true);
}

// ---------------------------------------------------------------------------------------------------------
// sharedStrings.xml, streamed.

async function readSharedStrings(src, entry, o) {
  const sst = [];
  if (!entry) return sst;
  let chars = 0;
  let carry = null;
  let rootChecked = false;
  for await (const chunk of partChunks(src, entry, o.capBytes)) {
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    let p = 0;
    if (!rootChecked) {
      const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
      const tag = rootTag(head);
      if (!tag) { if (buf.length > 1 * MB) throw fail('Damaged sharedStrings.xml'); carry = buf; continue; }
      checkRoot(tag, 'sharedStrings.xml', 'sst');
      rootChecked = true;
    }
    for (;;) {
      const a = buf.indexOf(N_SI, p);
      if (a < 0) { p = Math.max(p, buf.length - 3); break; }
      const d = buf[a + 3];
      if (d === undefined) { p = a; break; }
      if (!isDelim(d)) { p = a + 3; continue; }
      const gt = buf.indexOf(62, a + 3);
      if (gt < 0) { p = a; break; }
      let text;
      if (buf[gt - 1] === 47) { text = ''; p = gt + 1; } else {
        const end = buf.indexOf(N_SI_END, gt);
        if (end < 0) { p = a; break; }
        text = siText(buf, gt + 1, end);
        p = end + 5;
      }
      if (text !== null) {
        chars += text.length;
        if (chars > o.maxSharedStringChars) throw tooBig('shared strings exceed the character limit');
      }
      sst.push(text);
      if (sst.length > o.maxSharedStrings) throw tooBig('too many shared strings');
    }
    carry = carryLimit(p < buf.length ? Buffer.from(buf.subarray(p)) : null, 'one shared string');
  }
  return sst;
}

// ---------------------------------------------------------------------------------------------------------
// Worksheet scanner.

/** "A1:H10" -> {sc, sr, ec, er} (0-based) or null. Accepts $ anchors. */
function decodeRange(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return null;
  const r = { sc: decodeCol(m[1]), sr: parseInt(m[2], 10) - 1, ec: decodeCol(m[3]), er: parseInt(m[4], 10) - 1 };
  if (!(r.sc >= 0 && r.sr >= 0 && r.sc <= r.ec && r.sr <= r.er && r.sc < MAX_COLS)) return null;
  return r;
}

const T_N = 0, T_S = 1, T_STR = 2, T_INL = 3, T_B = 4, T_E = 5, T_D = 6;
function typeAt(buf, a, b) {
  const len = b - a, c = buf[a];
  if (len === 1) {
    if (c === 115) return T_S; // s
    if (c === 98) return T_B; // b
    if (c === 101) return T_E; // e
    if (c === 100) return T_D; // d
    return T_N;
  }
  if (len === 3 && c === 115 && buf[a + 1] === 116 && buf[a + 2] === 114) return T_STR;
  if (len === 9 && c === 105 && buf.toString('latin1', a, b) === 'inlineStr') return T_INL;
  return T_N; // unknown types read as numbers (SheetJS throws on them)
}

function padRow(row, w) { while (row.length < w) row.push(null); return row; }
function nullRow(w) { return new Array(w).fill(null); }

/**
 * Opens an .xlsx/.xlsm workbook. Reads the ZIP central directory, workbook.xml (+ rels), styles.xml and
 * sharedStrings.xml. The worksheet itself is read (streamed) by readSheet().
 * @param {{path?: string, bytes?: Uint8Array}} source
 * @param {{maxInflatedMB?: number, maxSharedStringChars?: number, maxSharedStrings?: number, maxCells?: number}} [options]
 */
async function openXlsx(source, options) {
  const o = { ...DEFAULTS, ...(options || {}) };
  o.capBytes = Math.max(1, Number(o.maxInflatedMB) || DEFAULTS.maxInflatedMB) * MB;
  const src = await Source.open(source);
  let book;
  try {
    const entries = await readCentralDirectory(src);
    const get = p => entries.get(normName(p));
    const text = async p => { const e = get(p); return e ? readPartText(src, e, o.capBytes) : null; };

    // package rels -> workbook part
    let wbPath = 'xl/workbook.xml';
    const pkgRels = parseRels(await text('_rels/.rels'), '');
    for (const r of pkgRels.values()) if (/\/officeDocument$/.test(r.type) && get(r.target)) { wbPath = r.target; break; }
    if (!get(wbPath)) {
      if (get('xl/workbook.bin')) throw unsupported('.xlsb workbook');
      throw fail('Not an Excel workbook (no xl/workbook.xml)');
    }
    const wbXml = stripComments(await text(wbPath));
    checkRoot(rootTag(wbXml), 'workbook.xml', 'workbook');
    const wbRels = parseRels(await text(relsPathFor(wbPath)), wbPath);

    const pr = /<workbookPr\b[^>]*>/.exec(wbXml);
    const date1904 = pr ? parsexmlbool(tagAttrs(pr[0]).date1904) : false;

    const sheets = [];
    const sheetParts = new Map();
    const sre = /<sheet\b[^>]*>/g;
    let m;
    while ((m = sre.exec(wbXml))) {
      const a = tagAttrs(m[0]);
      let rid = null;
      for (const k of Object.keys(a)) if (/(^|:)id$/.test(k) && k !== 'sheetId') { rid = a[k]; break; }
      const rel = rid ? wbRels.get(rid) : null;
      if (!rel || !/\/worksheet$/.test(rel.type) || typeof a.name !== 'string') continue; // chartsheets etc.
      const entry = get(rel.target);
      if (!entry || sheetParts.has(a.name)) continue;
      sheets.push(a.name);
      sheetParts.set(a.name, entry);
    }

    let sstEntry = null, stylesEntry = null;
    for (const r of wbRels.values()) {
      if (/\/sharedStrings$/.test(r.type) && get(r.target)) sstEntry = get(r.target);
      else if (/\/styles$/.test(r.type) && get(r.target)) stylesEntry = get(r.target);
    }
    if (!sstEntry) sstEntry = get('xl/sharedStrings.xml') || null;
    if (!stylesEntry) stylesEntry = get('xl/styles.xml') || null;

    const xfs = stylesEntry ? parseStyles(await readPartText(src, stylesEntry, o.capBytes)) : null;
    const sst = await readSharedStrings(src, sstEntry, o);
    book = { sheets, sheetParts, date1904, xfs, sst };
  } finally {
    await src.close();
  }

  const ws = {
    sheets: book.sheets.slice(),
    date1904: book.date1904,
    /**
     * Reads one worksheet.
     * @param {string} name sheet name (from ws.sheets)
     * @param {{maxRows?: number, onPreview?: Function, previewRows?: number, countAll?: boolean}} [opts]
     * @returns {Promise<{rows: any[][], shown: (string|null)[][], formulas: (string|null)[][]|null,
     *   totalRows: number|null, width: number, truncated: boolean}>}
     */
    readSheet: (name, opts) => readSheet(source, src.size, src.mtimeMs, book, name, opts || {}, o),
  };
  return ws;
}

/**
 * Worksheet -> rows, as SheetJS sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false}).
 *
 * rows[r][c]  value: number, string, boolean, Date (UTC, date-formatted numbers and t="d"), or null.
 *             Column 0 is the left column of <dimension ref> (when it has a ':' and is sane, like SheetJS);
 *             without one, the leftmost column that has a cell. Every row has `width` entries.
 *             Rows without any value are skipped. Error cells are null (as SheetJS raw output).
 * shown[r]    null, or an array with the text SheetJS keeps in cell.w for number/date/boolean cells
 *             (what sheet_to_json raw:false gives), plus the error text ("#DIV/0!") for error cells (whose
 *             value is null). shown[r][c] is null for strings, empty cells, and numbers whose text equals
 *             String(value) (for example integers in General).
 * formulas    null if no cell in the stored rows has a formula, else formulas[r] is null or an array of
 *             formula text (no '='), shared formulas expanded. Also set for formula cells without a cached
 *             value, which SheetJS drops.
 * totalRows   number of non-blank rows; null when reading stopped early at maxRows (truncated).
 *
 * Early stop: once maxRows+1 non-blank rows are seen, scanning AND inflating stop (the zlib stream is
 * destroyed), so a capped read of a huge sheet costs only the rows it returns. With countAll:true the scan
 * continues to the end (values not stored) so that totalRows is exact.
 */
async function readSheet(sourceDesc, size0, mtime0, book, name, opts, o) {
  const entry = typeof name === 'number' ? book.sheetParts.get(book.sheets[name]) : book.sheetParts.get(name);
  if (!entry) throw fail(`No worksheet named "${name}"`);
  const maxRows = opts.maxRows > 0 ? Math.floor(opts.maxRows) : Infinity;
  const previewRows = opts.previewRows > 0 ? Math.floor(opts.previewRows) : 1000;
  const onPreview = typeof opts.onPreview === 'function' ? opts.onPreview : null;
  const countAll = !!opts.countAll;
  const maxCells = Number(o.maxCells) > 0 ? Number(o.maxCells) : DEFAULTS.maxCells;
  const { xfs, sst, date1904 } = book;
  const ssfOpts = date1904 ? { date1904: true } : {};
  const ssf = SSF();

  const rows = [], shown = [], forms = [];
  let anyFormula = false;
  let haveDim = false, origin = 0, width = 0, minCol = MAX_COLS;
  let count = 0, truncated = false, stopped = false, previewSent = false;
  let rowNum = 0, nextCol = 0;
  let cur = null, curS = null, curF = null, curNonBlank = false;
  const sharedF = new Map(); // si -> {text, r, c}

  function finishRows(rs, ss, fs2, copy) {
    const shift = haveDim || minCol === MAX_COLS ? 0 : minCol;
    const w = Math.max(0, width - shift);
    const fix = (row, isNullable) => {
      if (row === null) return isNullable ? null : nullRow(w);
      let r = copy ? row.slice(shift) : (shift ? (row.splice(0, shift), row) : row);
      if (r.length > w) r.length = w;
      return padRow(r, w);
    };
    const outRows = copy ? new Array(rs.length) : rs;
    for (let i = 0; i < rs.length; i++) outRows[i] = fix(rs[i], false);
    const outShown = copy ? new Array(ss.length) : ss;
    for (let i = 0; i < ss.length; i++) outShown[i] = fix(ss[i], true);
    let outForms = null;
    if (anyFormula) {
      outForms = copy ? new Array(fs2.length) : fs2;
      for (let i = 0; i < fs2.length; i++) outForms[i] = fix(fs2[i], true);
    }
    return { rows: outRows, shown: outShown, formulas: outForms, width: w };
  }

  function endRow() {
    if (curNonBlank) { // (cur is null in counting mode, past maxRows)
      count++;
      if (rows.length < maxRows) {
        rows.push(cur); shown.push(curS); forms.push(curF);
        if (rows.length * width > maxCells) throw tooBig(`sheet has more than ${maxCells} cells`);
      } else {
        truncated = true;
        if (!countAll) stopped = true;
      }
      if (onPreview && !previewSent && count === previewRows + 1 && previewRows < maxRows) {
        previewSent = true;
        const n = Math.min(previewRows, rows.length);
        const p = finishRows(rows.slice(0, n), shown.slice(0, n), forms.slice(0, n), true);
        onPreview(p.rows, p.shown, p.formulas);
      }
    }
    cur = curS = curF = null;
    curNonBlank = false;
  }

  /** Stores one cell. c is the absolute column. */
  function place(c, value, text, formula) {
    const rc = c - origin;
    if (rc < 0) return;
    // past maxRows: only count rows (and do not let them widen the rows that are returned)
    if (rows.length >= maxRows) { if (value !== null) curNonBlank = true; return; }
    if (!haveDim && c < minCol) minCol = c;
    if (rc >= width) width = rc + 1;
    if (value === null && text === null && formula === null) return;
    if (cur === null) cur = nullRow(width); else if (rc >= cur.length) padRow(cur, rc + 1);
    cur[rc] = value;
    if (value !== null) curNonBlank = true;
    if (text !== null) {
      if (curS === null) curS = nullRow(width); else if (rc >= curS.length) padRow(curS, rc + 1);
      curS[rc] = text;
    }
    if (formula !== null) {
      anyFormula = true;
      if (curF === null) curF = nullRow(width); else if (rc >= curF.length) padRow(curF, rc + 1);
      curF[rc] = formula;
    }
  }

  /** Parses one <c ...> at lt; returns the offset after it. */
  function cell(buf, lt, end) {
    const gt = buf.indexOf(62, lt + 2);
    if (gt < 0 || gt >= end) throw fail('Damaged worksheet XML (unterminated cell)');
    const selfClose = buf[gt - 1] === 47;
    // attributes, any order: r (ref), t (type), s (style)
    let col = -1, crow = -1, t = T_N, hasT = false, s = 0;
    const aEnd = selfClose ? gt - 1 : gt;
    let i = lt + 2;
    while (i < aEnd) {
      if (buf[i] <= 32) { i++; continue; }
      const ns = i;
      while (i < aEnd && buf[i] !== 61 && buf[i] > 32) i++;
      const ne = i;
      while (i < aEnd && buf[i] !== 61) i++;
      i++;
      while (i < aEnd && buf[i] <= 32) i++;
      const q = buf[i];
      if (q !== 34 && q !== 39) break;
      const vs = i + 1;
      const ve = buf.indexOf(q, vs);
      if (ve < 0 || ve > aEnd) break;
      i = ve + 1;
      if (ne - ns !== 1) continue;
      const an = buf[ns];
      if (an === 114) { // r="AB12"
        let k = vs, cc = 0;
        for (; k < ve && k - vs < 4; k++) {
          const ch = buf[k];
          if (ch < 65 || ch > 90) break;
          cc = cc * 26 + ch - 64;
        }
        if (k > vs) {
          col = cc - 1;
          if (buf[k] >= 65 && buf[k] <= 90) col = MAX_COLS; // more than 4 letters: out of range
          let rr = 0, nd = 0;
          for (; k < ve && nd < 12; k++, nd++) { const d = buf[k] - 48; if (d < 0 || d > 9) break; rr = rr * 10 + d; }
          if (nd > 0) crow = rr - 1;
        }
      } else if (an === 116) { t = typeAt(buf, vs, ve); hasT = true; } else if (an === 115) { s = intAt(buf, vs, ve); }
    }
    if (col < 0) col = nextCol;
    nextCol = col + 1;
    if (crow < 0) crow = rowNum - 1;

    // children: <v>, <f>, <is>
    let vS = -1, vE = -1, fS = -1, fE = -1, fShared = false, fSelf = false, fSi = -1, hasF = false, isS = -1, isE = -1;
    let next = gt + 1;
    if (!selfClose) {
      const ce = buf.indexOf(N_C_END, gt + 1);
      if (ce < 0 || ce >= end) throw fail('Damaged worksheet XML (unterminated cell)');
      next = ce + 4;
      let k = gt + 1;
      for (;;) {
        const a = buf.indexOf(60, k);
        if (a < 0 || a >= ce) break;
        const n1 = buf[a + 1];
        if (n1 === 118 && isDelim(buf[a + 2])) { // <v>
          const vg = buf.indexOf(62, a + 2);
          if (buf[vg - 1] === 47) { k = vg + 1; continue; }
          const vend = buf.indexOf(60, vg + 1);
          if (vend > vg + 1) { vS = vg + 1; vE = vend; }
          k = vend + 1;
        } else if (n1 === 102 && isDelim(buf[a + 2])) { // <f ...>
          const fg = buf.indexOf(62, a + 2);
          hasF = true;
          // attributes t="shared" si="n"
          const tagStr = buf.toString('latin1', a + 2, fg);
          if (tagStr.indexOf('shared') >= 0) fShared = /\bt\s*=\s*["']shared["']/.test(tagStr);
          const sim = tagStr.indexOf('si') >= 0 ? /\bsi\s*=\s*["'](\d+)["']/.exec(tagStr) : null;
          if (sim) fSi = parseInt(sim[1], 10);
          if (buf[fg - 1] === 47) { fSelf = true; k = fg + 1; continue; }
          const fend = buf.indexOf(60, fg + 1);
          fS = fg + 1; fE = fend;
          k = fend + 1;
        } else if (n1 === 105 && buf[a + 2] === 115 && isDelim(buf[a + 3])) { // <is>
          const ig = buf.indexOf(62, a + 3);
          if (buf[ig - 1] === 47) { isS = isE = ig; k = ig + 1; continue; }
          let iend = buf.indexOf(N_IS_END, ig);
          if (iend < 0 || iend > ce) iend = ce;
          isS = ig + 1; isE = iend;
          k = iend + 1;
        } else k = a + 1;
      }
    }
    if (col >= MAX_COLS) return next;

    // formula text
    let formula = null;
    if (hasF) {
      if (fE > fS) {
        const raw = xmlText(buf, fS, fE, false);
        formula = xlfn(raw.indexOf('\r\n') >= 0 ? raw.replace(/\r\n/g, '\n') : raw);
        if (fShared && fSi >= 0) sharedF.set(fSi, { text: xlfn(raw), r: crow, c: col });
      } else if ((fShared || fSelf) && fSi >= 0) {
        const m = sharedF.get(fSi);
        if (m) formula = shiftFormula(m.text, crow - m.r, col - m.c);
      }
    }

    // value, as SheetJS parse_ws_xml_data + sheet_to_json(raw)
    let value = null, text = null, isErr = false;
    const hasV = vS >= 0;
    switch (t) {
      case T_N:
        if (hasV) value = numAt(buf, vS, vE);
        break;
      case T_S:
        if (hasV) { const idx = intAt(buf, vS, vE); const sv = idx >= 0 && idx < sst.length ? sst[idx] : null; value = sv === undefined ? null : sv; }
        break;
      case T_STR:
        value = hasV ? xmlText(buf, vS, vE, true) : '';
        break;
      case T_INL:
        value = isS >= 0 ? siText(buf, isS, isE) : '';
        break;
      case T_B:
        value = hasV ? parsexmlbool(buf.toString('latin1', vS, vE)) : false;
        text = value ? 'TRUE' : 'FALSE';
        break;
      case T_E:
        // SheetJS raw output gives null for error cells; the error text ("#DIV/0!") goes to shown.
        isErr = true;
        if (hasV) text = xmlText(buf, vS, vE, false);
        break;
      case T_D:
        if (hasV) {
          const d = parseDate(xmlText(buf, vS, vE, false), date1904);
          value = d;
          const xf = xfs ? (xfs[s] || GENERAL_XF) : GENERAL_XF;
          const dn = datenum(d, date1904);
          if (xf.id === 0) text = (dn | 0) === dn ? String(dn) : ssf.format('General', dn);
          else { try { text = ssf.format(xf.fmt, dn, ssfOpts); } catch { text = null; } }
        }
        break;
      default: break;
    }
    if (typeof value === 'number') {
      const xf = xfs ? (xfs[s] || GENERAL_XF) : GENERAL_XF;
      if (xf.general) {
        if ((value | 0) !== value) { const w = ssf.format('General', value); if (w !== String(value)) text = w; }
      } else {
        let w;
        try { w = ssf.format(xf.fmt, value, ssfOpts); } catch { w = ssf.format('General', value); }
        if (w !== String(value)) text = w;
      }
      if (xf.date) value = numdate(value + (date1904 ? 1462 : 0));
    }
    if (value !== null || isErr || formula !== null || hasT) place(col, value, text, formula);
    return next;
  }

  /** Parses complete rows in buf[pos, end). Returns false when </sheetData> was reached. */
  function parseRows(buf, pos, end) {
    let p = pos;
    while (p < end) {
      const lt = buf.indexOf(60, p);
      if (lt < 0 || lt >= end) break;
      const c1 = buf[lt + 1];
      if (c1 === 99 && isDelim(buf[lt + 2])) { // <c
        p = cell(buf, lt, end);
      } else if (c1 === 47) { // </...
        if (buf[lt + 2] === 114 && buf[lt + 3] === 111 && buf[lt + 4] === 119 && buf[lt + 5] === 62) { // </row>
          endRow();
          if (stopped) return false;
          p = lt + 6;
        } else if (buf[lt + 2] === 115 && buf.toString('latin1', lt, lt + 12) === '</sheetData>') {
          endRow();
          return false;
        } else p = lt + 2;
      } else if (c1 === 114 && buf[lt + 2] === 111 && buf[lt + 3] === 119 && isDelim(buf[lt + 4])) { // <row
        endRow();
        const gt = buf.indexOf(62, lt + 4);
        if (gt < 0 || gt >= end) throw fail('Damaged worksheet XML (unterminated row)');
        const tag = buf.toString('latin1', lt + 4, gt);
        const rm = tag.indexOf('r') >= 0 ? /(?:^|\s)r\s*=\s*["'](\d{1,12})["']/.exec(tag) : null;
        rowNum = rm ? parseInt(rm[1], 10) : rowNum + 1;
        nextCol = 0;
        p = gt + 1;
        if (buf[gt - 1] === 47) endRow();
        if (stopped) return false;
      } else {
        const gt = buf.indexOf(62, lt + 1);
        p = gt < 0 ? end : gt + 1;
      }
    }
    return !stopped;
  }

  function parseHead(head) {
    const di = head.indexOf('<dimension');
    if (di >= 0) {
      const m = /"(\w*:\w*)"/.exec(head.slice(di, di + 50)); // same probe as SheetJS (needs a ':')
      const r = m ? decodeRange(m[1]) : null;
      if (r) {
        haveDim = true;
        origin = r.sc;
        const w = Math.min(r.ec, MAX_COLS - 1) - r.sc + 1;
        if (w <= TRUST_DIM_WIDTH) width = w;
      }
    }
  }

  // Re-open the source for streaming; refuse a file that changed since openXlsx.
  const src = await Source.open(sourceDesc);
  let finished = false;
  try {
    if (src.size !== size0 || (mtime0 !== undefined && src.mtimeMs !== mtime0)) throw fail('The workbook changed on disk while it was being read');
    let carry = null;
    let inData = false, rootSeen = false;
    for await (const chunk of partChunks(src, entry, o.capBytes)) {
      if (src.fh) await src.close(); // the stream has its own descriptor; header reads are done
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      let pos = 0;
      if (!inData) {
        if (!rootSeen) { // fail fast on a prefixed / Strict root, before looking for <sheetData>
          const tag = rootTag(buf.toString('utf8', 0, Math.min(buf.length, 64 * 1024)));
          if (tag) { checkRoot(tag, 'worksheet', 'worksheet'); rootSeen = true; } else if (buf.length > 64 * 1024) throw fail('Damaged worksheet XML (no root element)');
        }
        const sd = buf.indexOf(N_SD);
        if (sd < 0) { carry = carryLimit(buf, 'the worksheet head'); continue; }
        const gt = buf.indexOf(62, sd);
        if (gt < 0) { carry = carryLimit(buf, 'the worksheet head'); continue; }
        parseHead(buf.toString('utf8', 0, sd));
        if (buf[gt - 1] === 47) { finished = true; break; } // <sheetData/>
        inData = true;
        pos = gt + 1;
      }
      const last = buf.lastIndexOf(N_ROW_END);
      const sdEnd = buf.indexOf(N_SD_END, Math.max(pos, last));
      if (sdEnd >= 0) { parseRows(buf, pos, sdEnd + 12); finished = true; break; }
      if (last >= pos) {
        if (!parseRows(buf, pos, last + 6)) { finished = true; break; }
        pos = last + 6;
      }
      if (pos < buf.length) carry = carryLimit(Buffer.from(buf.subarray(pos)), 'one row'); // copy: do not pin the whole chunk
    }
    if (!finished && !stopped) {
      if (!inData) throw fail('Damaged worksheet XML (no <sheetData>)');
      throw fail('Damaged worksheet XML (ends inside <sheetData>)');
    }
  } finally {
    await src.close();
  }
  endRow();
  const out = finishRows(rows, shown, forms, false);
  return {
    rows: out.rows,
    shown: out.shown,
    formulas: out.formulas,
    totalRows: truncated && !countAll ? null : count,
    width: out.width,
    truncated,
  };
}

module.exports = { openXlsx };
