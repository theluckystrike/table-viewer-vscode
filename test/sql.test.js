'use strict';
// Query panel (0.5): parser, functions, executor, sources, session wiring and host checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSql, sourcesOf } = require('../src/core/sql/parse');
const { runSql, createContext } = require('../src/core/sql/exec');
const { csvSource, parquetSource, tableSource } = require('../src/core/sql/sources');
const { resultTable } = require('../src/core/sql/index');
const V = require('../src/core/sql/values');
const { createSession, validateWebviewMessage } = require('../src/core/protocol');
const { loadFile } = require('../src/core/readers');
const { resolveQueryFiles, pushHistory, historyFor } = require('../src/queryhost');

const FX = path.join(__dirname, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sql-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name, text) { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; }

// orders.csv + customers.csv + a Parquet copy of customers, small and hand-checkable
const ORDERS = 'order_id,customer_id,amount,day,status\n1,10,25.5,2026-01-03,paid\n2,11,10,2026-01-03,paid\n3,10,4.5,2026-02-10,refund\n4,12,100,2026-02-11,paid\n5,99,7,2026-03-01,paid\n6,,3,2026-03-02,paid\n';
const CUSTOMERS = 'id,name,country\n10,Ana,PT\n11,Ben,US\n12,Chen,CN\n13,Dee,US\n';
const ordersPath = write('orders.csv', ORDERS);
const customersPath = write('customers.csv', CUSTOMERS);

let customersParquet = null;
test.before(async () => {
  const { parquetWriteBuffer } = await import('hyparquet-writer');
  const buf = parquetWriteBuffer({ columnData: [
    { name: 'id', data: [10n, 11n, 12n, 13n], type: 'INT64' },
    { name: 'name', data: ['Ana', 'Ben', 'Chen', 'Dee'], type: 'STRING' },
    { name: 'country', data: ['PT', 'US', 'CN', 'US'], type: 'STRING' },
  ] });
  customersParquet = path.join(tmp, 'customers.parquet');
  fs.writeFileSync(customersParquet, Buffer.from(buf));
  // 10 row groups of 1,000 rows: v = 0..9999, for min/max pruning
  const n = 10000;
  const big = parquetWriteBuffer({ columnData: [
    { name: 'v', data: Array.from({ length: n }, (_, i) => i), type: 'INT32' },
    { name: 'g', data: Array.from({ length: n }, (_, i) => `g${i % 3}`), type: 'STRING' },
  ], rowGroupSize: 1000 });
  fs.writeFileSync(path.join(tmp, 'groups.parquet'), Buffer.from(big));
});

function resolverFor(map) {
  return async ref => {
    const key = ref.kind === 'this' ? 'this' : ref.value;
    const f = map[key];
    if (!f) throw Object.assign(new Error(`no source ${key}`), { code: 'SQL' });
    if (typeof f === 'function') return f();
    if (f.endsWith('.parquet')) return parquetSource({ path: f }, path.basename(f, '.parquet'));
    return csvSource({ path: f }, {}, path.basename(f).replace(/\.[^.]+$/, ''));
  };
}
const env = (map, extra = {}) => ({ resolve: resolverFor(map), ...extra });
const q = async (sql, map = { this: ordersPath, 'customers.csv': customersPath }, extra) => runSql(sql, env(map, extra), createContext());

test('parser: full SELECT, joins, functions and clear errors', () => {
  const ast = parseSql("SELECT DISTINCT a.x AS y, COUNT(*), SUM(DISTINCT b.z) FROM this a LEFT JOIN 'f.csv' b ON a.id = b.id WHERE a.x > 1 GROUP BY 1 HAVING COUNT(*) > 2 ORDER BY 2 DESC NULLS FIRST LIMIT 10 OFFSET 5;");
  assert.strictEqual(ast.distinct, true);
  assert.strictEqual(ast.joins[0].type, 'left');
  assert.deepStrictEqual(sourcesOf(ast).map(r => r.kind), ['name', 'path']);
  assert.strictEqual(ast.limit, 10);
  assert.strictEqual(ast.offset, 5);
  assert.strictEqual(ast.orderBy[0].nulls, 'first');
  assert.throws(() => parseSql('DELETE FROM this'), /Only SELECT queries run here/);
  assert.throws(() => parseSql('DROP TABLE x'), /never writes to your files/);
  assert.throws(() => parseSql('SELECT 1; SELECT 2'), /one query at a time/);
  assert.throws(() => parseSql("SELECT 'open"), /no closing quote/);
  assert.throws(() => parseSql('SELECT a FROM t RIGHT JOIN u ON 1=1'), /LEFT JOIN/);
  assert.throws(() => parseSql('SELECT x FROM this WHERE x IN (SELECT 1)'), /Use a JOIN/);
  assert.throws(() => parseSql(''), /empty/);
  assert.throws(() => parseSql('SELECT ' + 'x,'.repeat(12000) + 'x'), /longer than/);
});

test('hostile: 50 nested subqueries stop with a clear message, not a stack overflow', () => {
  let s = 'SELECT 1 AS x';
  for (let i = 0; i < 50; i++) s = `SELECT x FROM (${s}) t${i}`;
  assert.throws(() => parseSql(s), /more than 8 nested SELECTs/);
  let deep = '1';
  for (let i = 0; i < 500; i++) deep = `(${deep} + 1)`;
  assert.throws(() => parseSql(`SELECT ${deep}`), /nested too deep/);
  // 7 levels still work
  let ok = 'SELECT 1 AS x';
  for (let i = 0; i < 6; i++) ok = `SELECT x FROM (${ok}) t${i}`;
  assert.ok(parseSql(ok));
});

test('values: numeric text compares as numbers, keys merge 1 and 1.0, dates parse as UTC', () => {
  assert.strictEqual(V.cmp('10', '9'), 1);
  assert.strictEqual(V.cmp('apple', 'banana'), -1);
  assert.strictEqual(V.cmp(5, 'x'), -1);
  assert.strictEqual(V.keyOf(1), V.keyOf('1.0'));
  assert.notStrictEqual(V.keyOf('a'), V.keyOf('b'));
  assert.strictEqual(V.toDate('2026-03-01').toISOString(), '2026-03-01T00:00:00.000Z');
  assert.strictEqual(V.toDate('2026-03-01 10:20:30+02:00').toISOString(), '2026-03-01T08:20:30.000Z');
  assert.strictEqual(V.binary('/', 1, 0), null);
  assert.strictEqual(V.binary('||', 'a', null), null);
  assert.strictEqual(V.FUNCTIONS.ROUND[2]([2.675, 2]), 2.68);
  assert.strictEqual(V.FUNCTIONS.SUBSTR[2](['héllo', 2, 3]), 'éll');
  assert.strictEqual(V.FUNCTIONS.STRFTIME[2](['%Y/%m', '2026-03-09']), '2026/03');
  assert.strictEqual(V.FUNCTIONS.DATE_TRUNC[2](['month', '2026-03-09T10:00:00Z']).toISOString(), '2026-03-01T00:00:00.000Z');
  assert.strictEqual(V.FUNCTIONS.DATE_DIFF[2](['day', '2026-03-01', '2026-03-09']), 8);
  assert.strictEqual(V.cast('12.9', 'INTEGER'), 12);
  assert.throws(() => V.cast('1', 'BLOB'), /CAST does not know/);
});

test('SELECT over a streamed CSV: columns, expressions, WHERE, ORDER BY, LIMIT', async () => {
  const r = await q("SELECT order_id, amount * 2 AS double, UPPER(status) s FROM this WHERE amount >= 10 ORDER BY amount DESC LIMIT 2");
  assert.deepStrictEqual(r.columns.map(c => c.name), ['order_id', 'double', 's']);
  assert.deepStrictEqual(r.rows, [[4, 200, 'PAID'], [1, 51, 'PAID']]);
  const all = await q('SELECT * FROM this');
  assert.strictEqual(all.rows.length, 6);
  assert.strictEqual(all.rows[5][1], null, 'empty CSV cell is NULL');
});

test('GROUP BY with COUNT, SUM, AVG, MIN, MAX, COUNT(DISTINCT), HAVING and ORDER BY an aggregate', async () => {
  const r = await q(`SELECT status, COUNT(*) AS n, SUM(amount) total, ROUND(AVG(amount), 2) avg, MIN(day) first_day, MAX(amount) mx,
    COUNT(DISTINCT customer_id) customers FROM this GROUP BY status HAVING COUNT(*) >= 1 ORDER BY n DESC`);
  assert.deepStrictEqual(r.rows, [
    ['paid', 5, 145.5, 29.1, '2026-01-03', 100, 4],
    ['refund', 1, 4.5, 4.5, '2026-02-10', 4.5, 1],
  ]);
  const one = await q('SELECT COUNT(*) AS n, SUM(amount) FROM this WHERE amount > 1000');
  assert.deepStrictEqual(one.rows, [[0, null]], 'aggregates over no rows give one row');
  const byMonth = await q("SELECT STRFTIME('%Y-%m', day) AS month, COUNT(*) n FROM this GROUP BY month ORDER BY month");
  assert.deepStrictEqual(byMonth.rows, [['2026-01', 2], ['2026-02', 2], ['2026-03', 2]]);
  const pos = await q('SELECT status, SUM(amount) FROM this GROUP BY 1 ORDER BY 2');
  assert.deepStrictEqual(pos.rows.map(x => x[0]), ['refund', 'paid']);
  const gc = await q("SELECT GROUP_CONCAT(order_id, '|') ids, MEDIAN(amount) med FROM this WHERE status = 'paid'");
  assert.deepStrictEqual(gc.rows, [['1|2|4|5|6', 10]]);
});

test('CASE, CAST, COALESCE, LIKE, IN, BETWEEN, IS NULL and DISTINCT', async () => {
  const r = await q(`SELECT order_id, CASE WHEN amount >= 50 THEN 'big' WHEN amount >= 10 THEN 'mid' ELSE 'small' END size,
    CAST(amount AS INTEGER) whole, COALESCE(customer_id, -1) cid FROM this
    WHERE status LIKE 'p%' AND order_id IN (1, 4, 6) AND amount BETWEEN 1 AND 100 ORDER BY order_id`);
  assert.deepStrictEqual(r.rows, [[1, 'mid', 25, 10], [4, 'big', 100, 12], [6, 'small', 3, -1]]);
  const n = await q('SELECT COUNT(*) FROM this WHERE customer_id IS NULL');
  assert.strictEqual(n.rows[0][0], 1);
  const d = await q('SELECT DISTINCT status FROM this ORDER BY status');
  assert.deepStrictEqual(d.rows, [['paid'], ['refund']]);
});

test('JOIN: CSV with CSV and CSV with Parquet give the same rows; LEFT JOIN keeps unmatched rows', async () => {
  const sql = f => `SELECT o.order_id, c.name, c.country FROM this o JOIN '${f}' c ON o.customer_id = c.id ORDER BY o.order_id`;
  const a = await q(sql('customers.csv'));
  const b = await q(sql('customers.parquet'), { this: ordersPath, 'customers.parquet': customersParquet });
  assert.deepStrictEqual(a.rows, [[1, 'Ana', 'PT'], [2, 'Ben', 'US'], [3, 'Ana', 'PT'], [4, 'Chen', 'CN']]);
  assert.deepStrictEqual(b.rows, a.rows);
  const left = await q("SELECT o.order_id, c.name FROM this o LEFT JOIN 'customers.csv' c ON o.customer_id = c.id ORDER BY o.order_id");
  assert.deepStrictEqual(left.rows.map(x => x[1]), ['Ana', 'Ben', 'Ana', 'Chen', null, null]);
  const agg = await q("SELECT c.country, SUM(o.amount) total FROM this o JOIN 'customers.csv' c ON o.customer_id = c.id GROUP BY c.country ORDER BY total DESC");
  assert.deepStrictEqual(agg.rows, [['CN', 100], ['PT', 30], ['US', 10]]);
  await assert.rejects(q("SELECT name FROM 'customers.csv' a JOIN 'customers.csv' b ON a.id = b.id"), /Column "name" is in a and b. Write a."name"/);
  await assert.rejects(q("SELECT name FROM this o JOIN 'customers.csv' c ON o.customer_id = c.id AND x.y = 1"), /No source named "x"/);
});

test('subquery in FROM and a derived table join', async () => {
  const r = await q("SELECT s.customer_id, s.total FROM (SELECT customer_id, SUM(amount) total FROM this GROUP BY customer_id) s WHERE s.total > 20 ORDER BY s.total DESC");
  assert.deepStrictEqual(r.rows, [[12, 100], [10, 30]]);
});

test('errors name the problem: unknown column, unknown function, aggregate in WHERE, bad arity', async () => {
  await assert.rejects(q('SELECT nope FROM this'), /No column named "nope". Columns: order_id/);
  await assert.rejects(q('SELECT FOO(amount) FROM this'), /Unknown function FOO/);
  await assert.rejects(q('SELECT * FROM this WHERE COUNT(*) > 1'), /HAVING/);
  await assert.rejects(q('SELECT ROUND() FROM this'), /takes 1 to 2 values/);
  await assert.rejects(q('SELECT * FROM this ORDER BY 9'), /has 5 columns/);
});

test('LIMIT without ORDER BY stops reading early; ORDER BY + LIMIT keeps only the top rows', async () => {
  const lines = ['i,grp'];
  for (let i = 0; i < 200000; i++) lines.push(`${i},${i % 7}`);
  const p = write('many.csv', lines.join('\n') + '\n');
  const ctx = createContext();
  const r = await runSql('SELECT i FROM this LIMIT 3', env({ this: p }), ctx);
  assert.deepStrictEqual(r.rows, [[0], [1], [2]]);
  assert.ok(ctx.rows < 200000, `read ${ctx.rows} rows`);
  const ctx2 = createContext();
  const top = await runSql('SELECT i FROM this ORDER BY i DESC LIMIT 2', env({ this: p }), ctx2);
  assert.deepStrictEqual(top.rows, [[199999], [199998]]);
  assert.ok(ctx2.mem < 50 * 1024 * 1024, 'top-k keeps memory small');
  const g = await runSql('SELECT grp, COUNT(*) n FROM this GROUP BY grp ORDER BY grp', env({ this: p }), createContext());
  assert.strictEqual(g.rows.length, 7);
  assert.strictEqual(g.rows.reduce((a, x) => a + x[1], 0), 200000);
});

test('memory cap: a result or GROUP BY that would not fit stops with a message', async () => {
  const lines = ['id,txt'];
  for (let i = 0; i < 60000; i++) lines.push(`${i},${'x'.repeat(40)}${i}`);
  const p = write('wide.csv', lines.join('\n') + '\n');
  await assert.rejects(runSql('SELECT * FROM this ORDER BY txt', env({ this: p }, { memCapMB: 2 }), createContext()), /more memory than its limit \(2 MB/);
  await assert.rejects(runSql('SELECT txt, COUNT(*) FROM this GROUP BY txt', env({ this: p }, { memCapMB: 2 }), createContext()), /GROUP BY/);
  // Without ORDER BY the result is cut at maxResultRows and says so.
  const r = await runSql('SELECT id FROM this', env({ this: p }, { maxResultRows: 1000 }), createContext());
  assert.strictEqual(r.rows.length, 1000);
  assert.strictEqual(r.truncated, true);
});

test('hostile: a cross join of two big sources stops (pairs cap), and so does its memory', async () => {
  const lines = ['k'];
  for (let i = 0; i < 20000; i++) lines.push(String(i));
  const a = write('a.csv', lines.join('\n'));
  const b = write('b.csv', lines.join('\n'));
  const map = { this: a, 'b.csv': b };
  await assert.rejects(runSql("SELECT COUNT(*) FROM this CROSS JOIN 'b.csv' y", env(map, { maxPairs: 1e6 }), createContext()), /more than 1,000,000 row pairs/);
  await assert.rejects(runSql("SELECT * FROM this, 'b.csv' y ORDER BY 1", env(map, { memCapMB: 4, maxPairs: 1e9 }), createContext()), /more memory than its limit/);
});

test('cancel stops a running scan', async () => {
  const lines = ['i'];
  for (let i = 0; i < 300000; i++) lines.push(String(i));
  const p = write('cancel.csv', lines.join('\n'));
  const ctx = createContext({ onProgress: () => { ctx.cancelled = true; }, progressMs: 0 });
  await assert.rejects(runSql('SELECT COUNT(*) FROM this', env({ this: p }), ctx), e => e.cancelled === true && /cancelled/.test(e.message));
});

test('hostile CSV: semicolon file named .csv, a 10 MB field, mixed types in one column', async () => {
  const semi = write('semi.csv', 'a;b\n1;x\n2;y\n');
  const r = await q('SELECT SUM(a), MAX(b) FROM this', { this: semi });
  assert.deepStrictEqual(r.rows, [[3, 'y']]);
  const huge = write('huge-field.csv', `id,blob,n\n1,"${'z'.repeat(10 * 1024 * 1024)}",5\n2,small,7\n`);
  const h = await q('SELECT id, LENGTH(blob) len, n FROM this ORDER BY id', { this: huge });
  assert.deepStrictEqual(h.rows, [[1, 10 * 1024 * 1024, 5], [2, 5, 7]]);
  const mixed = write('mixed.csv', 'v\n10\n9\nabc\n\n2.5\ntrue\n');
  const m = await q('SELECT v FROM this ORDER BY v', { this: mixed });
  assert.deepStrictEqual(m.rows.map(x => x[0]), ['2.5', '9', '10', 'abc', 'true', null]);
  const s = await q('SELECT SUM(v), COUNT(v), COUNT(*) FROM this', { this: mixed });
  assert.deepStrictEqual(s.rows, [[21.5, 5, 6]]);
});

test('Parquet: column pruning and row groups skipped by min/max statistics', async () => {
  const p = path.join(tmp, 'groups.parquet');
  const rel = await parquetSource({ path: p }, 'groups');
  const ctx = createContext();
  const r = await runSql('SELECT COUNT(*) n, MIN(v), MAX(v) FROM this WHERE v >= 8500', { resolve: async () => rel }, ctx);
  assert.deepStrictEqual(r.rows, [[1500, 8500, 9999]]);
  assert.strictEqual(rel.skippedGroups, 8);
  assert.ok(ctx.notes.some(n => /Skipped 8 of 10 Parquet row groups/.test(n)));
  assert.strictEqual(ctx.rows, 2000, 'only the 2 row groups that can match were read');
  const g = await runSql('SELECT g, COUNT(*) FROM this GROUP BY g ORDER BY g', { resolve: async () => parquetSource({ path: p }, 'groups') }, createContext());
  assert.deepStrictEqual(g.rows, [['g0', 3334], ['g1', 3333], ['g2', 3333]]);
});

test('in-memory tables (the loaded file, other sheets): Excel workbook with typed values', async () => {
  const x = await loadFile({ path: path.join(FX, 'sample.xlsx') }, 'excel', {});
  const rel = tableSource(x.table, 'this');
  const r = await runSql('SELECT COUNT(*) AS n FROM this', { resolve: async () => rel }, createContext());
  assert.strictEqual(r.rows[0][0], x.table.rowCount);
  const pq = await loadFile({ path: path.join(FX, 'sample.parquet') }, 'parquet', {});
  const r2 = await runSql('SELECT YEAR(created) y, COUNT(*) n FROM this GROUP BY y ORDER BY y', { resolve: async () => tableSource(pq.table, 'this') }, createContext());
  assert.ok(r2.rows.length >= 1 && typeof r2.rows[0][0] === 'number');
});

test('a loaded CSV table: empty cells are NULL (sort last, not counted), as in the SQL filter', async () => {
  const p = write('mixed-loaded.csv', 'v,label\n10,a\n9,b\nabc,c\n,d\n2.5,e\n2026-01-01,f\n');
  const t = await loadFile({ path: p }, 'csv', {});
  const rel = () => tableSource(t.table, 'this');
  const r = await runSql('SELECT v FROM this ORDER BY v', { resolve: async () => rel() }, createContext());
  assert.deepStrictEqual(r.rows.map(x => x[0]), ['2.5', '9', '10', '2026-01-01', 'abc', null]);
  const c = await runSql('SELECT COUNT(v), COUNT(*) FROM this WHERE v IS NULL OR v IS NOT NULL', { resolve: async () => rel() }, createContext());
  assert.deepStrictEqual(c.rows, [[5, 6]]);
  // the order is a total order: every pair agrees with the sorted list
  const vals = ['2.5', '9', '10', '2026-01-01', 'abc', 'true'];
  for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) assert.strictEqual(V.cmp(vals[i], vals[j]), -1, `${vals[i]} < ${vals[j]}`);
});

test('resultTable: types for the grid', () => {
  const t = resultTable({ columns: [{ name: 'n' }, { name: 's' }, { name: 'd' }, { name: 'b' }], rows: [[1, 'a', new Date('2026-01-01T00:00:00Z'), true], [2.5, null, new Date('2026-01-02T00:00:00Z'), false]] });
  assert.deepStrictEqual(t.columns.map(c => c.type), ['float', 'string', 'date', 'bool']);
  assert.strictEqual(t.getRows(0, 1)[0].cells[2], '2026-01-01');
});

// ---------- session wiring ----------
function sessionFor(file, format = 'csv') {
  const out = [];
  const s = createSession({ post: m => out.push(m), loader: (src, fmt, o, onPreview) => loadFile(src, fmt, o, onPreview), engine: require('../src/core/sql/engine') });
  return { s, out, open: () => s.handle({ type: 'open', source: { path: file }, format, options: {} }) };
}
const last = (out, type) => out.filter(m => m.type === type).pop();

test('session: a query result replaces the grid; sort, copy and export work on it; Back shows the file', async () => {
  const { s, out, open } = sessionFor(ordersPath);
  await open();
  await s.handle({ type: 'query', sql: "SELECT status, COUNT(*) AS n FROM this GROUP BY status", fileName: 'orders.csv' });
  const done = last(out, 'queryDone');
  assert.strictEqual(done.ok, true, done.error);
  assert.strictEqual(done.rows, 2);
  const meta = last(out, 'meta');
  assert.deepStrictEqual(meta.columns.map(c => c.name), ['status', 'n']);
  assert.ok(meta.info.query && /GROUP BY/.test(meta.info.query.sql));
  s.handle({ type: 'sort', col: 1, dir: 'asc' });
  s.handle({ type: 'copy', format: 'csv', sel: { r0: 0, r1: 1, c0: 0, c1: 1, header: true } });
  assert.strictEqual(last(out, 'copyResult').text.trim().replace(/\r/g, ''), 'status,n\nrefund,1\npaid,5');
  const pq = path.join(tmp, 'result.parquet');
  await s.handle({ type: 'export', format: 'parquet', path: pq });
  assert.strictEqual(last(out, 'exportResult').ok, true, last(out, 'exportResult').error);
  const back = await loadFile({ path: pq }, 'parquet', {});
  assert.strictEqual(back.table.rowCount, 2);
  // FROM result: query the shown result again
  await s.handle({ type: 'query', sql: 'SELECT SUM(n) AS total FROM result' });
  assert.strictEqual(last(out, 'queryDone').ok, true, last(out, 'queryDone').error);
  assert.strictEqual(s.table.get(0, 0), 6);
  await s.handle({ type: 'queryBack' });
  assert.strictEqual(last(out, 'meta').columns.length, 5);
  assert.ok(!last(out, 'meta').info.query);
  assert.strictEqual(s.showingResult, false);
});

test('session: query errors and a second query while one runs', async () => {
  const { s, out, open } = sessionFor(ordersPath);
  await open();
  await s.handle({ type: 'query', sql: 'SELECT nope FROM this' });
  assert.match(last(out, 'queryDone').error, /No column named "nope"/);
  assert.strictEqual(s.showingResult, false);
  const p = s.handle({ type: 'query', sql: 'SELECT * FROM this' });
  await s.handle({ type: 'query', sql: 'SELECT 1' });
  assert.match(out.filter(m => m.type === 'queryDone')[1].error, /already running/);
  await p;
});

test('session: a truncated CSV is queried whole (query-only mode), or only its loaded rows when not allowed', async () => {
  const lines = ['i,g'];
  for (let i = 0; i < 5000; i++) lines.push(`${i},${i % 2}`);
  const p = write('trunc.csv', lines.join('\n') + '\n');
  const { s, out } = sessionFor(p);
  await s.handle({ type: 'open', source: { path: p }, format: 'csv', options: { maxRows: 1000 } });
  assert.strictEqual(last(out, 'meta').info.truncated, true);
  await s.handle({ type: 'query', sql: 'SELECT COUNT(*) AS n FROM this', allowStream: true });
  assert.strictEqual(s.table.get(0, 0), 5000);
  assert.ok(last(out, 'queryDone').notes.some(n => /whole file/.test(n)));
  await s.handle({ type: 'query', sql: 'SELECT COUNT(*) AS n FROM this', allowStream: false });
  assert.strictEqual(s.table.get(0, 0), 1000);
  assert.ok(last(out, 'queryDone').notes.some(n => /Zovo Pro/.test(n)));
});

test('session: other sheets of the workbook by name; files only when the host allowed them', async () => {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['order_id', 'customer_id'], [1, 10], [2, 11], [3, 10]]), 'Orders');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'name'], [10, 'Ana'], [11, 'Ben']]), 'Customer List');
  const book = path.join(tmp, 'book.xlsx');
  XLSX.writeFile(wb, book);
  const { s, out } = sessionFor(book, 'excel');
  await s.handle({ type: 'open', source: { path: book }, format: 'excel', options: {} });
  await s.handle({ type: 'query', sql: 'SELECT c.name, COUNT(*) n FROM this o JOIN "Customer List" c ON o.customer_id = c.id GROUP BY c.name ORDER BY n DESC' });
  const d = last(out, 'queryDone');
  assert.strictEqual(d.ok, true, d.error);
  assert.deepStrictEqual([s.table.get(0, 0), s.table.get(0, 1)], ['Ana', 2]);
  await s.handle({ type: 'query', sql: "SELECT * FROM 'customers.csv'", files: { 'customers.csv': { path: customersPath, format: 'csv' } }, allowFiles: false });
  assert.match(last(out, 'queryDone').error, /Zovo Pro feature/);
  await s.handle({ type: 'query', sql: "SELECT COUNT(*) FROM 'customers.csv'", files: { 'customers.csv': { path: customersPath, format: 'csv' } }, allowFiles: true });
  assert.strictEqual(last(out, 'queryDone').ok, true);
  await s.handle({ type: 'query', sql: "SELECT * FROM 'other.csv'" });
  assert.match(last(out, 'queryDone').error, /not checked by the editor/);
  await s.handle({ type: 'query', sql: 'SELECT * FROM nosuch' });
  assert.match(last(out, 'queryDone').error, /Sheets: "Orders", "Customer List"/);
});

test('session without an engine (the extension host copy) answers queries with a message', async () => {
  const out = [];
  const s = createSession({ post: m => out.push(m), loader: (src, fmt, o, onPreview) => loadFile(src, fmt, o, onPreview) });
  await s.handle({ type: 'open', source: { path: ordersPath }, format: 'csv', options: {} });
  await s.handle({ type: 'query', sql: 'SELECT 1' });
  assert.match(last(out, 'queryDone').error, /not available/);
});

test('the extension host bundle does not carry the readers or the query engine', () => {
  const dist = path.join(__dirname, '..', 'dist', 'extension.js');
  if (!fs.existsSync(dist)) return;
  const size = fs.statSync(dist).size;
  assert.ok(size < 300 * 1024, `dist/extension.js is ${size} bytes`);
  assert.ok(!fs.readFileSync(dist, 'utf8').includes('fetch with range failed'), 'hyparquet is not in the host bundle');
});

test('webview messages: query, queryCancel, queryBack and parquet export validate', () => {
  assert.deepStrictEqual(validateWebviewMessage({ type: 'query', sql: 'SELECT 1', files: { x: 1 } }), { type: 'query', sql: 'SELECT 1' });
  assert.strictEqual(validateWebviewMessage({ type: 'query', sql: '  ' }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'query', sql: 5 }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'query', sql: 'x'.repeat(30000) }).sql.length, 20000);
  assert.deepStrictEqual(validateWebviewMessage({ type: 'queryCancel' }), { type: 'queryCancel' });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'queryBack', x: 1 }), { type: 'queryBack' });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export', format: 'parquet' }), { type: 'export', format: 'parquet' });
});

// ---------- host checks ----------
function fakeVscode({ trusted = true, folders = [tmp] } = {}) {
  return { workspace: { isTrusted: trusted, workspaceFolders: folders.map(f => ({ uri: { scheme: 'file', fsPath: f } })) } };
}
const fileUri = p => ({ scheme: 'file', fsPath: p, path: p });

test('host: query files must be in the workspace, exist, and the workspace must be trusted', async () => {
  const uri = fileUri(ordersPath);
  const ok = await resolveQueryFiles(fakeVscode(), uri, "SELECT * FROM this JOIN 'customers.csv' c ON 1=1 JOIN 'book.xlsx#Orders' b ON 1=1");
  assert.deepStrictEqual(ok['customers.csv'], { path: customersPath, format: 'csv' });
  assert.strictEqual(ok['book.xlsx#Orders'].sheet, 'Orders');
  const untrusted = await resolveQueryFiles(fakeVscode({ trusted: false }), uri, "SELECT * FROM 'customers.csv'");
  assert.match(untrusted['customers.csv'].error, /trusted workspace/);
  const outside = await resolveQueryFiles(fakeVscode(), uri, "SELECT * FROM '../../../../etc/hosts'");
  assert.match(outside['../../../../etc/hosts'].error, /outside the workspace|not found|not a CSV/);
  const abs = await resolveQueryFiles(fakeVscode(), uri, `SELECT * FROM '${os.homedir()}/.ssh/id_rsa'`);
  assert.ok(Object.values(abs)[0].error);
  const missing = await resolveQueryFiles(fakeVscode(), uri, "SELECT * FROM 'nope.csv'");
  assert.match(missing['nope.csv'].error, /File not found/);
  await assert.rejects(resolveQueryFiles(fakeVscode(), uri, 'SELEC x'), /Expected SELECT/);
  assert.deepStrictEqual(await resolveQueryFiles(fakeVscode(), uri, 'SELECT * FROM this'), {});
});

test('host: history per file, newest first, no duplicates, capped', () => {
  const store = new Map();
  const ctx = { workspaceState: { get: k => store.get(k), update: (k, v) => store.set(k, v) } };
  pushHistory(ctx, 'f1', 'SELECT 1');
  pushHistory(ctx, 'f1', 'SELECT 2');
  pushHistory(ctx, 'f1', 'SELECT 1');
  pushHistory(ctx, 'f2', 'SELECT 3');
  assert.deepStrictEqual(historyFor(ctx, 'f1'), ['SELECT 1', 'SELECT 2']);
  assert.deepStrictEqual(historyFor(ctx, 'f2'), ['SELECT 3']);
  for (let i = 0; i < 40; i++) pushHistory(ctx, 'f1', `SELECT ${i + 10}`);
  assert.strictEqual(historyFor(ctx, 'f1').length, 25);
});
