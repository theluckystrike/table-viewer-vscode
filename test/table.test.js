'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Table, inferStringType, tableFromStringColumns, formatValue, jsonValue, parseFilter, uniqueNames } = require('../src/core/table');

function sample() {
  return tableFromStringColumns(['id', 'name', 'score', 'when'], [
    ['3', '1', '2', '10'],
    ['carol', 'alice', 'Bob', ''],
    ['2.5', '', '-1', '7'],
    ['2024-03-01', '2024-01-01', '2024-02-01', '2023-12-31'],
  ], 4);
}

test('type inference', () => {
  assert.strictEqual(inferStringType(['1', '-2', '']), 'int');
  assert.strictEqual(inferStringType(['1', '2.5', '1e3']), 'float');
  assert.strictEqual(inferStringType(['true', 'FALSE']), 'bool');
  assert.strictEqual(inferStringType(['2024-01-01', '2024-01-02T10:00:00Z']), 'date');
  assert.strictEqual(inferStringType(['1', 'x']), 'string');
  assert.strictEqual(inferStringType(['', '']), 'empty');
  const t = sample();
  assert.deepStrictEqual(t.columns.map(c => c.type), ['int', 'string', 'float', 'date']);
});

test('huge ints stay text so no digits are lost', () => {
  const t = tableFromStringColumns(['big'], [['12345678901234567890']], 1);
  assert.strictEqual(t.columns[0].type, 'string');
  assert.strictEqual(t.getRows(0, 1)[0].cells[0], '12345678901234567890');
});

test('numeric sort puts nulls last in both directions', () => {
  const t = sample();
  t.setSort(2, 'asc');
  assert.deepStrictEqual(t.getRows(0, 4).map(r => r.cells[2]), ['-1', '2.5', '7', null]);
  t.setSort(2, 'desc');
  assert.deepStrictEqual(t.getRows(0, 4).map(r => r.cells[2]), ['7', '2.5', '-1', null]);
  t.setSort(null, null);
  assert.deepStrictEqual(t.getRows(0, 4).map(r => r.id), [0, 1, 2, 3]);
});

test('text, date and bigint sort', () => {
  const t = sample();
  t.setSort(3, 'asc');
  assert.deepStrictEqual(t.getRows(0, 4).map(r => r.cells[0]), ['10', '1', '2', '3']);
  const b = new Table([{ name: 'b', type: 'int' }], [{ values: [3n, null, 2n ** 62n, -1n] }], 4);
  b.setSort(0, 'asc');
  assert.deepStrictEqual(b.getRows(0, 4).map(r => r.cells[0]), ['-1', '3', String(2n ** 62n), null]);
});

test('column filters and global search', () => {
  const t = sample();
  t.setFilters({ columns: { 0: '>1' } });
  assert.strictEqual(t.viewCount, 3);
  t.setFilters({ columns: { 0: '2..3' } });
  assert.deepStrictEqual(t.getRows(0, 10).map(r => r.cells[0]), ['3', '2']);
  t.setFilters({ columns: { 2: 'empty' } });
  assert.deepStrictEqual(t.getRows(0, 10).map(r => r.cells[1]), ['alice']);
  t.setFilters({ global: 'BOB' });
  assert.deepStrictEqual(t.getRows(0, 10).map(r => r.cells[1]), ['Bob']);
  t.setFilters({ columns: { 1: '!o' } });
  assert.deepStrictEqual(t.getRows(0, 10).map(r => r.cells[1]).sort(), ['', 'alice', 'carol'].filter(x => !x.includes('o')).sort());
  t.setFilters({ columns: { 1: '=alice' } });
  assert.strictEqual(t.viewCount, 1);
  t.setFilters({ columns: { 0: '>1' } });
  t.setSort(0, 'desc');
  assert.deepStrictEqual(t.getRows(0, 10).map(r => r.cells[0]), ['10', '3', '2']);
});

test('parseFilter edge cases', () => {
  assert.strictEqual(parseFilter('', true), null);
  assert.strictEqual(parseFilter('>=5', true)(5), true);
  assert.strictEqual(parseFilter('!=5', true)(5), false);
  assert.strictEqual(parseFilter('<5', true)(null), false);
  assert.strictEqual(parseFilter('abc', false)('xxABCxx'), true);
  assert.strictEqual(parseFilter('!empty', false)(''), false);
});

test('copy as CSV escapes delimiters, quotes and newlines', () => {
  const t = new Table([{ name: 'a,b', type: 'string' }, { name: 'n', type: 'int' }],
    [{ values: ['x "q"', 'line\nbreak', 'plain'] }, { values: [1, null, 3] }], 3);
  const r = t.copy({ r0: 0, r1: 2, c0: 0, c1: 1 }, 'csv');
  assert.strictEqual(r.text, '"a,b",n\r\n"x ""q""",1\r\n"line\nbreak",\r\nplain,3');
  assert.strictEqual(r.rows, 3);
  const tsv = t.copy({ r0: 2, r1: 2, c0: 0, c1: 1, header: false }, 'tsv');
  assert.strictEqual(tsv.text, 'plain\t3');
});

test('copy as JSON keeps types and follows the view order', () => {
  const t = new Table([{ name: 'n', type: 'int' }, { name: 'b', type: 'int' }, { name: 'd', type: 'date' }, { name: 'o', type: 'struct' }],
    [{ values: [2, 1] }, { values: [2n ** 60n, 5n] }, { values: [new Date(Date.UTC(2024, 0, 2)), null] }, { values: [{ x: 1n }, [1, 2]] }], 2);
  t.setSort(0, 'asc');
  const r = JSON.parse(t.copy({ r0: 0, r1: 1, c0: 0, c1: 3 }, 'json').text);
  assert.deepStrictEqual(r, [
    { n: 1, b: 5, d: null, o: [1, 2] },
    { n: 2, b: String(2n ** 60n), d: '2024-01-02', o: { x: 1 } },
  ]);
});

test('copy is capped and reports truncation', () => {
  const vals = Array.from({ length: 50 }, (_, i) => i);
  const t = new Table([{ name: 'i', type: 'int' }], [{ values: vals }], 50);
  const r = t.copy({ r0: 0, r1: 49, c0: 0, c1: 0 }, 'csv', 10);
  assert.strictEqual(r.rows, 10);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.text.split('\r\n').length, 11);
});

test('formatValue covers dates, bytes, nested and long text', () => {
  assert.strictEqual(formatValue(new Date(Date.UTC(2024, 4, 1, 12)), 'timestamp'), '2024-05-01T12:00:00Z');
  assert.strictEqual(formatValue(new Uint8Array([1, 255]), 'binary'), '0x01ff');
  assert.strictEqual(formatValue({ a: 1n, b: [true] }), '{"a":1,"b":[true]}');
  assert.strictEqual(jsonValue(Infinity), 'Infinity');
  const t = new Table([{ name: 's', type: 'string' }], [{ values: ['x'.repeat(5000)] }], 1);
  assert.ok(t.getRows(0, 1)[0].cells[0].length <= 2001);
  assert.strictEqual(t.copy({ r0: 0, r1: 0, c0: 0, c1: 0, header: false }, 'tsv').text.length, 5000);
});

test('duplicate and empty headers get unique names', () => {
  assert.deepStrictEqual(uniqueNames([{ name: 'a' }, { name: 'a' }, { name: '' }, { name: 'a_2' }]).map(c => c.name), ['a', 'a_2', 'column_3', 'a_2_2']);
});

test('ISO values that all carry a time are timestamps; plain dates stay dates', () => {
  assert.strictEqual(inferStringType(['2026-10-25T02:36:32.787Z', '2026-10-25 02:09:23']), 'timestamp');
  assert.strictEqual(inferStringType(['2026-10-25', '2026-10-26']), 'date');
});
