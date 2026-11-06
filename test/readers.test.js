'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadFile, loadCsv } = require('../src/core/readers');
const { formatFromPath } = require('../src/core/formats');

const F = name => path.join(__dirname, 'fixtures', name);
const load = (name, o = {}, onPreview) => loadFile({ path: F(name) }, formatFromPath(name), o, onPreview);

test('format detection', () => {
  assert.strictEqual(formatFromPath('a/B.PARQUET'), 'parquet');
  assert.strictEqual(formatFromPath('x.xls'), 'excel');
  assert.strictEqual(formatFromPath('x.tsv'), 'tsv');
  assert.strictEqual(formatFromPath('x.json'), null);
});

test('parquet: types, nulls, nested values and schema (snappy, zstd, gzip give the same rows)', async () => {
  const ref = await load('sample.parquet');
  assert.strictEqual(ref.table.rowCount, 150);
  assert.deepStrictEqual(ref.table.columns.map(c => c.type), ['int', 'string', 'float', 'bool', 'date', 'timestamp', 'list', 'struct', 'int']);
  const rows = ref.table.getRows(0, 150).map(r => r.cells);
  assert.deepStrictEqual(rows[0], ['1', 'item 1', '1.25', 'false', '2024-01-02', '2024-05-01T12:01:00Z', '["t1","t1"]', '{"a":1,"b":"x1"}', '1152921504606846977']);
  assert.strictEqual(rows[16][1], null); // id 17 has a null name
  assert.strictEqual(rows[10][2], null); // id 11 has a null price
  assert.strictEqual(rows[3][6], '[]');
  assert.strictEqual(rows[2][1], 'item <b>3</b> "q", ok');
  const s = ref.info.schema;
  assert.strictEqual(s.rows, 150);
  assert.strictEqual(s.rowGroups, 3);
  assert.deepStrictEqual(s.codecs, ['SNAPPY']);
  assert.ok(s.fields.some(f => f.name === 'attrs' && f.depth === 0));
  assert.ok(s.fields.some(f => f.name === 'b' && f.depth === 1 && f.logical === 'STRING'));
  assert.deepStrictEqual(s.keyValue, [{ key: 'origin', value: 'fixture' }]);
  for (const name of ['sample-zstd.parquet', 'sample-gzip.parquet']) {
    const other = await load(name);
    assert.deepStrictEqual(other.table.getRows(0, 150).map(r => r.cells), rows, name);
  }
});

test('parquet: maxRows reads only the first rows and says so', async () => {
  const previews = [];
  const r = await load('sample.parquet', { maxRows: 1060 }, p => previews.push(p.rowCount));
  assert.strictEqual(r.table.rowCount, 150);
  const cut = await load('sample.parquet', { maxRows: 60 });
  assert.strictEqual(cut.table.rowCount, 60);
  assert.strictEqual(cut.info.truncated, true);
  assert.match(cut.info.truncatedReason, /first 60 of 150/);
  assert.strictEqual(cut.table.getRows(59, 1)[0].cells[0], '60');
});

test('parquet from bytes (remote file) matches parquet from path', async () => {
  const a = await load('sample.parquet');
  const b = await loadFile({ bytes: new Uint8Array(fs.readFileSync(F('sample.parquet'))) }, 'parquet', {});
  assert.deepStrictEqual(b.table.getRows(0, 150), a.table.getRows(0, 150));
});

test('xlsx, xls and ods: types, dates, sheets', async () => {
  for (const name of ['sample.xlsx', 'sample.xls', 'sample.ods']) {
    const r = await load(name);
    assert.deepStrictEqual(r.info.sheets, ['Sales', 'Second'], name);
    assert.deepStrictEqual(r.table.columns.map(c => c.name), ['Region', 'Units', 'Price', 'Shipped', 'Date'], name);
    assert.deepStrictEqual(r.table.columns.map(c => c.type), ['string', 'int', 'float', 'bool', 'date'], name);
    assert.deepStrictEqual(r.table.getRows(0, 3).map(x => x.cells[4]), ['2024-01-15', '2024-02-20', '2024-03-01'], name);
    assert.strictEqual(r.table.getRows(2, 1)[0].cells[0], '<script>alert(1)</script>');
    const second = r.loadSheet('Second');
    assert.deepStrictEqual(second.table.getRows(0, 2).map(x => x.cells), [['a', '1'], ['b', '2']]);
  }
});

test('excel size limit gives a clear message', async () => {
  await assert.rejects(() => load('sample.xlsx', { maxExcelSizeMB: 0.001 }), /limit for Excel files is 0.001 MB/);
});

test('csv, tsv, BOM, semicolons and ragged rows', async () => {
  const csv = await load('sample.csv');
  assert.strictEqual(csv.table.rowCount, 4);
  assert.strictEqual(csv.table.getRows(3, 1)[0].cells[1], 'multi\nline');
  assert.strictEqual(csv.info.totalRows, 4);
  const tsv = await load('sample.tsv');
  assert.deepStrictEqual(tsv.table.columns.map(c => [c.name, c.type]), [['city', 'string'], ['pop', 'int']]);
  const semi = await load('semicolon.csv');
  assert.deepStrictEqual(semi.table.columns.map(c => c.name), ['a', 'b', 'c']);
  assert.strictEqual(semi.info.delimiter, ';');
  const ragged = await load('ragged.csv');
  assert.deepStrictEqual(ragged.table.getRows(0, 2).map(r => r.cells), [['1', '2', '3'], ['4', null, null]]);
});

test('csv limits: maxRows and maxFileSizeMB', async t => {
  const dir = fs.mkdtempSync(path.join(require('os').homedir(), 'table-viewer-vscode-work', 'csv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'big.csv');
  let s = 'n,text\n';
  for (let i = 0; i < 30000; i++) s += `${i},row number ${i} with some padding text\n`;
  fs.writeFileSync(p, s);
  const previews = [];
  const all = await loadCsv({ path: p }, {}, pr => previews.push(pr.rowCount), 'csv');
  assert.strictEqual(all.table.rowCount, 30000);
  assert.deepStrictEqual(previews, [1000]);
  const byRows = await loadCsv({ path: p }, { maxRows: 5000 }, null, 'csv');
  assert.strictEqual(byRows.table.rowCount, 5000);
  assert.match(byRows.info.truncatedReason, /first 5,000 rows/);
  const byBytes = await loadCsv({ path: p }, { maxFileSizeMB: 0.5 }, null, 'csv');
  assert.ok(byBytes.table.rowCount > 1000 && byBytes.table.rowCount < 30000);
  assert.strictEqual(byBytes.info.truncated, true);
  const last = byBytes.table.getRows(byBytes.table.rowCount - 1, 1)[0].cells;
  assert.strictEqual(last[1], `row number ${last[0]} with some padding text`, 'no half-read last row');
});

test('utf-16 csv with BOM', async t => {
  const dir = fs.mkdtempSync(path.join(require('os').homedir(), 'table-viewer-vscode-work', 'u16-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'u16.csv');
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\nü,2\n', 'utf16le')]));
  const r = await loadCsv({ path: p }, {}, null, 'csv');
  assert.deepStrictEqual(r.table.getRows(0, 1)[0].cells, ['ü', '2']);
});

test('empty csv file', async t => {
  const dir = fs.mkdtempSync(path.join(require('os').homedir(), 'table-viewer-vscode-work', 'empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'e.csv');
  fs.writeFileSync(p, '');
  const r = await loadCsv({ path: p }, {}, null, 'csv');
  assert.strictEqual(r.table.rowCount, 0);
  assert.strictEqual(r.table.columns.length, 0);
});

test('excel: times that land 1 ms off a whole second snap back, real milliseconds stay', () => {
  const { snapExcelDate } = require('../src/core/readers');
  assert.strictEqual(snapExcelDate(new Date('2026-10-09T17:56:04.999Z')).toISOString(), '2026-10-09T17:56:05.000Z');
  assert.strictEqual(snapExcelDate(new Date('2026-10-09T17:56:05.001Z')).toISOString(), '2026-10-09T17:56:05.000Z');
  assert.strictEqual(snapExcelDate(new Date('2026-10-09T17:56:05.537Z')).toISOString(), '2026-10-09T17:56:05.537Z');
});

test('excel: a damaged workbook gives a plain message instead of a parser error', async () => {
  await assert.rejects(loadFile({ bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]) }, 'excel', {}),
    e => e.code === 'BAD_WORKBOOK' && /could not be read/.test(e.message));
});
