'use strict';
// A sheet whose first row has no text (only numbers, dates or booleans) has no header row: that row is data,
// and the columns are named A, B, C. Found on Apache POI's 56957.xlsx (one date in A1), which showed 0 rows.
const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const { loadExcel, isHeaderRow } = require('../src/core/readers');

const book = (sheets) => {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { UTC: true }), name);
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};
const cell = (t, r, c) => { const col = t.data[c]; return col.values[r]; };

test('isHeaderRow: text means header; only numbers, dates or booleans means data', () => {
  assert.strictEqual(isHeaderRow(['name', 'age']), true);
  assert.strictEqual(isHeaderRow(['Region', 2023, 2024]), true); // years as column titles stay a header
  assert.strictEqual(isHeaderRow([new Date(Date.UTC(2014, 10, 9))]), false);
  assert.strictEqual(isHeaderRow([1, 2.5, null, 3]), false);
  assert.strictEqual(isHeaderRow([true, false]), false);
  assert.strictEqual(isHeaderRow([null, '', undefined]), true);
  assert.strictEqual(isHeaderRow([]), true);
});

test('a sheet with one date and no header shows that date as row 1 of column A', async () => {
  const { table, info } = await loadExcel({ bytes: book({ Sheet1: [[new Date(Date.UTC(2014, 10, 9))]] }) }, {});
  assert.strictEqual(table.rowCount, 1);
  assert.strictEqual(table.columns.length, 1);
  assert.strictEqual(table.columns[0].name, 'A');
  assert.strictEqual(info.totalRows, 1);
  assert.strictEqual(info.headerRow, false);
  const v = cell(table, 0, 0);
  assert.ok(v instanceof Date || typeof v === 'number', 'the date is kept as a value');
});

test('a numbers-only sheet keeps every row, columns A, B, C', async () => {
  const { table } = await loadExcel({ bytes: book({ Data: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] }) }, {});
  assert.strictEqual(table.rowCount, 3);
  assert.deepStrictEqual(table.columns.map((c) => c.name), ['A', 'B', 'C']);
  assert.strictEqual(Number(cell(table, 0, 0)), 1);
  assert.strictEqual(Number(cell(table, 2, 2)), 9);
});

test('a normal sheet with a text header is unchanged', async () => {
  const { table, info } = await loadExcel({ bytes: book({ S: [['k', 'v'], ['x', 1.5], ['y', 2]] }) }, {});
  assert.strictEqual(table.rowCount, 2);
  assert.deepStrictEqual(table.columns.map((c) => c.name), ['k', 'v']);
  assert.strictEqual(info.headerRow, true);
});

test('Excel number formats line up with the rows when there is no header row', async () => {
  const ws = XLSX.utils.aoa_to_sheet([[0.25, 1234.5], [0.5, 99]]);
  ws.A1.z = ws.A2.z = '0.0%';
  ws.B1.z = ws.B2.z = '"$"#,##0.00';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Fmt');
  const { table } = await loadExcel({ bytes: new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })) }, {});
  assert.strictEqual(table.rowCount, 2);
  assert.deepStrictEqual(table.data[0].display, ['25.0%', '50.0%']);
  assert.deepStrictEqual(table.data[1].display, ['$1,234.50', '$99.00']);
});
