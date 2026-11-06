'use strict';
// Pro SQL WHERE filter: parser, three-valued logic, and use through Table.setFilters.
const test = require('node:test');
const assert = require('node:assert');
const { Table, tableFromStringColumns } = require('../src/core/table');
const { compileQuery, parse, likeRegex } = require('../src/core/query');

function trips() {
  return tableFromStringColumns(['id', 'city', 'fare', 'tip', 'paid', 'day', 'trip distance'], [
    ['1', '2', '3', '4', '5', '6'],
    ['Paris', 'London', 'paris', 'Lyon', '', "O'Hare"],
    ['25.5', '8', '40', '12', '19.99', '3'],
    ['2', '', '5', '0', '1', ''],
    ['true', 'false', 'true', 'false', '', 'true'],
    ['2024-01-05', '2024-01-31', '2024-02-01', '2023-12-31', '2024-01-15', '2024-01-01'],
    ['1.5', '3', '12', '0.4', '2.5', '7'],
  ], 6);
}

function ids(t, q) {
  const f = compileQuery(q, t);
  const out = [];
  for (let r = 0; r < t.rowCount; r++) if (f(r)) out.push(Number(t.get(r, 0)));
  return out;
}

test('comparisons, AND, OR, NOT and parentheses', () => {
  const t = trips();
  assert.deepStrictEqual(ids(t, 'fare > 20'), [1, 3]);
  assert.deepStrictEqual(ids(t, 'WHERE fare >= 12 AND fare <= 25.5'), [1, 4, 5]);
  assert.deepStrictEqual(ids(t, "fare > 20 OR city = 'Lyon'"), [1, 3, 4]);
  assert.deepStrictEqual(ids(t, "NOT (city = 'Paris') AND fare < 10"), [2, 6]);
  assert.deepStrictEqual(ids(t, "(fare > 20 OR fare < 5) AND id != 3"), [1, 6]);
  assert.deepStrictEqual(ids(t, 'id <> 1 and id == 2'), [2]);
  assert.deepStrictEqual(ids(t, 'fare > -1 AND tip > -0.5'), [1, 3, 4, 5]);
  assert.deepStrictEqual(ids(t, 'fare > tip'), [1, 3, 4, 5]);
});

test('text: = is exact, LIKE and ILIKE ignore case, quotes escape', () => {
  const t = trips();
  assert.deepStrictEqual(ids(t, "city = 'Paris'"), [1]);
  assert.deepStrictEqual(ids(t, "city LIKE 'par%'"), [1, 3]);
  assert.deepStrictEqual(ids(t, "city ILIKE 'L_on'"), [4]);
  assert.deepStrictEqual(ids(t, "city NOT LIKE '%o%'"), [1, 3]);
  assert.deepStrictEqual(ids(t, "city = 'O''Hare'"), [6]);
  assert.ok(likeRegex('a.b%').test('A.Bcd'));
  assert.ok(!likeRegex('a.b').test('axb'), 'dots are literal');
});

test('IN, BETWEEN, IS NULL, booleans and dates', () => {
  const t = trips();
  assert.deepStrictEqual(ids(t, 'id IN (1, 3, 9)'), [1, 3]);
  assert.deepStrictEqual(ids(t, "city NOT IN ('Paris', 'Lyon')"), [2, 3, 6]);
  assert.deepStrictEqual(ids(t, 'fare BETWEEN 8 AND 19.99'), [2, 4, 5]);
  assert.deepStrictEqual(ids(t, 'fare NOT BETWEEN 8 AND 19.99'), [1, 3, 6]);
  assert.deepStrictEqual(ids(t, 'tip IS NULL'), [2, 6]);
  assert.deepStrictEqual(ids(t, 'tip IS NOT NULL AND tip = 0'), [4]);
  assert.deepStrictEqual(ids(t, 'paid = TRUE'), [1, 3, 6]);
  assert.deepStrictEqual(ids(t, 'paid'), [1, 3, 6]);
  assert.deepStrictEqual(ids(t, 'NOT paid'), [2, 4]);
  assert.deepStrictEqual(ids(t, "day BETWEEN '2024-01-01' AND '2024-01-31'"), [1, 2, 5, 6]);
  assert.deepStrictEqual(ids(t, "day < '2024'"), [4]);
});

test('NULL follows SQL: comparisons with NULL are unknown, so NOT does not flip them', () => {
  const t = trips();
  assert.deepStrictEqual(ids(t, 'tip > 1'), [1, 3]);
  assert.deepStrictEqual(ids(t, 'NOT (tip > 1)'), [4, 5]);
  assert.deepStrictEqual(ids(t, 'tip = NULL'), []);
  assert.deepStrictEqual(ids(t, 'tip > 1 OR tip IS NULL'), [1, 2, 3, 6]);
  assert.deepStrictEqual(ids(t, 'id NOT IN (1, NULL)'), [], 'NOT IN with a NULL in the list matches nothing');
});

test('column names: quoted, case-insensitive, and clear errors for unknown ones', () => {
  const t = trips();
  assert.deepStrictEqual(ids(t, '"trip distance" > 5'), [3, 6]);
  assert.deepStrictEqual(ids(t, '`trip distance` > 5 AND [Fare] < 10'), [6]);
  assert.deepStrictEqual(ids(t, 'FARE > 39'), [3]);
  assert.throws(() => compileQuery('price > 3', t), e => e.code === 'QUERY' && /No column named "price"/.test(e.message) && /city/.test(e.message));
  assert.throws(() => compileQuery('city = Paris', t), /No column named "Paris".*single quotes/);
});

test('syntax errors are plain and point at the spot', () => {
  const t = trips();
  const bad = {
    "city = 'Paris": /no closing quote/,
    'fare >': /Expected a column or a value at the end/,
    '(fare > 1': /closing \)/,
    'fare > 1 fare < 3': /Unexpected "fare" at character 10\. Join conditions with AND or OR/,
    'fare BETWEEN 1 OR 3': /Expected AND in BETWEEN/,
    'tip IS 3': /Expected NULL after IS/,
    'fare NOT = 3': /Expected LIKE, IN or BETWEEN after NOT/,
    'id IN (fare)': /IN lists take values/,
    'fare > 1; DROP TABLE x': /Unexpected ";"/,
    ['x'.repeat(2001)]: /longer than 2000/,
  };
  for (const [q, re] of Object.entries(bad)) assert.throws(() => compileQuery(q, t), e => e.code === 'QUERY' && re.test(e.message), q.slice(0, 40));
  assert.throws(() => parse('('.repeat(200) + '1' + ')'.repeat(200)), /nested too deep/);
  assert.strictEqual(compileQuery('', t), null);
  assert.strictEqual(compileQuery('  WHERE  ', t), null);
});

test('Table.setFilters applies the query with the other filters and keeps the view on a bad query', () => {
  const t = trips();
  t.setFilters({ global: '', columns: { 2: '>5' }, query: "city LIKE '%a%'" });
  assert.deepStrictEqual(t.getRows(0, 10).map(r => r.cells[0]), ['1', '3']);
  assert.strictEqual(t.filters.query, "city LIKE '%a%'");
  t.setSort(2, 'desc');
  assert.deepStrictEqual(t.getRows(0, 10).map(r => r.cells[0]), ['3', '1']);
  assert.throws(() => t.setFilters({ global: '', columns: {}, query: 'nope >' }), e => e.code === 'QUERY');
  assert.strictEqual(t.viewCount, 2, 'view unchanged after a bad query');
  t.setFilters({ global: '', columns: {} });
  assert.strictEqual(t.viewCount, 6);
  assert.strictEqual(t.filters.query, undefined);
});

test('the query handles 200,000 rows quickly', () => {
  const n = 200000;
  const a = new Float64Array(n), s = new Array(n);
  for (let i = 0; i < n; i++) { a[i] = i % 1000; s[i] = i % 3 ? 'card' : 'cash'; }
  const t = new Table([{ name: 'fare', type: 'float' }, { name: 'pay', type: 'string' }], [{ values: a }, { values: s }], n);
  const t0 = Date.now();
  t.setFilters({ global: '', columns: {}, query: "fare BETWEEN 100 AND 199 AND pay = 'cash'" });
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(Math.abs(t.viewCount - 20000 / 3) < 50, String(t.viewCount));
});
