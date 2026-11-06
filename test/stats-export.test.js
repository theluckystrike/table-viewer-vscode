'use strict';
// Pro column stats and export of the filtered, sorted view.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Table, tableFromStringColumns } = require('../src/core/table');
const { computeStats } = require('../src/core/stats');
const { writeChunks } = require('../src/core/exportfile');
const { CsvParser } = require('../src/core/csv');

function sample() {
  return tableFromStringColumns(['id', 'name', 'score', 'ok'], [
    ['1', '2', '3', '4', '5'],
    ['ann', 'bob, jr', '', 'ann', 'say "hi"'],
    ['2.5', '', '-1', '10', '2.5'],
    ['true', 'false', 'true', '', 'true'],
  ], 5);
}

test('stats: count, nulls, distinct, min, max, mean, lengths and top values', () => {
  const s = computeStats(sample());
  assert.strictEqual(s.rows, 5);
  const [id, name, score, ok] = s.columns;
  assert.deepStrictEqual([id.count, id.nulls, id.distinct, id.min, id.max, id.sum, id.mean], [5, 0, 5, '1', '5', 15, 3]);
  assert.strictEqual(name.count, 5, "'' is a value in a text column");
  assert.strictEqual(name.distinct, 4);
  assert.deepStrictEqual(name.top[0], { value: 'ann', count: 2 });
  assert.strictEqual(name.min, '');
  assert.strictEqual(name.max, 'say "hi"');
  assert.deepStrictEqual([name.minLength, name.maxLength], [0, 8]);
  assert.strictEqual(name.mean, undefined);
  assert.deepStrictEqual([score.count, score.nulls, score.distinct, score.min, score.max, score.mean], [4, 1, 3, '-1', '10', 3.5]);
  assert.deepStrictEqual(score.top[0], { value: '2.5', count: 2 });
  assert.deepStrictEqual([ok.count, ok.nulls, ok.distinct, ok.min, ok.max], [4, 1, 2, 'false', 'true']);
  assert.deepStrictEqual(ok.top, [{ value: 'true', count: 3 }, { value: 'false', count: 1 }]);
});

test('stats follow the current filter and cap distinct counting', () => {
  const t = sample();
  t.setFilters({ global: '', columns: { 2: '>0' } });
  const s = computeStats(t, { columns: [2] });
  assert.strictEqual(s.rows, 3);
  assert.deepStrictEqual([s.columns[0].count, s.columns[0].min, s.columns[0].max], [3, '2.5', '10']);
  const n = 1000;
  const big = new Table([{ name: 'k', type: 'string' }], [{ values: Array.from({ length: n }, (_, i) => `v${i % 300}`) }], n);
  const c = computeStats(big, { maxDistinct: 100 }).columns[0];
  assert.strictEqual(c.distinct, 100);
  assert.strictEqual(c.distinctCapped, true);
  assert.strictEqual(c.topApprox, true);
  const empty = computeStats(new Table([{ name: 'x', type: 'int' }], [{ values: new Float64Array(0) }], 0)).columns[0];
  assert.deepStrictEqual([empty.count, empty.min, empty.max, empty.mean], [0, null, null, undefined]);
});

function exportText(t, fmt, batch) { return [...t.exportChunks(fmt, batch)].join(''); }

test('export CSV and TSV: header, quoting, nulls, view order, every row', () => {
  const t = sample();
  t.setSort(0, 'desc');
  const csv = exportText(t, 'csv', 2);
  assert.strictEqual(csv, 'id,name,score,ok\r\n5,"say ""hi""",2.5,true\r\n4,ann,10,\r\n3,,-1,true\r\n2,"bob, jr",,false\r\n1,ann,2.5,true\r\n');
  // Round trip through the CSV parser.
  const rows = [];
  const p = new CsvParser(',', f => rows.push(f));
  p.push(csv); p.end();
  assert.deepStrictEqual(rows[1], ['5', 'say "hi"', '2.5', 'true']);
  assert.strictEqual(rows.length, 6);
  t.setFilters({ global: 'ann', columns: {} });
  assert.strictEqual(exportText(t, 'tsv'), 'id\tname\tscore\tok\r\n4\tann\t10\t\r\n1\tann\t2.5\ttrue\r\n');
});

test('export JSON and JSON Lines keep types and nulls, and work for an empty view', () => {
  const t = sample();
  t.setFilters({ global: '', columns: { 0: '<3' } });
  const arr = JSON.parse(exportText(t, 'json', 1));
  assert.deepStrictEqual(arr, [{ id: 1, name: 'ann', score: 2.5, ok: true }, { id: 2, name: 'bob, jr', score: null, ok: false }]);
  const lines = exportText(t, 'jsonl').trimEnd().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines, arr);
  t.setFilters({ global: 'nobody', columns: {} });
  assert.deepStrictEqual(JSON.parse(exportText(t, 'json')), []);
  assert.strictEqual(exportText(t, 'jsonl'), '');
  assert.strictEqual(exportText(t, 'csv'), 'id,name,score,ok\r\n');
  assert.throws(() => exportText(t, 'xml'), /Unknown export format/);
});

test('writeChunks streams an export to disk and reports the bytes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const n = 50000;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = i;
  const big = new Table([{ name: 'n', type: 'int' }, { name: 's', type: 'string' }], [{ values: v }, { values: Array.from({ length: n }, (_, i) => 'x' + i) }], n);
  const file = path.join(dir, 'out.csv');
  const bytes = await writeChunks(file, big.exportChunks('csv', 1000));
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(bytes, Buffer.byteLength(text));
  assert.strictEqual(text.split('\r\n').length, n + 2);
  assert.ok(text.endsWith('49999,x49999\r\n'));
  await assert.rejects(writeChunks(path.join(dir, 'no', 'such', 'dir', 'x.csv'), ['a']), /ENOENT/);
});
