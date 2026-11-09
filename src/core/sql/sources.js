'use strict';
// Row sources for the Query panel. Each source knows its columns before it reads any rows, and scan(need, ctx)
// yields batches of rows (arrays, one slot per column; only the needed columns are filled).
//
// - tableSource: a table already in memory (the open file, another sheet, a subquery result).
// - csvSource: a CSV/TSV file read as a stream; the rows are never kept, so a 5 GB file costs only the batch.
// - parquetSource: a Parquet file read one row group at a time, only the needed columns, and row groups whose
//   min/max statistics rule out the WHERE condition are skipped without reading them.

const fs = require('fs');
const { CsvParser, detectDelimiter } = require('../csv');
const { detectEncoding, CSV_ENCODINGS } = require('../encoding');
const { inferStringType, uniqueNames } = require('../table');
const { num, cmp, toDate } = require('./values');

const BATCH = 8192;
const MB = 1024 * 1024;
const HEAD_ROWS = 2000;
const HEAD_MAX_BYTES = 32 * MB;

function tableSource(table, name) {
  const columns = table.columns.map(c => ({ name: c.name, type: c.type }));
  return {
    name,
    columns,
    rowCount: table.rowCount,
    async *scan(need, ctx) {
      const nc = columns.length;
      const list = need ? [...need] : columns.map((_, i) => i);
      const n = table.rowCount;
      for (let r0 = 0; r0 < n; r0 += BATCH) {
        const r1 = Math.min(n, r0 + BATCH);
        const out = new Array(r1 - r0);
        for (let r = r0; r < r1; r++) {
          const row = new Array(nc);
          // An empty cell is NULL, as in the SQL filter: CSV has no other way to write one.
          for (let j = 0; j < list.length; j++) { const c = list[j]; const v = table.get(r, c); row[c] = v === '' ? null : v; }
          out[r - r0] = row;
        }
        ctx.rows += out.length;
        yield out;
        await ctx.tick();
      }
    },
  };
}

function rowsSource(columns, rows, name) {
  return {
    name,
    columns: columns.map(c => ({ name: c.name, type: c.type })),
    rowCount: rows.length,
    async *scan(need, ctx) {
      for (let r0 = 0; r0 < rows.length; r0 += BATCH) {
        const out = rows.slice(r0, r0 + BATCH);
        ctx.rows += out.length;
        yield out;
        await ctx.tick();
      }
    },
  };
}

// ---------- CSV ----------

async function* chunks(path, start = 0) {
  const stream = fs.createReadStream(path, { highWaterMark: MB, start });
  try {
    for await (const c of stream) yield c;
  } finally {
    stream.destroy();
  }
}

/** Convert one CSV field with the column's sampled type. Empty is NULL. */
function convertField(v, t) {
  if (v === '' || v === undefined) return null;
  if (t === 1) { // number
    const n = num(v);
    return n === null ? v : (Number.isSafeInteger(n) || !/^[+-]?\d+$/.test(v.trim()) ? n : v);
  }
  if (t === 2) { const l = v.toLowerCase(); return l === 'true' ? true : l === 'false' ? false : v; }
  return v;
}

/**
 * @param {{path:string}} source
 * @param {{delimiter?:string, header?:boolean, encoding?:string, format?:string}} o reader options of the open file
 */
async function csvSource(source, o, name) {
  if (!source.path) throw sqlError('This file is not on disk, so it cannot be read as a stream.');
  const size = fs.statSync(source.path).size;
  const forcedEnc = CSV_ENCODINGS.includes(o.encoding) ? o.encoding : null;
  const hasHeader = o.header !== false;
  // Head: enough rows to name the columns and guess their types.
  let encoding = null;
  let headText = '';
  let headBytes = 0;
  {
    let decoder = null;
    for await (const c of chunks(source.path)) {
      if (!decoder) {
        encoding = forcedEnc || detectEncoding(c);
        try { decoder = new TextDecoder(encoding); } catch { encoding = 'utf-8'; decoder = new TextDecoder(encoding); }
      }
      headText += decoder.decode(c, { stream: true });
      headBytes += c.length;
      if (headBytes >= HEAD_MAX_BYTES || countNewlines(headText) > HEAD_ROWS + 1) break;
    }
  }
  const delimiter = ['\t', ',', ';', '|', ':'].includes(o.delimiter) ? o.delimiter
    : o.format === 'tsv' ? '\t' : detectDelimiter(headText.slice(0, 64 * 1024));
  const sample = [];
  {
    const p = new CsvParser(delimiter, row => { sample.push(row); if (sample.length > HEAD_ROWS) p.stop(); });
    p.push(headText);
    if (headBytes >= size) p.end();
  }
  let header;
  let body = sample;
  if (hasHeader && sample.length) { header = sample[0].slice(); body = sample.slice(1); } else header = [];
  let width = header.length;
  for (const r of body) if (r.length > width) width = r.length;
  for (let i = header.length; i < width; i++) header.push(hasHeader ? '' : `column_${i + 1}`);
  const types = [];
  const columns = [];
  for (let c = 0; c < width; c++) {
    const vals = body.map(r => (c < r.length ? r[c] : ''));
    const t = inferStringType(vals);
    types.push(t === 'int' || t === 'float' ? 1 : t === 'bool' ? 2 : 0);
    columns.push({ name: header[c], type: t === 'empty' ? 'string' : t });
  }
  const named = uniqueNames(columns);
  return {
    name,
    columns: named,
    totalBytes: size,
    encoding,
    delimiter,
    async *scan(need, ctx) {
      const nc = named.length;
      const list = need ? [...need] : named.map((_, i) => i);
      let batch = [];
      let first = hasHeader;
      let parser = null;
      const onRow = fields => {
        if (first) { first = false; return; }
        if (fields.length === 1 && fields[0] === '' && nc > 1) return; // blank line
        const row = new Array(nc);
        for (let j = 0; j < list.length; j++) { const c = list[j]; row[c] = convertField(fields[c], types[c]); }
        batch.push(row);
      };
      parser = new CsvParser(delimiter, onRow);
      let decoder;
      try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder('utf-8'); }
      for await (const c of chunks(source.path)) {
        ctx.bytes += c.length;
        parser.push(decoder.decode(c, { stream: true }));
        if (batch.length) {
          const out = batch;
          batch = [];
          ctx.rows += out.length;
          yield out;
        }
        await ctx.tick();
      }
      parser.push(decoder.decode());
      parser.end();
      if (batch.length) { ctx.rows += batch.length; yield batch; }
    },
  };
}

function countNewlines(s) {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0 && n <= HEAD_ROWS + 2; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

// ---------- Parquet ----------

/**
 * @param {{path?:string, bytes?:Uint8Array}} source
 */
async function parquetSource(source, name) {
  const readers = require('../readers');
  const { hp, compressors } = await readers.hyparquet();
  const { file, close } = await readers.asyncBufferFor(source);
  let metadata;
  try {
    metadata = await hp.parquetMetadataAsync(file);
  } catch (e) {
    await close();
    throw e;
  }
  const tree = hp.parquetSchema(metadata);
  const columns = uniqueNames(tree.children.map(node => ({ name: String(node.element.name), type: readers.parquetType(node) })));
  const rawNames = tree.children.map(node => String(node.element.name));
  const groups = metadata.row_groups || [];
  // Leaf statistics per row group, for flat columns only (path of length 1).
  const statsFor = (gi, ci) => {
    const g = groups[gi];
    for (const cc of g.columns || []) {
      const md = cc.meta_data;
      if (md && md.path_in_schema && md.path_in_schema.length === 1 && md.path_in_schema[0] === rawNames[ci]) return md.statistics || null;
    }
    return null;
  };
  let closed = false;
  const src = {
    name,
    columns,
    rowCount: Number(metadata.num_rows),
    totalBytes: file.byteLength,
    rowGroups: groups.length,
    skippedGroups: 0,
    // [{col, op, value}] set by the executor from the WHERE conjuncts
    prune: [],
    canSkip(gi) {
      for (const f of this.prune) {
        const st = statsFor(gi, f.col);
        if (!st) continue;
        const lo = statValue(st.min_value !== undefined ? st.min_value : st.min);
        const hi = statValue(st.max_value !== undefined ? st.max_value : st.max);
        if (lo === null || hi === null) continue;
        const v = f.value;
        const below = x => cmp(x, v) < 0, above = x => cmp(x, v) > 0;
        switch (f.op) {
          case '=': if (below(hi) || above(lo)) return true; break;
          case '>': if (!above(hi)) return true; break;
          case '>=': if (below(hi)) return true; break;
          case '<': if (!below(lo)) return true; break;
          case '<=': if (above(lo)) return true; break;
          default: break;
        }
      }
      return false;
    },
    async *scan(need, ctx) {
      const list = need ? [...need] : columns.map((_, i) => i);
      const names = list.map(i => rawNames[i]);
      const idxOf = new Map(list.map(i => [rawNames[i], i]));
      const nc = columns.length;
      try {
        let start = 0;
        for (let gi = 0; gi < groups.length; gi++) {
          const n = Number(groups[gi].num_rows);
          const g0 = start;
          start += n;
          ctx.bytes += groupBytes(groups[gi]);
          if (n === 0) continue;
          if (this.prune.length && this.canSkip(gi)) { this.skippedGroups++; await ctx.tick(); continue; }
          // Keep the decoded column chunks (columnar, only the needed columns) and build row arrays one batch at a
          // time, so a row group of millions of rows never becomes millions of row arrays at once.
          const parts = new Map(list.map(c => [c, []]));
          if (names.length) {
            await hp.parquetRead({
              file, metadata, compressors, columns: names, rowStart: g0, rowEnd: g0 + n,
              onChunk: ({ columnName, columnData, rowStart }) => {
                const c = idxOf.get(columnName);
                if (c !== undefined) parts.get(c).push({ s: rowStart - g0, d: columnData });
              },
            });
          }
          const cols = list.map(c => ({ c, chunks: parts.get(c).sort((a, b) => a.s - b.s), k: 0 }));
          for (let r0 = 0; r0 < n; r0 += BATCH) {
            const r1 = Math.min(n, r0 + BATCH);
            const out = new Array(r1 - r0);
            for (let r = r0; r < r1; r++) out[r - r0] = new Array(nc).fill(null);
            for (const col of cols) {
              const ch = col.chunks;
              for (let r = r0; r < r1; r++) {
                while (col.k < ch.length && r >= ch[col.k].s + ch[col.k].d.length) col.k++;
                const part = ch[col.k];
                if (part && r >= part.s) out[r - r0][col.c] = normalize(part.d[r - part.s]);
              }
            }
            ctx.rows += out.length;
            yield out;
            await ctx.tick();
          }
        }
      } finally {
        if (!closed) { closed = true; await close(); }
      }
    },
    async close() { if (!closed) { closed = true; await close(); } },
  };
  return src;
}

function groupBytes(g) {
  let b = 0;
  for (const cc of g.columns || []) if (cc.meta_data) b += Number(cc.meta_data.total_compressed_size || 0);
  return b;
}

function statValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  return null; // text and binary statistics are not used (byte order is not always our order)
}

function normalize(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v;
  return v === undefined ? null : v;
}

function sqlError(message) { const e = new Error(message); e.code = 'SQL'; return e; }

module.exports = { tableSource, rowsSource, csvSource, parquetSource, convertField, statValue, toDate, BATCH };
