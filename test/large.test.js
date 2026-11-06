'use strict';
// 1,000,000-row CSV and Parquet: load, sort, filter, page. Files live in ~/table-viewer-vscode-work and are deleted after.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { loadFile } = require('../src/core/readers');

const ROWS = 1000000;
const WORK = path.join(os.homedir(), 'table-viewer-vscode-work');
let dir;

test.before(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  dir = fs.mkdtempSync(path.join(WORK, 'large-'));
  // CSV, about 40 MB
  const fd = fs.openSync(path.join(dir, 'big.csv'), 'w');
  fs.writeSync(fd, 'id,city,amount,flag\n');
  const cities = ['Berlin', 'Paris', 'Lagos', 'Lima', 'Osaka', 'Austin'];
  let buf = '';
  for (let i = 0; i < ROWS; i++) {
    buf += `${i},${cities[i % 6]},${((i * 7919) % 100000) / 100},${i % 3 === 0}\n`;
    if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; }
  }
  fs.writeSync(fd, buf);
  fs.closeSync(fd);
  // Parquet, written with hyparquet-writer
  const { parquetWriteBuffer } = await import('hyparquet-writer');
  const id = new Int32Array(ROWS), amount = new Float64Array(ROWS);
  const city = new Array(ROWS);
  for (let i = 0; i < ROWS; i++) { id[i] = i; amount[i] = ((i * 7919) % 100000) / 100; city[i] = cities[i % 6]; }
  const ab = parquetWriteBuffer({ columnData: [{ name: 'id', data: id, type: 'INT32' }, { name: 'city', data: city, type: 'STRING' }, { name: 'amount', data: amount, type: 'DOUBLE' }], rowGroupSize: 100000 });
  fs.writeFileSync(path.join(dir, 'big.parquet'), Buffer.from(ab));
});

test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

for (const [file, fmt] of [['big.csv', 'csv'], ['big.parquet', 'parquet']]) {
  test(`${file}: 1M rows load, first rows early, sort and filter`, async () => {
    const t0 = Date.now();
    let firstMs = null;
    const { table } = await loadFile({ path: path.join(dir, file) }, fmt, {}, () => { if (firstMs === null) firstMs = Date.now() - t0; });
    const loadMs = Date.now() - t0;
    assert.strictEqual(table.rowCount, ROWS);
    const ci = table.columns.findIndex(c => c.name === 'amount');
    assert.strictEqual(table.columns[ci].type, 'float');
    let t = Date.now();
    table.setSort(ci, 'desc');
    const sortMs = Date.now() - t;
    assert.strictEqual(table.getRows(0, 1)[0].cells[ci], '999.99');
    t = Date.now();
    table.setFilters({ columns: { 1: '=lima' } });
    const filterMs = Date.now() - t;
    assert.strictEqual(table.viewCount, Math.floor(ROWS / 6) + (ROWS % 6 > 3 ? 1 : 0));
    t = Date.now();
    const page = table.getRows(table.viewCount - 200, 200);
    const pageMs = Date.now() - t;
    assert.strictEqual(page.length, 200);
    console.log(`# ${file}: first rows ${firstMs} ms, load ${loadMs} ms, sort ${sortMs} ms, filter ${filterMs} ms, page ${pageMs} ms, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
    assert.ok(firstMs !== null && firstMs < loadMs, 'preview arrives before the full load');
    assert.ok(pageMs < 50);
  });
}

test('bundled worker answers the protocol end to end', async t => {
  const workerPath = path.join(__dirname, '..', 'dist', 'worker.js');
  if (!fs.existsSync(workerPath)) return t.skip('run the build first');
  const w = new Worker(workerPath);
  t.after(() => w.terminate());
  const msgs = [];
  const waitFor = pred => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 20000);
    const on = m => { msgs.push(m); if (pred(m)) { clearTimeout(timer); w.off('message', on); resolve(m); } };
    w.on('message', on);
  });
  w.postMessage({ type: 'open', source: { path: path.join(__dirname, 'fixtures', 'sample.parquet') }, format: 'parquet', options: {} });
  const meta = await waitFor(m => m.type === 'meta' && !m.loading);
  assert.strictEqual(meta.rowCount, 150);
  assert.strictEqual(meta.info.schema.rowGroups, 3);
  w.postMessage({ type: 'sort', col: 2, dir: 'desc' });
  const view = await waitFor(m => m.type === 'view');
  assert.strictEqual(view.viewCount, 150);
  w.postMessage({ type: 'getRows', reqId: 1, start: 0, count: 2 });
  const rows = await waitFor(m => m.type === 'rows');
  assert.deepStrictEqual(rows.rows.map(r => r.cells[2]), ['187.5', '186.25']);
  w.postMessage({ type: 'copy', format: 'json', sel: { r0: 0, r1: 0, c0: 0, c1: 1 } });
  const copy = await waitFor(m => m.type === 'copyResult');
  assert.deepStrictEqual(JSON.parse(copy.text), [{ id: 150, name: 'item 150' }]);
  w.postMessage({ type: 'open', source: { path: path.join(__dirname, 'fixtures', 'sample.xlsx') }, format: 'excel', options: { maxExcelSizeMB: 0.001 } });
  const err = await waitFor(m => m.type === 'error');
  assert.match(err.message, /limit for Excel files/);
});
