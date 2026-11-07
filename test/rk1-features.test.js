'use strict';
// Auto-reload (protocol), Excel number formats and table compare (text, git).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const { validateWebviewMessage: v, createSession } = require('../src/core/protocol');
const { Table } = require('../src/core/table');
const { loadExcel } = require('../src/core/readers');
const { tableToText } = require('../src/core/totext');
const { readFromHead, diffPath, diffTitle, isTableFile, isLfsPointer, DiffStore, registerCompare } = require('../src/compare');

function formattedBook() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['name', 'share', 'price', 'when', 'plain', 'big', 'day'],
    ['a', 0.25, 1234.5, new Date(Date.UTC(2026, 9, 1)), 3.14159, 1234567, new Date(Date.UTC(2024, 0, 15))],
    ['b', 0.5, 99, new Date(Date.UTC(2026, 9, 2)), 2, 7, new Date(Date.UTC(2024, 1, 20))],
  ], { UTC: true });
  ws.B2.z = ws.B3.z = '0.0%';
  ws.C2.z = ws.C3.z = '"$"#,##0.00';
  ws.D2.z = ws.D3.z = 'dd/mm/yyyy';
  ws.F2.z = ws.F3.z = '#,##0';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['k', 'v'], ['x', 1.5]]), 'Plain');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('Excel formats: cells show the workbook text, values stay for sort, filter and copy', async () => {
  const { table, info, loadSheet } = await loadExcel({ bytes: formattedBook() }, {});
  const row = table.getRows(0, 1)[0].cells;
  assert.strictEqual(row[1], '25.0%');
  assert.strictEqual(row[2], '$1,234.50');
  assert.strictEqual(row[3], '01/10/2026');
  assert.strictEqual(row[4], '3.14159');
  assert.strictEqual(row[5], '1,234,567');
  assert.strictEqual(row[6], '2024-01-15', 'the default short date (locale dependent in Excel) stays ISO');
  assert.strictEqual(info.formattedCells, 7); // 2 shares, 2 prices, 2 dates, 1,234,567 (7 stays 7)
  // The cell panel gets the stored value too.
  const cell = table.getCell(0, 1);
  assert.strictEqual(cell.value, '25.0%');
  assert.strictEqual(cell.raw, '0.25');
  // Sort and number filters use the values.
  table.setSort(2, 'asc');
  assert.deepStrictEqual(table.getRows(0, 2).map(r => r.cells[0]), ['b', 'a']);
  table.setSort(null, null);
  table.setFilters({ global: '', columns: { 1: '>0.3' } });
  assert.strictEqual(table.viewCount, 1);
  // The search box also finds the text as shown.
  table.setFilters({ global: '$1,234', columns: {} });
  assert.strictEqual(table.viewCount, 1);
  // Copy keeps the values, so they paste into Excel as numbers.
  table.setFilters({ global: '', columns: {} });
  assert.strictEqual(table.copy({ r0: 0, r1: 0, c0: 1, c1: 2 }, 'csv').text, 'share,price\r\n0.25,1234.5');
  // Off: the stored values.
  table.formatted = false;
  assert.deepStrictEqual(table.getRows(0, 1)[0].cells.slice(1, 3), ['0.25', '1234.5']);
  assert.strictEqual(table.getCell(0, 1).raw, undefined);
  // A sheet with only General cells has no display text at all.
  const plain = loadSheet('Plain');
  assert.strictEqual(plain.info.formattedCells, 0);
  assert.ok(plain.table.data.every(d => !d.display));
});

test('Excel formats: the setting turns them off, and the existing sample keeps ISO dates', async () => {
  const { table } = await loadExcel({ bytes: formattedBook() }, { excelFormats: false });
  assert.strictEqual(table.formatted, false);
  assert.strictEqual(table.getRows(0, 1)[0].cells[1], '0.25');
  const sample = await loadExcel({ path: path.join(__dirname, 'fixtures', 'sample.xlsx') }, {});
  const types = sample.table.columns.map(c => c.type);
  const di = types.indexOf('date');
  if (di >= 0) assert.match(sample.table.getRows(0, 1)[0].cells[di], /^\d{4}-\d{2}-\d{2}$/);
});

test('protocol: reload, compare and formats messages are validated', () => {
  assert.deepStrictEqual(v({ type: 'reload', source: { path: '/etc/passwd' } }), { type: 'reload' });
  assert.deepStrictEqual(v({ type: 'compare', x: 1 }), { type: 'compare' });
  assert.deepStrictEqual(v({ type: 'formats', on: false }), { type: 'formats', on: false });
  assert.strictEqual(v({ type: 'formats', on: 'yes' }), null);
});

function tbl(names, rows) {
  return new Table(names.map(n => ({ name: n, type: n === 'n' ? 'int' : 'string' })),
    names.map((_, c) => ({ values: rows.map(r => r[c]) })), rows.length);
}

test('session reload: no preview, sort and filters map by column name, failures keep the last table', async () => {
  const out = [];
  let next = () => ({ table: tbl(['n', 's'], [[1, 'a'], [2, 'b'], [3, 'c']]), info: { format: 'csv' } });
  let previews = 0;
  const session = createSession({
    post: m => out.push(m),
    loader: async (_s, _f, _o, onPreview) => { if (onPreview) previews++; return next(); },
  });
  await session.handle({ type: 'open', source: { path: 'x' }, format: 'csv', options: {} });
  const opened = previews;
  session.handle({ type: 'sort', col: 0, dir: 'desc' });
  session.handle({ type: 'filter', global: '', columns: { 1: '!a' } });
  next = () => ({ table: tbl(['s', 'n', 'extra'], [['a', 1, 'x'], ['b', 2, 'y'], ['c', 3, 'z'], ['d', 4, 'w']]), info: { format: 'csv' } });
  await session.handle({ type: 'reload', source: { path: 'x' } });
  assert.strictEqual(previews, opened, 'a reload sends no preview, so the old rows stay on screen');
  const meta = out.filter(m => m.type === 'meta').pop();
  assert.deepStrictEqual(meta.reloaded, { before: 3, after: 4, manual: false });
  assert.deepStrictEqual(meta.sort, { col: 1, dir: 'desc' });
  assert.deepStrictEqual(meta.filters.columns, { 0: '!a' });
  assert.deepStrictEqual(session.table.getRows(0, 9).map(r => r.cells[1]), ['4', '3', '2']);

  // A half-written file: the old table stays, a transient notice explains.
  next = () => { throw new Error('Unexpected end of data'); };
  const n = out.length;
  await session.handle({ type: 'reload' });
  const err = out.slice(n).find(m => m.type === 'error');
  assert.strictEqual(err.transient, true);
  assert.strictEqual(err.code, 'RELOAD');
  assert.strictEqual(session.table.rowCount, 4);

  // A dropped column drops its filter instead of failing.
  next = () => ({ table: tbl(['n'], [[1], [2]]), info: { format: 'csv' } });
  await session.handle({ type: 'reload' });
  const m2 = out.filter(m => m.type === 'meta').pop();
  assert.deepStrictEqual(m2.filters.columns, {});
  assert.deepStrictEqual(m2.sort, { col: 0, dir: 'desc' });
});

test('session reload while a load runs waits and then runs once', async () => {
  const out = [];
  let release;
  let calls = 0;
  const session = createSession({
    post: m => out.push(m),
    loader: async () => { calls++; if (calls === 1) await new Promise(r => { release = r; }); return { table: tbl(['n'], [[calls]]), info: {} }; },
  });
  const opening = session.handle({ type: 'open', source: { path: 'x' }, format: 'csv', options: {} });
  session.handle({ type: 'reload' });
  session.handle({ type: 'reload' });
  release();
  await opening;
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls, 2, 'two reloads during a load collapse into one');
  assert.ok(out.some(m => m.type === 'meta' && m.reloaded));
});

test('session formats: the switch changes what the grid shows and is kept for other sheets', async () => {
  const out = [];
  const session = createSession({ post: m => out.push(m), loader: (s, f, o) => loadExcel(s, o) });
  await session.handle({ type: 'open', source: { bytes: formattedBook() }, format: 'excel', options: {} });
  assert.strictEqual(out.filter(m => m.type === 'meta').pop().formatted, true);
  session.handle({ type: 'formats', on: false });
  const view = out.filter(m => m.type === 'view').pop();
  assert.strictEqual(view.formatted, false);
  session.handle({ type: 'getRows', reqId: 1, start: 0, count: 1 });
  assert.strictEqual(out.filter(m => m.type === 'rows').pop().rows[0].cells[1], '0.25');
  session.handle({ type: 'sheet', name: 'Plain' });
  session.handle({ type: 'sheet', name: 'Sales' });
  session.handle({ type: 'getRows', reqId: 2, start: 0, count: 1 });
  assert.strictEqual(out.filter(m => m.type === 'rows').pop().rows[0].cells[1], '0.25');
});

test('tableToText: CSV as CSV, Excel one section per sheet, a row cap with a note', async () => {
  const csv = await tableToText({ path: path.join(__dirname, 'fixtures', 'sample.csv') }, 'csv', {}, 1000);
  assert.ok(csv.text.startsWith('id,name'));
  assert.ok(csv.text.includes('"Bob, Jr."'));
  assert.strictEqual(csv.cut, false);
  const xl = await tableToText({ bytes: formattedBook() }, 'excel', {}, 1000);
  assert.strictEqual(xl.sheets, 2);
  assert.match(xl.text, /=== Sheet: Sales ===\nname,share,price/);
  assert.match(xl.text, /=== Sheet: Plain ===\nk,v\nx,1.5/);
  assert.ok(xl.text.includes('a,0.25,1234.5'), 'compare uses the values, not the display text');
  const cut = await tableToText({ path: path.join(__dirname, 'fixtures', 'sample.csv') }, 'csv', {}, 2);
  assert.strictEqual(cut.cut, true);
  assert.strictEqual(cut.rows, 2);
  assert.match(cut.text, /cut at 2 rows/);
  const pq = await tableToText({ path: path.join(__dirname, 'fixtures', 'sample.parquet') }, 'parquet', {}, 5);
  assert.ok(pq.rows > 0);
});

test('compare helpers: names, titles, LFS pointers, bounded store', () => {
  assert.strictEqual(diffPath('HEAD', 'a/b:c.xlsx'), '/HEAD/a_b_c.xlsx.csv');
  assert.strictEqual(diffTitle('x.csv', 'HEAD', 'x.csv', 'Working Tree'), 'x.csv (HEAD ↔ Working Tree, as CSV)');
  assert.strictEqual(diffTitle('a.csv', 'A', 'b.parquet', 'B'), 'a.csv ↔ b.parquet (as CSV)');
  assert.ok(isTableFile('/x/y.PARQUET') && isTableFile('a.xlsx') && !isTableFile('a.json'));
  assert.strictEqual(isLfsPointer(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\n')), true);
  assert.strictEqual(isLfsPointer(Buffer.from('id,name\n')), false);
  const st = new DiffStore(2);
  const k1 = st.put('a'); st.put('b'); st.put('c');
  assert.strictEqual(st.get(k1), null);
});

function hasGit() { try { execFileSync('git', ['--version']); return true; } catch { return false; } }

test('Compare with Git HEAD: committed CSV vs the changed file in the diff editor', async t => {
  if (!hasGit()) return t.skip('git not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
  g('init', '-q');
  const file = path.join(dir, 'prices.csv');
  fs.writeFileSync(file, 'item,price\napple,1\npear,2\n');
  g('add', '.');
  g('commit', '-q', '-m', 'one');
  fs.writeFileSync(file, 'item,price\napple,1\npear,3\nplum,4\n');
  const head = await readFromHead(file, 1024 * 1024);
  assert.strictEqual(head.ok, true);
  assert.strictEqual(head.bytes.toString(), 'item,price\napple,1\npear,2\n');
  const none = await readFromHead(path.join(dir, 'new.csv'), 1024);
  assert.strictEqual(none.ok, false);
  assert.match(none.message, /no committed version/);
  const outside = await readFromHead(path.join(os.tmpdir(), 'nowhere-' + Date.now(), 'x.csv'), 1024);
  assert.strictEqual(outside.ok, false);

  // The command with a mocked vscode: two virtual CSV documents go to vscode.diff.
  const calls = [];
  let provider;
  const vscode = {
    Uri: { from: o => ({ ...o, toString: () => `${o.scheme}:${o.path}?${o.query}` }), joinPath: (u, p) => ({ ...u, path: path.join(u.path, p) }) },
    workspace: { isTrusted: true, registerTextDocumentContentProvider: (_s, p) => { provider = p; return { dispose() {} }; } },
    window: {
      showInformationMessage: m => calls.push(['info', m]), showWarningMessage: m => calls.push(['warn', m]),
      withProgress: (_o, fn) => fn(),
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async (...a) => { calls.push(a); } },
    ProgressLocation: { Notification: 15 },
  };
  class FakeUri { constructor(p) { this.scheme = 'file'; this.path = p; this.fsPath = p; } }
  vscode.Uri = Object.assign(FakeUri, vscode.Uri);
  const ctx = { subscriptions: [] };
  const api = registerCompare({
    vscode, context: ctx, maxBytes: () => 1024 * 1024, activeUri: () => null,
    toText: async (src, format) => {
      const r = await tableToText(src.bytes ? { bytes: src.bytes } : { path: src.uri.fsPath }, format, {}, 1000);
      return { ok: true, ...r };
    },
  });
  await api.compareWithHead(new FakeUri(file));
  const diff = calls.find(c => c[0] === 'vscode.diff');
  assert.ok(diff, JSON.stringify(calls));
  assert.strictEqual(diff[3], 'prices.csv (HEAD ↔ Working Tree, as CSV)');
  const left = provider.provideTextDocumentContent(diff[1]);
  const right = provider.provideTextDocumentContent(diff[2]);
  assert.match(left, /pear,2/);
  assert.match(right, /pear,3\nplum,4/);
  assert.match(diff[2].path, /^\/Working Tree\/prices\.csv\.csv$/);

  // Untrusted workspace: no git run, a clear message instead.
  vscode.workspace.isTrusted = false;
  await api.compareWithHead(new FakeUri(file));
  assert.ok(calls.some(c => c[0] === 'info' && /trusted workspace/.test(c[1])));
  vscode.workspace.isTrusted = true;

  // Two files picked in the Explorer.
  const other = path.join(dir, 'prices-old.csv');
  fs.writeFileSync(other, 'item,price\napple,1\n');
  const n = calls.length;
  await api.compareWithOther(new FakeUri(other), [new FakeUri(other), new FakeUri(file)]);
  const d2 = calls.slice(n).find(c => c[0] === 'vscode.diff');
  assert.strictEqual(d2[3], 'prices-old.csv ↔ prices.csv (as CSV)');
});
