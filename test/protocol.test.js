'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateWebviewMessage: v, createSession, MAX_PAGE } = require('../src/core/protocol');
const { Table } = require('../src/core/table');

test('webview messages are validated and clamped', () => {
  assert.strictEqual(v(null), null);
  assert.strictEqual(v('ready'), null);
  assert.strictEqual(v({ type: 'evil' }), null);
  assert.deepStrictEqual(v({ type: 'ready', extra: 1 }), { type: 'ready' });
  assert.deepStrictEqual(v({ type: 'getRows', reqId: 3, start: -5, count: 1e9 }), { type: 'getRows', reqId: 3, start: 0, count: MAX_PAGE });
  assert.deepStrictEqual(v({ type: 'getRows', reqId: 'x', start: 'y', count: null }), { type: 'getRows', reqId: 0, start: 0, count: 0 });
  assert.deepStrictEqual(v({ type: 'sort', col: 2, dir: 'desc' }), { type: 'sort', col: 2, dir: 'desc' });
  assert.deepStrictEqual(v({ type: 'sort', col: null }), { type: 'sort', col: null, dir: null });
  assert.strictEqual(v({ type: 'sort', col: 1, dir: 'sideways' }), null);
  assert.strictEqual(v({ type: 'sort', col: -1, dir: 'asc' }), null);
  assert.deepStrictEqual(v({ type: 'filter', global: 5, columns: { 0: 'x', a: 'y', 1: 7, 2: '  ', 3: 'z'.repeat(900) } }),
    { type: 'filter', global: '', columns: { 0: 'x', 3: 'z'.repeat(500) } });
  assert.strictEqual(v({ type: 'copy', format: 'xml', sel: {} }), null);
  assert.deepStrictEqual(v({ type: 'copy', format: 'json', sel: { r0: 4, r1: 1, c0: 0, c1: 2, header: false } }),
    { type: 'copy', format: 'json', sel: { r0: 4, r1: 1, c0: 0, c1: 2, header: false } });
  assert.deepStrictEqual(v({ type: 'sheet', name: 'S1' }), { type: 'sheet', name: 'S1' });
  assert.strictEqual(v({ type: 'sheet', name: {} }), null);
});

function fakeTable(n = 5) {
  return new Table([{ name: 'n', type: 'int' }, { name: 's', type: 'string' }],
    [{ values: Array.from({ length: n }, (_, i) => n - i) }, { values: Array.from({ length: n }, (_, i) => `r${i}`) }], n);
}

test('session: open sends preview then final meta, then serves rows, sort, filter, copy', async () => {
  const out = [];
  let release;
  const gate = new Promise(r => { release = r; });
  let t = 0;
  const session = createSession({
    post: m => out.push(m),
    now: () => (t += 10),
    loader: async (_src, _fmt, _opts, onPreview) => {
      onPreview(fakeTable(2), { format: 'csv', loading: true });
      await gate;
      return { table: fakeTable(5), info: { format: 'csv', totalRows: 5 } };
    },
  });
  const opening = session.handle({ type: 'open', source: { path: 'x' }, format: 'csv', options: {} });
  assert.strictEqual(out[0].type, 'meta');
  assert.strictEqual(out[0].loading, true);
  assert.strictEqual(out[0].rowCount, 2);
  assert.ok(out[0].firstRowsMs >= 0);
  session.handle({ type: 'sort', col: 0, dir: 'asc' });
  assert.strictEqual(out[1].code, 'BUSY');
  assert.strictEqual(out[1].transient, true);
  release();
  await opening;
  const meta = out[2];
  assert.strictEqual(meta.type, 'meta');
  assert.strictEqual(meta.loading, false);
  assert.strictEqual(meta.rowCount, 5);
  assert.deepStrictEqual(meta.columns, [{ name: 'n', type: 'int', detail: '' }, { name: 's', type: 'string', detail: '' }]);
  session.handle({ type: 'getRows', reqId: 9, start: 3, count: 10 });
  assert.deepStrictEqual(out[3], { type: 'rows', reqId: 9, version: meta.version, start: 3, rows: [{ id: 3, cells: ['2', 'r3'] }, { id: 4, cells: ['1', 'r4'] }] });
  session.handle({ type: 'sort', col: 0, dir: 'asc' });
  assert.strictEqual(out[4].type, 'view');
  assert.strictEqual(out[4].version, meta.version + 1);
  session.handle({ type: 'getRows', reqId: 10, start: 0, count: 1 });
  assert.deepStrictEqual(out[5].rows[0].cells, ['1', 'r4']);
  session.handle({ type: 'filter', global: '', columns: { 0: '<3' } });
  assert.strictEqual(out[6].viewCount, 2);
  session.handle({ type: 'copy', format: 'csv', sel: { r0: 0, r1: 1, c0: 0, c1: 1 } });
  assert.deepStrictEqual(out[7], { type: 'copyResult', format: 'csv', text: 'n,s\r\n1,r4\r\n2,r3', rows: 2, truncated: false });
  session.handle({ type: 'sort', col: 99, dir: 'asc' });
  assert.match(out[8].message, /No such column/);
  session.handle({ type: 'nope' });
  assert.strictEqual(out[9].type, 'error');
});

test('session: loader errors become an error message', async () => {
  const out = [];
  const session = createSession({ post: m => out.push(m), loader: async () => { const e = new Error('too big'); e.code = 'TOO_LARGE'; throw e; } });
  await session.handle({ type: 'open', source: {}, format: 'excel', options: {} });
  assert.deepStrictEqual(out, [{ type: 'error', message: 'too big', code: 'TOO_LARGE' }]);
});

test('session: sheet switch uses the loader-provided sheet reader', async () => {
  const out = [];
  const session = createSession({
    post: m => out.push(m),
    loader: async () => ({ table: fakeTable(1), info: { sheets: ['A', 'B'], activeSheet: 'A' }, loadSheet: name => ({ table: fakeTable(3), info: { sheets: ['A', 'B'], activeSheet: name } }) }),
  });
  await session.handle({ type: 'open', source: {}, format: 'excel', options: {} });
  session.handle({ type: 'sheet', name: 'B' });
  const last = out[out.length - 1];
  assert.strictEqual(last.type, 'meta');
  assert.strictEqual(last.info.activeSheet, 'B');
  assert.strictEqual(last.rowCount, 3);
});

// R7 T1: VS Code rebuilds the webview when a hidden tab is shown again. The host then sends 'resync'
// and the worker must answer with the full table state, including sort and filters.
test('session: resync resends meta with columns, sort and filters', async () => {
  const out = [];
  let t = 0;
  const session = createSession({
    post: m => out.push(m), now: () => (t += 10),
    loader: async () => ({ table: fakeTable(5), info: { format: 'csv', totalRows: 5 } }),
  });
  await session.handle({ type: 'open', source: {}, format: 'csv', options: {} });
  const loaded = out[out.length - 1];
  session.handle({ type: 'sort', col: 0, dir: 'desc' });
  session.handle({ type: 'filter', global: 'r', columns: { 0: '<3' } });
  out.length = 0;
  session.handle({ type: 'resync' });
  assert.strictEqual(out.length, 1);
  const m = out[0];
  assert.strictEqual(m.type, 'meta');
  assert.strictEqual(m.resync, true);
  assert.strictEqual(m.loading, false);
  assert.strictEqual(m.columns.length, 2);
  assert.strictEqual(m.rowCount, 5);
  assert.strictEqual(m.viewCount, 2);
  assert.deepStrictEqual(m.sort, { col: 0, dir: 'desc' });
  assert.deepStrictEqual(m.filters, { global: 'r', columns: { 0: '<3' } });
  assert.strictEqual(m.loadMs, loaded.loadMs);
  session.handle({ type: 'getRows', reqId: 1, start: 0, count: 10 });
  assert.strictEqual(out[1].version, m.version);
  assert.deepStrictEqual(out[1].rows.map(r => r.cells[0]), ['2', '1']);
});

test('session: resync while loading sends the preview, and after a failed load resends the error', async () => {
  const out = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const session = createSession({
    post: m => out.push(m),
    loader: async (_s, _f, _o, onPreview) => { onPreview(fakeTable(2), { loading: true }); await gate; throw new Error('bad file'); },
  });
  const opening = session.handle({ type: 'open', source: {}, format: 'csv', options: {} });
  out.length = 0;
  session.handle({ type: 'resync' });
  assert.strictEqual(out[0].type, 'meta');
  assert.strictEqual(out[0].loading, true);
  assert.strictEqual(out[0].rowCount, 2);
  assert.strictEqual(out[0].loadMs, undefined);
  release();
  await opening;
  out.length = 0;
  session.handle({ type: 'resync' });
  assert.deepStrictEqual(out.map(m => m.type), ['meta', 'error']);
  assert.strictEqual(out[1].message, 'bad file');
});

// R7 T5: a new sheet starts unfiltered, and the meta says so, so the webview clears its filter boxes.
test('session: switching sheet sends empty filters, and a failing sheet is reported', async () => {
  const out = [];
  const session = createSession({
    post: m => out.push(m),
    loader: async () => ({
      table: fakeTable(5), info: { sheets: ['A', 'B', 'C'], activeSheet: 'A' },
      loadSheet: name => { if (name === 'C') throw new Error('sheet C is broken'); return { table: fakeTable(5), info: { sheets: ['A', 'B', 'C'], activeSheet: name } }; },
    }),
  });
  await session.handle({ type: 'open', source: {}, format: 'excel', options: {} });
  session.handle({ type: 'filter', global: 'r1', columns: { 1: 'r' } });
  assert.strictEqual(out[out.length - 1].viewCount, 1);
  session.handle({ type: 'sheet', name: 'B' });
  const meta = out[out.length - 1];
  assert.strictEqual(meta.type, 'meta');
  assert.deepStrictEqual(meta.filters, { global: '', columns: {} });
  assert.strictEqual(meta.viewCount, 5);
  session.handle({ type: 'sheet', name: 'C' });
  assert.deepStrictEqual(out[out.length - 1], { type: 'error', message: 'sheet C is broken', code: undefined });
});
