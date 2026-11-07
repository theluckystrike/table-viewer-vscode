'use strict';
// 0.2.0: delimiter and header choice for CSV/TSV, and the cell panel (full value of one cell).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { loadCsv } = require('../src/core/readers');
const { validateWebviewMessage: v, createSession } = require('../src/core/protocol');
const { Table } = require('../src/core/table');
const M = require('../src/webview/math');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-opts-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
function file(name, text) { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; }

test('a picked delimiter wins over detection, and auto still detects', async () => {
  // One comma per line inside the values ties with the semicolon, and auto picks the comma.
  const p = file('mixed.csv', 'name;city, country\nAnn;Paris, France\nBo;Rome, Italy\n');
  const auto = await loadCsv({ path: p }, {}, null, 'csv');
  assert.strictEqual(auto.info.delimiter, ',');
  assert.strictEqual(auto.info.delimiterAuto, true);
  const semi = await loadCsv({ path: p }, { delimiter: ';' }, null, 'csv');
  assert.strictEqual(semi.info.delimiter, ';');
  assert.strictEqual(semi.info.delimiterAuto, false);
  assert.deepStrictEqual(semi.table.columns.map(c => c.name), ['name', 'city, country']);
  assert.deepStrictEqual(semi.table.getRows(0, 2).map(r => r.cells), [['Ann', 'Paris, France'], ['Bo', 'Rome, Italy']]);
  // Unknown values fall back to detection; TSV keeps the tab unless the user picks another one.
  const bad = await loadCsv({ path: p }, { delimiter: 'x' }, null, 'csv');
  assert.strictEqual(bad.info.delimiterAuto, true);
  const t = file('colon.tsv', 'a:b\n1:2\n');
  assert.strictEqual((await loadCsv({ path: t }, {}, null, 'tsv')).table.columns.length, 1);
  const colon = await loadCsv({ path: t }, { delimiter: ':' }, null, 'tsv');
  assert.deepStrictEqual(colon.table.getRows(0, 1)[0].cells, ['1', '2']);
});

test('without a header row the first line is data and columns are numbered', async () => {
  const p = file('nohead.csv', '1,2.5,x\n2,3.5,y\n3,4.5,z,extra\n');
  const r = await loadCsv({ path: p }, { header: false }, null, 'csv');
  assert.strictEqual(r.info.header, false);
  assert.strictEqual(r.table.rowCount, 3);
  assert.deepStrictEqual(r.table.columns.map(c => c.name), ['column_1', 'column_2', 'column_3', 'column_4']);
  assert.deepStrictEqual(r.table.columns.slice(0, 2).map(c => c.type), ['int', 'float']);
  assert.deepStrictEqual(r.table.getRows(0, 1)[0].cells, ['1', '2.5', 'x', '']);
  const withHead = await loadCsv({ path: p }, {}, null, 'csv');
  assert.strictEqual(withHead.info.header, true);
  assert.strictEqual(withHead.table.rowCount, 2);
});

test('csvOptions, getCell and copyText messages are validated', () => {
  assert.deepStrictEqual(v({ type: 'csvOptions', delimiter: ';', header: false }), { type: 'csvOptions', delimiter: ';', header: false });
  assert.deepStrictEqual(v({ type: 'csvOptions', delimiter: 'auto', header: true, x: 1 }), { type: 'csvOptions', delimiter: 'auto', header: true });
  assert.strictEqual(v({ type: 'csvOptions', delimiter: 'xx', header: true }), null);
  assert.strictEqual(v({ type: 'csvOptions', delimiter: ',', header: 'yes' }), null);
  assert.deepStrictEqual(v({ type: 'getCell', reqId: 4, row: -3, col: 'a' }), { type: 'getCell', reqId: 4, row: 0, col: 0 });
  assert.deepStrictEqual(v({ type: 'copyText', text: 'abc' }), { type: 'copyText', text: 'abc' });
  assert.strictEqual(v({ type: 'copyText', text: 5 }), null);
  assert.strictEqual(v({ type: 'copyText', text: 'z'.repeat(1000005) }).text.length, 1000000);
});

test('getCell returns the full value, past the 2,000 character grid cut', () => {
  const long = 'L'.repeat(5000);
  const t = new Table([{ name: 's', type: 'string' }], [{ values: ['a', long, null] }], 3);
  assert.ok(t.getRows(1, 1)[0].cells[0].length < 2100);
  assert.deepStrictEqual(t.getCell(1, 0), { id: 1, value: long, length: 5000, truncated: false });
  assert.deepStrictEqual(t.getCell(2, 0), { id: 2, value: null, length: 0, truncated: false });
  assert.deepStrictEqual(t.getCell(1, 0, 10), { id: 1, value: 'L'.repeat(10), length: 5000, truncated: true });
  assert.strictEqual(t.getCell(3, 0), null);
  assert.strictEqual(t.getCell(0, 1), null);
  t.setSort(0, 'asc'); // 'L...' sorts before 'a', so view row 0 is the long value
  assert.strictEqual(t.getCell(0, 0).id, 1);
});

test('session: csvOptions reads the file again with the new delimiter; getCell follows the view', async () => {
  const p = file('s.csv', 'a;b, c\n1;x, y\n2;z, w\n');
  const out = [];
  const { loadFile } = require('../src/core/readers');
  const s = createSession({ post: m => out.push(m), loader: (src, fmt, o, pre) => loadFile(src, fmt, o, pre) });
  await s.handle({ type: 'open', source: { path: p }, format: 'csv', options: { maxRows: 100 } });
  let meta = out.filter(m => m.type === 'meta').pop();
  assert.strictEqual(meta.info.delimiter, ',');
  await s.handle({ type: 'csvOptions', delimiter: ';', header: true });
  meta = out.filter(m => m.type === 'meta').pop();
  assert.strictEqual(meta.loading, false);
  assert.strictEqual(meta.info.delimiter, ';');
  assert.strictEqual(meta.info.delimiterAuto, false);
  assert.deepStrictEqual(meta.columns.map(c => c.name), ['a', 'b, c']);
  s.handle({ type: 'getCell', reqId: 9, row: 0, col: 1 });
  let cell = out.pop();
  assert.deepStrictEqual(cell, { type: 'cell', reqId: 9, version: meta.version, row: 0, col: 1, id: 0, value: 'x, y', length: 4, truncated: false });
  s.handle({ type: 'getCell', reqId: 10, row: 50, col: 0 });
  cell = out.pop();
  assert.strictEqual(cell.missing, true);
  // The limits from the first open are kept.
  await s.handle({ type: 'csvOptions', delimiter: 'auto', header: false });
  meta = out.filter(m => m.type === 'meta').pop();
  assert.strictEqual(meta.rowCount, 3);
  assert.strictEqual(meta.columns[0].name, 'column_1');
});

test('session: csvOptions is refused for Parquet and Excel', async () => {
  const out = [];
  const s = createSession({ post: m => out.push(m), loader: async () => ({ table: new Table([], [], 0), info: {} }) });
  await s.handle({ type: 'open', source: { path: 'x.parquet' }, format: 'parquet', options: {} });
  await s.handle({ type: 'csvOptions', delimiter: ';', header: true });
  const err = out.pop();
  assert.strictEqual(err.type, 'error');
  assert.strictEqual(err.transient, true);
});

test('webview helpers: delimiter picker, fit width, cell text and caption', () => {
  const auto = M.delimiterChoices({ delimiter: ';', delimiterAuto: true });
  assert.strictEqual(auto.selected, 'auto');
  assert.strictEqual(auto.choices[0].label, 'Auto (semicolon)');
  assert.deepStrictEqual(auto.choices.map(c => c.value), ['auto', ',', '\t', ';', '|', ':']);
  assert.strictEqual(M.delimiterChoices({ delimiter: '|', delimiterAuto: false }).selected, '|');
  assert.strictEqual(M.delimiterChoices(null).choices[0].label, 'Auto');
  assert.strictEqual(M.delimiterName('\t'), 'tab');

  // Fit goes past the 360 px auto-size cap, counts only the first line, and has a ceiling.
  assert.ok(M.fitWidth('x', 'string', ['y'.repeat(80)]) > 360);
  assert.strictEqual(M.fitWidth('x', 'string', ['y'.repeat(5000)]), 900);
  assert.strictEqual(M.fitWidth('x', 'string', ['ab\n' + 'y'.repeat(5000)]), M.fitWidth('x', 'string', []));
  assert.ok(M.fitWidth('a_long_column_name', 'timestamp', [null, '']) > 64);

  assert.deepStrictEqual(M.cellText('{"a":1,"b":[1,2]}', 'string'), { text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}', json: true });
  assert.deepStrictEqual(M.cellText('{"a":1}', 'string', false), { text: '{"a":1}', json: true });
  assert.deepStrictEqual(M.cellText('[not json]', 'string'), { text: '[not json]', json: false });
  assert.deepStrictEqual(M.cellText('42', 'json'), { text: '42', json: false });
  assert.deepStrictEqual(M.cellText('plain text', 'string'), { text: 'plain text', json: false });
  assert.deepStrictEqual(M.cellText(null, 'string'), { text: '', json: false });
  assert.strictEqual(M.cellCaption(1234, { name: 'note', type: 'string' }, 5000, false), 'Row 1,234 · note (string) · 5,000 characters');
  assert.strictEqual(M.cellCaption(1, { name: 'n', type: 'int' }, 1, true), 'Row 1 · n (int) · 1 character · cut at 1,000,000');
});

test('the new webview parts write file content only through textContent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(src, /cellValue\.textContent = /);
});

// Host: the choice is saved per file and used the next time the file opens.
test('the delimiter choice is remembered per file and applied on the next open', async t => {
  const root = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  let clipboard = '';
  const store = new Map();
  const editors = [];
  const vscodeMock = {
    Uri: {
      joinPath: (u, ...p) => ({ ...u, path: path.join(u.path, ...p), fsPath: path.join(u.fsPath || u.path, ...p) }),
      file: p => ({ scheme: 'file', path: p, fsPath: p, toString: () => 'file://' + p }),
    },
    window: { registerCustomEditorProvider: (id, provider) => { editors.push({ id, provider }); return { dispose() {} }; }, showWarningMessage: () => {}, showInformationMessage: () => {} },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }), fs: {}, registerTextDocumentContentProvider: () => ({ dispose() {} }) },
    env: { clipboard: { writeText: async x => { clipboard = x; } } },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : orig.call(this, req, ...rest); };
  t.after(() => { Module._load = orig; });
  const ext = require('../src/extension');
  const ctx = {
    subscriptions: [], extensionUri: vscodeMock.Uri.file(root), extensionPath: root,
    workspaceState: { get: k => store.get(k), update: async (k, val) => { store.set(k, val); } },
  };
  ext.activate(ctx);
  const provider = editors[0].provider;
  const p = file('remember.csv', 'name;city, country\nAnn;Paris, France\n');
  const open = async () => {
    const sent = [];
    const waiters = [];
    let onMsg, onDispose;
    const panel = {
      active: true, visible: true,
      webview: {
        cspSource: 'x', options: {}, html: '', asWebviewUri: u => ({ toString: () => u.path }),
        postMessage: m => { sent.push(m); waiters.slice().forEach(w => w()); return Promise.resolve(true); },
        onDidReceiveMessage: fn => { onMsg = fn; },
      },
      onDidChangeViewState: () => {}, onDidDispose: fn => { onDispose = fn; },
    };
    await provider.resolveCustomEditor(provider.openCustomDocument(vscodeMock.Uri.file(p)), panel);
    const until = (pred, from = 0) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout ' + JSON.stringify(sent.map(m => m.type)))), 15000);
      const check = () => { const m = sent.slice(from).find(pred); if (m) { clearTimeout(timer); resolve(m); } };
      waiters.push(check); check();
    });
    onMsg({ type: 'ready' });
    let closed = false;
    const close = () => { if (!closed) { closed = true; onDispose(); } };
    t.after(close);
    return { sent, until, send: m => onMsg(m), close };
  };
  const a = await open();
  const first = await a.until(m => m.type === 'meta' && !m.loading);
  assert.strictEqual(first.info.delimiter, ',');
  const from = a.sent.length;
  a.send({ type: 'csvOptions', delimiter: ';', header: true });
  const second = await a.until(m => m.type === 'meta' && !m.loading, from);
  assert.strictEqual(second.info.delimiter, ';');
  assert.deepStrictEqual(store.get('tableViewer.csvOptions'), { ['file://' + p]: { delimiter: ';', header: true } });
  a.send({ type: 'copyText', text: 'a,b' });
  await a.until(m => m.type === 'copiedText');
  assert.strictEqual(clipboard, 'a,b');
  a.close();

  const b = await open();
  const again = await b.until(m => m.type === 'meta' && !m.loading);
  assert.strictEqual(again.info.delimiter, ';');
  assert.strictEqual(again.info.delimiterAuto, false);
  // Back to auto with a header row forgets the file.
  b.send({ type: 'csvOptions', delimiter: 'auto', header: true });
  await b.until(m => m.type === 'meta' && !m.loading && m.info.delimiterAuto, again ? b.sent.indexOf(again) + 1 : 0);
  assert.deepStrictEqual(store.get('tableViewer.csvOptions'), {});
  b.close();
});

// VER7 red team (2026-11-08): a Windows-1252 CSV (Excel "CSV" on Windows) showed the replacement character for
// é, € and smart quotes. A first chunk that is not valid UTF-8 is now read as Windows-1252.
test('a Windows-1252 CSV shows é, € and smart quotes; UTF-8 and UTF-16 are unchanged', async () => {
  const { pickEncoding } = require('../src/core/readers');
  const cp = file('excel-western.csv', Buffer.from([...Buffer.from('name;note\r\nRen'), 0xe9, ...Buffer.from(';'), 0x93, ...Buffer.from('ok'), 0x94, ...Buffer.from(' 12 '), 0x80, 0x0d, 0x0a]));
  const t = await loadCsv({ path: cp }, {}, null, 'csv');
  assert.deepStrictEqual(t.table.getRows(0, 1).map(r => r.cells), [['René', '“ok” 12 €']]);
  assert.strictEqual(pickEncoding(Buffer.from('naïve,€\n', 'utf8')), 'utf-8');
  // A UTF-8 character cut at the end of the first chunk is still UTF-8.
  assert.strictEqual(pickEncoding(Buffer.from('ab€', 'utf8').subarray(0, 4)), 'utf-8');
  assert.strictEqual(pickEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'utf-16le');
  const u = await loadCsv({ path: file('utf8.csv', 'a,b\nZoë,東京\n') }, {}, null, 'csv');
  assert.deepStrictEqual(u.table.getRows(0, 1).map(r => r.cells), [['Zoë', '東京']]);
});
