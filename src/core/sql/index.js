'use strict';
// Query panel glue: turns a query result into a grid Table, and resolves FROM names for one open file.

const path = require('path');
const { Table, packNumeric, inferStringType } = require('../table');
const { tableSource, rowsSource, csvSource, parquetSource } = require('./sources');
const { SqlError } = require('./parse');

const BIG = { maxRows: 1048576 * 4, maxFileSizeMB: 1e7, maxExcelSizeMB: 1e5 };
const THIS_NAMES = new Set(['this', 'file', 'data', 'self']);

function typeOf(values) {
  let num = 0, int = 0, bool = 0, date = 0, midnight = 0, str = 0, other = 0, seen = 0;
  const strs = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    seen++;
    if (typeof v === 'number') { num++; if (Number.isInteger(v)) int++; } else if (typeof v === 'bigint') { num++; int++; } else if (typeof v === 'boolean') bool++;
    else if (v instanceof Date) { date++; if (v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0) midnight++; } else if (typeof v === 'string') { str++; if (strs.length < 2000) strs.push(v); } else other++;
  }
  if (!seen) return 'string';
  if (num === seen) return int === seen ? 'int' : 'float';
  if (bool === seen) return 'bool';
  if (date === seen) return midnight === seen ? 'date' : 'timestamp';
  if (str === seen) { const t = inferStringType(strs); return t === 'date' || t === 'timestamp' ? t : 'string'; }
  return 'string';
}

/** Grid table for a query result. Numbers go to packed columns so sort and stats stay fast. */
function resultTable(res) {
  const n = res.rows.length;
  const columns = [];
  const data = [];
  res.columns.forEach((c, i) => {
    const vals = new Array(n);
    for (let r = 0; r < n; r++) { const v = res.rows[r][i]; vals[r] = v === undefined ? null : v; }
    const type = typeOf(vals);
    columns.push({ name: c.name, type, detail: 'query result' });
    data.push(type === 'int' || type === 'float' ? packNumeric({ values: vals, nulls: null }) : { values: vals, nulls: null });
  });
  return new Table(columns, data, n);
}

/**
 * FROM resolver for one open file.
 * @param {object} s
 * @param {object} s.file {table, info, source, format, options, loadSheet, fileName} the open file as loaded
 * @param {object|null} s.result last query result table (FROM result)
 * @param {object} s.files host-checked paths: {'data/x.csv': {path, format, sheet?} | {error}}
 * @param {boolean} s.allowStream read the whole file when the grid holds only part of it
 * @param {boolean} s.allowFiles JOIN with other files
 * @param {(note:string)=>void} s.note
 * @param {object} [s.loaders] test hooks: {loadFile, loadExcel}
 */
function createResolver(s) {
  const readers = require('../readers');
  const loadFile = (s.loaders && s.loaders.loadFile) || readers.loadFile;
  const loadExcel = (s.loaders && s.loaders.loadExcel) || readers.loadExcel;
  const f = s.file;
  const base = f.fileName ? path.basename(f.fileName) : '';
  const stem = base.replace(/\.[^.]+$/, '');
  const alt = [base, stem].filter(Boolean);

  async function openFileWhole() {
    const info = f.info || {};
    if (!info.truncated || !f.table) {
      const t = tableSource(f.table, 'this');
      t.altNames = alt;
      return t;
    }
    if (!s.allowStream) {
      s.note(`The query ran on the ${f.table.rowCount.toLocaleString('en-US')} rows in the table. Reading the whole file is a Zovo Pro feature.`);
      const t = tableSource(f.table, 'this');
      t.altNames = alt;
      return t;
    }
    let rel;
    if ((f.format === 'csv' || f.format === 'tsv') && f.source && f.source.path) {
      rel = await csvSource(f.source, { delimiter: info.delimiter, header: info.header, encoding: info.encoding, format: f.format }, 'this');
    } else if (f.format === 'parquet') {
      rel = await parquetSource(f.source, 'this');
    } else {
      const r = await loadFile(f.source, f.format, { ...(f.options || {}), ...BIG }, null);
      rel = tableSource(r.table, 'this');
    }
    rel.altNames = alt;
    s.note('The query read the whole file, past the rows shown in the table.');
    return rel;
  }

  return async function resolve(ref) {
    if (ref.kind === 'this') return openFileWhole();
    if (ref.kind === 'name') {
      const name = ref.value;
      const low = name.toLowerCase();
      if (THIS_NAMES.has(low) || alt.some(a => a.toLowerCase() === low)) return openFileWhole();
      if (low === 'result' && s.result) return tableSource(s.result, 'result');
      const sheets = (f.info && f.info.sheets) || [];
      const sheet = sheets.find(x => x === name) || sheets.find(x => x.toLowerCase() === low);
      if (sheet) {
        if (sheet === f.info.activeSheet && !f.info.truncated) { const t = tableSource(f.table, sheet); t.altNames = ['this', ...alt]; return t; }
        let r;
        if (f.loadSheet && !f.info.truncated) r = await f.loadSheet(sheet);
        else r = await loadExcel(f.source, { ...(f.options || {}), ...BIG }, null, sheet);
        return tableSource(r.table, sheet);
      }
      const hint = sheets.length > 1 ? ` Sheets: ${sheets.slice(0, 8).map(x => `"${x}"`).join(', ')}.` : '';
      throw new SqlError(`No source named "${name}". Use FROM this for the open file${sheets.length > 1 ? ', a sheet name' : ''}, or a file path in single quotes, like FROM 'data/orders.csv'.${hint}`, 0);
    }
    if (ref.kind === 'path') {
      const hit = s.files && s.files[ref.value];
      if (!hit) throw new SqlError(`The file '${ref.value}' was not checked by the editor. Run the query again.`, 0);
      if (hit.error) throw new SqlError(hit.error, 0);
      if (!s.allowFiles) throw new SqlError('JOIN with other files is a Zovo Pro feature. Sheets of this workbook and this file are free.', 0);
      const name = path.basename(hit.path).replace(/\.[^.]+$/, '');
      const src = { path: hit.path };
      let rel;
      if (hit.format === 'csv' || hit.format === 'tsv') rel = await csvSource(src, { format: hit.format }, name);
      else if (hit.format === 'parquet') rel = await parquetSource(src, name);
      else if (hit.format === 'excel') {
        const r = await loadExcel(src, BIG, null, hit.sheet || undefined);
        if (hit.sheet && r.info.activeSheet !== hit.sheet) throw new SqlError(`'${path.basename(hit.path)}' has no sheet "${hit.sheet}". Sheets: ${(r.info.sheets || []).join(', ')}.`, 0);
        rel = tableSource(r.table, name);
      } else throw new SqlError(`'${ref.value}' is not a CSV, TSV, Parquet or Excel file.`, 0);
      rel.altNames = [path.basename(hit.path)];
      return rel;
    }
    throw new SqlError('Unknown source.', 0);
  };
}

module.exports = { resultTable, createResolver, typeOf, rowsSource };
