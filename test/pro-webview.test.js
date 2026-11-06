'use strict';
// Webview helpers for the Pro UI (no DOM needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/webview/math');

test('stats rows: numbers formatted, capped distinct marked, unique columns summarized', () => {
  const rows = M.statsRows({ rows: 3, columns: [
    { name: 'fare', type: 'float', count: 3, nulls: 1, distinct: 2, distinctCapped: false, min: '1', max: '1234.5', sum: 1236.5, mean: 412.1666666666, top: [{ value: '1', count: 2 }, { value: '1234.5', count: 1 }], topApprox: false },
    { name: 'id', type: 'int', count: 3, nulls: 0, distinct: 3, min: '1', max: '3', mean: 2, top: [{ value: '1', count: 1 }], topApprox: false },
    { name: 'note', type: 'string', count: 2, nulls: 0, distinct: 100000, distinctCapped: true, min: '', max: 'z', minLength: 0, maxLength: 9, top: [{ value: '', count: 2 }], topApprox: true },
  ] });
  assert.deepStrictEqual(rows[0], ['fare', 'float', '3', '1', '2', '1', '1234.5', '412.166667', '1 (2), 1234.5 (1)']);
  assert.strictEqual(rows[1][8], 'all different');
  assert.deepStrictEqual(rows[2].slice(4), ['100,000+', '', 'z', 'length 0..9', '(empty) (2) ~']);
  assert.deepStrictEqual(M.statsRows(null), []);
});

test('filters from meta keep the SQL query', () => {
  assert.deepStrictEqual(M.filtersFromMeta({ global: 'a', columns: {}, query: "x = 'y'" }), { global: 'a', columns: {}, query: "x = 'y'" });
  assert.deepStrictEqual(M.filtersFromMeta({ global: '', columns: {}, query: '  ' }), { global: '', columns: {} });
  assert.deepStrictEqual(M.filtersFromMeta({ global: '', columns: {}, query: 5 }), { global: '', columns: {} });
});

test('the webview writes file content and stats only through textContent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
