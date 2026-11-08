'use strict';
// Pro messages in the protocol: validation, and the worker session refusing Pro work without a license.
const test = require('node:test');
const assert = require('node:assert');
const { validateWebviewMessage: v, createSession } = require('../src/core/protocol');
const { tableFromStringColumns } = require('../src/core/table');

function table() {
  return tableFromStringColumns(['id', 'city', 'fare'], [['1', '2', '3', '4'], ['Paris', 'Lyon', 'Paris', ''], ['10', '20', '30', '40']], 4);
}

async function open(pro, extra = {}) {
  const out = [];
  const session = createSession({ post: m => out.push(m), loader: async () => ({ table: table(), info: { format: 'csv' } }), ...extra });
  await session.handle({ type: 'open', source: { path: 'x' }, format: 'csv', options: {}, ...(pro === undefined ? {} : { pro }) });
  out.length = 0;
  return { session, out };
}

test('Pro webview messages are validated', () => {
  assert.deepStrictEqual(v({ type: 'stats', col: 99 }), { type: 'stats' });
  assert.deepStrictEqual(v({ type: 'openProPage', url: 'https://evil.example' }), { type: 'openProPage' });
  assert.deepStrictEqual(v({ type: 'export', format: 'jsonl', path: '/etc/passwd' }), { type: 'export', format: 'jsonl' });
  assert.deepStrictEqual(v({ type: 'export', format: 'exe' }), { type: 'export' });
  assert.deepStrictEqual(v({ type: 'filter', global: '', columns: {}, query: "a = 'b'" }), { type: 'filter', global: '', columns: {}, query: "a = 'b'" });
  assert.deepStrictEqual(v({ type: 'filter', global: '', columns: {}, query: '   ' }), { type: 'filter', global: '', columns: {} });
  assert.strictEqual(v({ type: 'filter', query: 'q'.repeat(5000) }).query.length, 2000);
  assert.deepStrictEqual(v({ type: 'filter', query: 7 }), { type: 'filter', global: '', columns: {} });
});

test('0.4: without a license the SQL filter, stats and export all run (nothing is locked)', async () => {
  for (const pro of [undefined, false]) {
    const { session, out } = await open(pro);
    session.handle({ type: 'filter', global: '', columns: { 2: '>15' }, query: "city = 'Paris'" });
    assert.strictEqual(out[0].type, 'view');
    assert.ok(!out.some(m => m.code === 'PRO'));
    assert.strictEqual(session.table.filters.query, "city = 'Paris'");
    session.handle({ type: 'stats' });
    assert.strictEqual(out[1].type, 'stats');
    await session.handle({ type: 'export', format: 'csv' });
    assert.strictEqual(out[2].type, 'exportResult');
    assert.strictEqual(out[2].ok, true);
    assert.ok(!out.some(m => m.code === 'PRO'));
  }
});

test('with a license: query, stats and export run, and the query survives a resync', async () => {
  const written = [];
  const { session, out } = await open(true, { writeFile: async (p, chunks) => { const s = [...chunks].join(''); written.push([p, s]); return Buffer.byteLength(s); } });
  session.handle({ type: 'filter', global: '', columns: {}, query: "city = 'Paris' AND fare > 15" });
  assert.strictEqual(out[0].type, 'view');
  assert.strictEqual(out[0].viewCount, 1);
  session.handle({ type: 'resync' });
  assert.deepStrictEqual(out[1].filters, { global: '', columns: {}, query: "city = 'Paris' AND fare > 15" });
  session.handle({ type: 'stats' });
  assert.strictEqual(out[2].type, 'stats');
  assert.strictEqual(out[2].rows, 1);
  assert.strictEqual(out[2].version, out[0].version);
  assert.deepStrictEqual(out[2].columns.map(c => c.name), ['id', 'city', 'fare']);
  await session.handle({ type: 'export', format: 'csv' });
  assert.strictEqual(out[3].type, 'exportResult');
  assert.strictEqual(out[3].ok, true);
  assert.strictEqual(out[3].text, 'id,city,fare\r\n3,Paris,30\r\n');
  await session.handle({ type: 'export', format: 'json', path: '/x/out.json' });
  assert.deepStrictEqual([out[4].ok, out[4].rows, out[4].path, out[4].text], [true, 1, '/x/out.json', undefined]);
  assert.deepStrictEqual(JSON.parse(written[0][1]), [{ id: 3, city: 'Paris', fare: 30 }]);
  await session.handle({ type: 'export', format: 'xml' });
  assert.strictEqual(out[5].ok, false);
});

test('a bad query is reported, and the other filters still apply without it', async () => {
  const { session, out } = await open(true);
  session.handle({ type: 'filter', global: '', columns: {}, query: "city = 'Paris'" });
  assert.strictEqual(out[0].viewCount, 2);
  session.handle({ type: 'filter', global: '', columns: { 2: '>25' }, query: 'citty = 1' });
  assert.strictEqual(out[1].type, 'view');
  assert.strictEqual(out[1].viewCount, 2, 'only fare > 25 applies');
  assert.strictEqual(out[2].code, 'QUERY');
  assert.match(out[2].message, /No column named "citty"/);
  assert.strictEqual(session.table.filters.query, undefined);
});

test('0.4: a license change during a session keeps the active query (the SQL filter is free)', async () => {
  const { session, out } = await open(true);
  session.handle({ type: 'filter', global: '', columns: {}, query: 'fare >= 30' });
  assert.strictEqual(out[0].viewCount, 2);
  session.handle({ type: 'entitlement', pro: false });
  assert.strictEqual(session.pro, true);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(session.table.filters.query, 'fare >= 30');
});
