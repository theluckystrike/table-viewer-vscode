'use strict';
// File readers: CSV/TSV (streamed), Parquet (hyparquet), Excel/ODS (SheetJS).
// Every reader returns {table, info} and may call onPreview(table, info) early with the first rows.

const fs = require('fs');
const { CsvParser, detectDelimiter } = require('./csv');
const { Table, tableFromStringColumns, packNumeric } = require('./table');

const PREVIEW_ROWS = 1000;
const MB = 1024 * 1024;

const { formatFromPath } = require('./formats');

const DEFAULTS = { maxRows: 1000000, maxFileSizeMB: 512, maxExcelSizeMB: 50 };
// Delimiters the user can pick in the toolbar. 'auto' (or anything else) means: detect.
const CSV_DELIMITERS = [',', '\t', ';', '|', ':'];
/** Name of a headerless column: column_1, column_2, ... */
function genericName(i) { return `column_${i + 1}`; }

function opts(o) {
  const out = { ...DEFAULTS, ...(o || {}) };
  out.maxRows = Math.max(1, Math.floor(Number(out.maxRows) || DEFAULTS.maxRows));
  out.maxFileSizeMB = Math.max(0.001, Number(out.maxFileSizeMB) || DEFAULTS.maxFileSizeMB);
  out.maxExcelSizeMB = Math.max(0.001, Number(out.maxExcelSizeMB) || DEFAULTS.maxExcelSizeMB);
  return out;
}

function sourceSize(source) {
  if (source.bytes) return source.bytes.byteLength;
  return fs.statSync(source.path).size;
}

function fmtMB(n) { return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`; }

// ---------- CSV / TSV ----------

function pickEncoding(head) {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

async function* byteChunks(source, maxBytes) {
  if (source.bytes) {
    const b = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes);
    const end = Math.min(b.byteLength, maxBytes);
    for (let i = 0; i < end; i += MB) {
      yield b.subarray(i, Math.min(end, i + MB));
      await new Promise(r => setImmediate(r));
    }
    return;
  }
  const size = fs.statSync(source.path).size;
  if (size === 0) return;
  const stream = fs.createReadStream(source.path, { highWaterMark: MB, start: 0, end: Math.min(size, maxBytes) - 1 });
  try {
    for await (const chunk of stream) yield chunk;
  } finally {
    stream.destroy();
  }
}

async function loadCsv(source, options, onPreview, format) {
  const o = opts(options);
  const size = sourceSize(source);
  const maxBytes = o.maxFileSizeMB * MB;
  const bytesTruncated = size > maxBytes;
  let header = null;
  let cols = [];
  let rows = 0;
  let decoder = null;
  const forced = CSV_DELIMITERS.includes(o.delimiter) ? o.delimiter : null;
  const hasHeader = o.header !== false;
  let delimiter = forced || (format === 'tsv' ? '\t' : null);
  let parser = null;
  let pending = '';
  let previewSent = false;
  let rowsTruncated = false;

  const info = { format, fileSize: size, delimiter: null, delimiterAuto: !forced, header: hasHeader, truncated: false, truncatedReason: '', totalRows: null };

  const onRow = (fields) => {
    if (header === null) {
      if (hasHeader) {
        header = fields.slice();
        cols = header.map(() => []);
        return;
      }
      // No header row: name the columns column_1.. and keep the first line as data.
      header = fields.map((_, i) => genericName(i));
      cols = header.map(() => []);
    }
    if (fields.length === 1 && fields[0] === '' && header.length > 1) return; // blank line
    if (rows >= o.maxRows) { rowsTruncated = true; parser.stop(); return; }
    while (fields.length > cols.length) {
      const extra = new Array(rows).fill('');
      cols.push(extra);
      header.push(hasHeader ? '' : genericName(header.length));
    }
    for (let c = 0; c < cols.length; c++) cols[c].push(c < fields.length ? fields[c] : '');
    rows++;
    if (!previewSent && rows === PREVIEW_ROWS && onPreview) {
      previewSent = true;
      onPreview(tableFromStringColumns(header, cols.map(c => c.slice(0, PREVIEW_ROWS)), PREVIEW_ROWS), { ...info, loading: true });
    }
  };

  for await (const chunk of byteChunks(source, maxBytes)) {
    let text;
    if (!decoder) {
      const enc = pickEncoding(chunk);
      decoder = new TextDecoder(enc, { fatal: false, ignoreBOM: false });
    }
    text = decoder.decode(chunk, { stream: true });
    if (!parser) {
      pending += text;
      if (pending.length < 64 * 1024 && pending.length < size) continue;
      delimiter = delimiter || detectDelimiter(pending.slice(0, 64 * 1024));
      info.delimiter = delimiter;
      parser = new CsvParser(delimiter, onRow);
      text = pending;
      pending = '';
    }
    parser.push(text);
    if (parser.stopped) break;
  }
  if (!parser) {
    // small file: everything fit in pending
    const text = pending + (decoder ? decoder.decode() : '');
    delimiter = delimiter || detectDelimiter(text.slice(0, 64 * 1024));
    info.delimiter = delimiter;
    parser = new CsvParser(delimiter, onRow);
    parser.push(text);
    parser.end();
  } else if (!parser.stopped && !bytesTruncated) {
    parser.push(decoder.decode());
    parser.end();
  }
  if (header === null) header = [];
  if (rowsTruncated) {
    info.truncated = true;
    info.truncatedReason = `Showing the first ${o.maxRows.toLocaleString('en-US')} rows (limit tableViewer.maxRows).`;
  } else if (bytesTruncated) {
    info.truncated = true;
    info.truncatedReason = `File is ${fmtMB(size)}. Showing the rows in the first ${fmtMB(maxBytes)} (limit tableViewer.maxFileSizeMB).`;
  } else {
    info.totalRows = rows;
  }
  const table = tableFromStringColumns(header, cols, rows);
  return { table, info };
}

// ---------- Parquet ----------

let hyparquetMod = null;
let compressorsMod = null;
async function hyparquet() {
  if (!hyparquetMod) {
    hyparquetMod = await import('hyparquet');
    compressorsMod = await import('hyparquet-compressors');
  }
  return { hp: hyparquetMod, compressors: compressorsMod.compressors };
}

async function asyncBufferFor(source) {
  if (source.bytes) {
    const b = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes);
    return { file: { byteLength: b.byteLength, slice: (s, e) => b.slice(s, e === undefined ? b.byteLength : e).buffer }, close: async () => {} };
  }
  const fh = await fs.promises.open(source.path, 'r');
  const { size } = await fh.stat();
  const file = {
    byteLength: size,
    async slice(start, end) {
      const e = end === undefined ? size : end;
      const len = Math.max(0, e - start);
      const buf = Buffer.allocUnsafeSlow(len);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, start + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + off);
    },
  };
  return { file, close: () => fh.close() };
}

function logicalText(el) {
  const lt = el.logical_type;
  if (lt && lt.type) {
    const extra = [];
    if (lt.unit) extra.push(String(lt.unit).toLowerCase());
    if (lt.isAdjustedToUTC !== undefined) extra.push(lt.isAdjustedToUTC ? 'UTC' : 'local');
    if (lt.precision !== undefined) extra.push(`${lt.precision},${lt.scale ?? 0}`);
    if (lt.bitWidth !== undefined) extra.push(`${lt.isSigned === false ? 'u' : ''}int${lt.bitWidth}`);
    return extra.length ? `${lt.type}(${extra.join(', ')})` : lt.type;
  }
  return el.converted_type || '';
}

function parquetType(node) {
  const el = node.element;
  const lt = (el.logical_type && el.logical_type.type) || el.converted_type || '';
  if (node.children && node.children.length) {
    if (lt === 'LIST') return 'list';
    if (lt === 'MAP' || lt === 'MAP_KEY_VALUE') return 'map';
    return 'struct';
  }
  if (el.repetition_type === 'REPEATED') return 'list';
  switch (lt) {
    case 'STRING': case 'UTF8': case 'ENUM': case 'UUID': return 'string';
    case 'JSON': case 'BSON': return 'json';
    case 'DATE': return 'date';
    case 'TIMESTAMP': case 'TIMESTAMP_MILLIS': case 'TIMESTAMP_MICROS': return 'timestamp';
    case 'TIME': case 'TIME_MILLIS': case 'TIME_MICROS': return 'time';
    case 'DECIMAL': return 'decimal';
    case 'INTEGER': case 'INT_8': case 'INT_16': case 'INT_32': case 'INT_64':
    case 'UINT_8': case 'UINT_16': case 'UINT_32': case 'UINT_64': return 'int';
    case 'FLOAT16': return 'float';
    default: break;
  }
  switch (el.type) {
    case 'BOOLEAN': return 'bool';
    case 'INT32': case 'INT64': return 'int';
    case 'INT96': return 'timestamp';
    case 'FLOAT': case 'DOUBLE': return 'float';
    case 'BYTE_ARRAY': case 'FIXED_LEN_BYTE_ARRAY': return 'binary';
    default: return 'string';
  }
}

function schemaRows(metadata) {
  const out = [];
  const stack = [];
  metadata.schema.forEach((el, i) => {
    while (stack.length && stack[stack.length - 1] === 0) stack.pop();
    const depth = stack.length;
    if (stack.length) stack[stack.length - 1]--;
    if (i > 0) {
      out.push({
        depth: depth - 1,
        name: String(el.name),
        physical: el.type || (el.num_children ? 'group' : ''),
        logical: logicalText(el),
        repetition: el.repetition_type || '',
      });
    }
    if (el.num_children) stack.push(el.num_children);
  });
  return out;
}

function parquetFileInfo(metadata, size) {
  const codecs = new Set();
  let compressed = 0, uncompressed = 0;
  for (const rg of metadata.row_groups || []) {
    for (const cc of rg.columns || []) {
      const md = cc.meta_data;
      if (!md) continue;
      if (md.codec) codecs.add(md.codec);
      compressed += Number(md.total_compressed_size || 0);
      uncompressed += Number(md.total_uncompressed_size || 0);
    }
  }
  return {
    rows: Number(metadata.num_rows),
    rowGroups: (metadata.row_groups || []).length,
    createdBy: metadata.created_by || '',
    version: metadata.version,
    codecs: [...codecs],
    fileSize: size,
    compressedBytes: compressed,
    uncompressedBytes: uncompressed,
    keyValue: (metadata.key_value_metadata || []).filter(kv => kv.key !== 'ARROW:schema').map(kv => ({
      key: String(kv.key),
      value: kv.value === undefined || kv.value === null ? '' : String(kv.value).slice(0, 2000),
    })),
    fields: schemaRows(metadata),
  };
}

async function loadParquet(source, options, onPreview) {
  const o = opts(options);
  const { hp, compressors } = await hyparquet();
  const { file, close } = await asyncBufferFor(source);
  try {
    const metadata = await hp.parquetMetadataAsync(file);
    const tree = hp.parquetSchema(metadata);
    const columns = tree.children.map(node => ({
      name: String(node.element.name),
      type: parquetType(node),
      detail: node.children.length ? (logicalText(node.element) || 'group') : [node.element.type, logicalText(node.element)].filter(Boolean).join(' / '),
    }));
    const total = Number(metadata.num_rows);
    const rowEnd = Math.min(total, o.maxRows);
    const info = {
      format: 'parquet', fileSize: file.byteLength, totalRows: total, truncated: rowEnd < total,
      truncatedReason: rowEnd < total ? `Showing the first ${rowEnd.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows (limit tableViewer.maxRows).` : '',
      schema: parquetFileInfo(metadata, file.byteLength),
    };
    const nameToIdx = new Map(columns.map((c, i) => [c.name, i]));
    const read = async (end) => {
      const data = columns.map(() => ({ values: new Array(end).fill(null), nulls: null }));
      if (end > 0) {
        await hp.parquetRead({
          file, metadata, compressors, rowStart: 0, rowEnd: end,
          onChunk: ({ columnName, columnData, rowStart }) => {
            const ci = nameToIdx.get(columnName);
            if (ci === undefined) return;
            const vals = data[ci].values;
            const n = columnData.length;
            for (let i = 0; i < n; i++) {
              const r = rowStart + i;
              if (r >= 0 && r < end) vals[r] = columnData[i];
            }
          },
        });
      }
      columns.forEach((c, i) => { if (c.type === 'float' || c.type === 'int' || c.type === 'decimal') data[i] = packNumeric(data[i]); });
      return new Table(columns, data, end);
    };
    if (onPreview && rowEnd > PREVIEW_ROWS) {
      const firstGroupRows = Number((metadata.row_groups[0] || {}).num_rows || 0);
      // only worth it when the first row group is much smaller than the whole read
      if (firstGroupRows > 0 && firstGroupRows < rowEnd) {
        onPreview(await read(Math.min(PREVIEW_ROWS, firstGroupRows)), { ...info, loading: true });
      } else {
        onPreview(new Table(columns, columns.map(() => ({ values: [], nulls: null })), 0), { ...info, loading: true });
      }
    }
    const table = await read(rowEnd);
    return { table, info };
  } finally {
    await close();
  }
}

// ---------- Excel / ODS ----------

let xlsxMod = null;
function sheetjs() {
  if (!xlsxMod) xlsxMod = require('xlsx');
  return xlsxMod;
}

function readWorkbook(source, options) {
  const o = opts(options);
  const size = sourceSize(source);
  if (size > o.maxExcelSizeMB * MB) {
    const err = new Error(`This workbook is ${fmtMB(size)}. The limit for Excel files is ${o.maxExcelSizeMB} MB (setting tableViewer.maxExcelSizeMB). Excel files must be read whole, so large ones use a lot of memory. Save the sheet as CSV to open it fast at any size.`);
    err.code = 'TOO_LARGE';
    throw err;
  }
  const buf = source.bytes ? Buffer.from(source.bytes.buffer || source.bytes, source.bytes.byteOffset || 0, source.bytes.byteLength) : fs.readFileSync(source.path);
  const XLSX = sheetjs();
  try {
    return XLSX.read(buf, { type: 'buffer', dense: true, cellDates: true, cellNF: false, cellHTML: false, cellStyles: false, UTC: true });
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    const locked = /encrypt|password/i.test(detail);
    const err = new Error(locked
      ? `This workbook is password protected, so it can't be read. Save a copy without a password and open that. (${detail})`
      : `This file could not be read as a workbook. It may be damaged or not really an Excel file. (${detail})`);
    err.code = locked ? 'ENCRYPTED' : 'BAD_WORKBOOK';
    throw err;
  }
}

/**
 * Excel stores times as fractions of a day, and turning that float into a Date can land 1 ms off,
 * so 17:56:05 shows as 17:56:04.999. Snap values within 1 ms of a whole second to that second.
 */
function snapExcelDate(d) {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return d;
  const whole = Math.round(ms / 1000) * 1000;
  return ms !== whole && Math.abs(ms - whole) <= 1 ? new Date(whole) : d;
}

function inferJsType(values, n) {
  let num = true, int = true, bool = true, date = true, midnight = true, seen = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined || v === '') continue;
    seen++;
    const t = typeof v;
    if (t !== 'number') { num = false; int = false; } else if (!Number.isInteger(v)) int = false;
    if (t !== 'boolean') bool = false;
    if (!(v instanceof Date)) date = false;
    else if (v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() || v.getUTCMilliseconds()) midnight = false;
    if (!num && !bool && !date) return 'string';
  }
  if (!seen) return 'string';
  if (int) return 'int';
  if (num) return 'float';
  if (bool) return 'bool';
  if (date) return midnight ? 'date' : 'timestamp';
  return 'string';
}

function sheetTable(wb, sheetName, options) {
  const o = opts(options);
  const XLSX = sheetjs();
  const name = wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const rows = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false, UTC: true }) : [];
  const head = rows.length ? rows[0] : [];
  let width = head.length;
  for (let r = 1; r < rows.length; r++) if (rows[r].length > width) width = rows[r].length;
  const total = Math.max(0, rows.length - 1);
  const n = Math.min(total, o.maxRows);
  const data = [];
  const columns = [];
  for (let c = 0; c < width; c++) {
    const vals = new Array(n);
    for (let r = 0; r < n; r++) {
      const v = rows[r + 1][c];
      vals[r] = v === undefined ? null : v instanceof Date ? snapExcelDate(v) : v;
    }
    const h = head[c];
    columns.push({ name: h === null || h === undefined || h === '' ? XLSX.utils.encode_col(c) : String(h instanceof Date ? h.toISOString().slice(0, 10) : h), type: inferJsType(vals, n) });
    data.push(columns[c].type === 'int' || columns[c].type === 'float' ? packNumeric({ values: vals, nulls: null }) : { values: vals, nulls: null });
  }
  addExcelDisplay(XLSX, ws, data, columns, n);
  const info = {
    format: 'excel', sheets: wb.SheetNames.slice(), activeSheet: name, totalRows: total,
    truncated: n < total,
    truncatedReason: n < total ? `Showing the first ${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows (limit tableViewer.maxRows).` : '',
  };
  const table = new Table(columns, data, n);
  if (o.excelFormats === false) table.formatted = false;
  info.formattedCells = table.formattedCells;
  return { table, info };
}

/**
 * Excel number formats: SheetJS keeps the text Excel shows for each cell (cell.w, for example 25.0%,
 * $1,234.50 or 01/10/2026). Where that text differs from the plain value, keep it in data[c].display so
 * the grid can show the cell as Excel does, while sort, filters and copy keep using the value.
 * A quick scan first, so sheets with only General cells pay nothing.
 */
const DEFAULT_SHORT_DATE = /^\d{1,2}\/\d{1,2}\/\d{2}( \d{1,2}:\d{2})?$/;

function addExcelDisplay(XLSX, ws, data, columns, n) {
  const dense = ws && ws['!data'];
  if (!dense || !n) return;
  let any = false;
  for (let r = 0; r < dense.length && !any; r++) {
    const row = dense[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell && (cell.t === 'n' || cell.t === 'd') && typeof cell.w === 'string' && cell.w !== String(cell.v)) { any = true; break; }
    }
  }
  if (!any) return;
  // Same row skipping as the raw read (blankrows: false), so the two arrays line up.
  const shown = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null, blankrows: false, UTC: true });
  const { formatValue } = require('./table');
  for (let c = 0; c < columns.length; c++) {
    let display = null;
    let count = 0;
    for (let r = 0; r < n; r++) {
      const w = shown[r + 1] ? shown[r + 1][c] : null;
      if (w === null || w === undefined) continue;
      const raw = r < data[c].values.length && !(data[c].nulls && data[c].nulls[r]) ? data[c].values[r] : null;
      if (raw === null || raw === undefined || typeof raw === 'string') continue;
      const plain = formatValue(raw, columns[c].type);
      if (w === plain) continue;
      // Excel's default short date (m/d/yy, built-in format 14) follows the reader's locale in Excel,
      // so the US text would mislead. Keep ISO dates for it; explicit date formats are shown as written.
      if (raw instanceof Date && DEFAULT_SHORT_DATE.test(w)) continue;
      if (!display) display = new Array(n);
      display[r] = String(w);
      count++;
    }
    if (display) { data[c].display = display; data[c].displayCount = count; }
  }
}

async function loadExcel(source, options, _onPreview, sheetName) {
  const wb = readWorkbook(source, options);
  const res = sheetTable(wb, sheetName, options);
  res.info.fileSize = sourceSize(source);
  res.loadSheet = name => sheetTable(wb, name, options);
  return res;
}

async function loadFile(source, format, options, onPreview) {
  switch (format) {
    case 'csv': case 'tsv': return loadCsv(source, options, onPreview, format);
    case 'parquet': return loadParquet(source, options, onPreview);
    case 'excel': return loadExcel(source, options, onPreview);
    default: throw new Error(`Unsupported file type: ${format}`);
  }
}

module.exports = {
  snapExcelDate,
  loadFile, loadCsv, loadParquet, loadExcel, sheetTable, formatFromPath, parquetType, schemaRows,
  inferJsType, DEFAULTS, PREVIEW_ROWS, CSV_DELIMITERS,
};
