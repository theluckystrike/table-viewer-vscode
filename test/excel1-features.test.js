'use strict';
// 0.4: Excel formulas and error cells, Copy as Markdown, encoding detection and the encoding picker,
// and the SQL filter / stats / export free for everyone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const R = require('../src/core/readers');
const { Table, mdEscape } = require('../src/core/table');
const { validateWebviewMessage, createSession } = require('../src/core/protocol');
const { detectEncoding, CSV_ENCODINGS } = require('../src/core/encoding');
const M = require('../src/webview/math');

const FX = path.join(__dirname, 'fixtures');

function workbook() {
  const ws = XLSX.utils.aoa_to_sheet([['item', 'qty', 'price', 'total'], ['pen', 2, 1.5, 0], ['ink', 3, 4, 0], ['bad', 0, 0, 0]]);
  ws.D2 = { t: 'n', v: 3, f: 'B2*C2' };
  ws.D3 = { t: 'n', v: 12, f: 'B3*C3' };
  ws.D4 = { t: 'e', v: 7, w: '#DIV/0!', f: 'B4/C4' };
  ws.E1 = { t: 's', v: 'sum' };
  ws.E2 = { t: 'n', f: 'SUM(D2:D3)' }; // no cached result
  ws['!ref'] = 'A1:E4';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('Excel formulas: the cell panel gets the formula, the Formulas switch shows them in the grid', async () => {
  const { table, info } = await R.loadFile({ bytes: workbook() }, 'excel', {});
  assert.strictEqual(info.formulaCells, 4);
  assert.strictEqual(table.shown(0, 3), '3');
  assert.strictEqual(table.getCell(0, 3).formula, '=B2*C2');
  assert.strictEqual(table.shown(2, 3), '#DIV/0!', 'error cells show their Excel text, not an empty cell');
  assert.strictEqual(table.shown(0, 4), '=SUM(D2:D3)', 'a formula with no saved result shows the formula');
  table.showFormulas = true;
  assert.strictEqual(table.shown(1, 3), '=B3*C3');
  assert.strictEqual(table.shown(0, 0), 'pen', 'cells without a formula are unchanged');
  table.setFilters({ global: 'b3*c3', columns: {} });
  assert.strictEqual(table.viewCount, 1, 'search finds formula text while formulas are shown');
  // copy keeps stored values
  table.setFilters({ global: '', columns: {} });
  assert.match(table.copy({ r0: 0, r1: 1, c0: 0, c1: 3 }, 'csv').text, /pen,2,1\.5,3/);
});

test('Excel formulas: the session toggles them and sends the state in meta and view', async () => {
  const out = [];
  const session = createSession({ post: m => out.push(m), loader: (s, f, o) => R.loadFile(s, f, o) });
  await session.handle({ type: 'open', source: { bytes: workbook() }, format: 'excel', options: {} });
  const meta = out.find(m => m.type === 'meta' && !m.loading);
  assert.strictEqual(meta.showFormulas, false);
  assert.strictEqual(meta.info.formulaCells, 4);
  session.handle(validateWebviewMessage({ type: 'formulas', on: true }));
  const view = out[out.length - 1];
  assert.strictEqual(view.type, 'view');
  assert.strictEqual(view.showFormulas, true);
  session.handle({ type: 'getRows', reqId: 1, start: 0, count: 5 });
  assert.strictEqual(out[out.length - 1].rows[0].cells[3], '=B2*C2');
  assert.strictEqual(validateWebviewMessage({ type: 'formulas', on: 'yes' }), null);
});

test('Copy as Markdown: header, alignment for numbers, escaped pipes and line breaks, text as shown', () => {
  const t = new Table([{ name: 'name', type: 'string' }, { name: 'n', type: 'int' }],
    [{ values: ['a|b', 'line1\nline2', '<script>x</script>'] }, { values: new Float64Array([1, 2, 3]), nulls: null }], 3);
  const md = t.copy({ r0: 0, r1: 2, c0: 0, c1: 1 }, 'md');
  assert.strictEqual(md.rows, 3);
  assert.deepStrictEqual(md.text.split('\n'), [
    '| name | n |', '| --- | ---: |', '| a\\|b | 1 |', '| line1<br>line2 | 2 |', '| &lt;script&gt;x&lt;/script&gt; | 3 |',
  ]);
  assert.strictEqual(mdEscape(null), '');
  assert.strictEqual(mdEscape('C:\\dir'), 'C:\\\\dir');
  assert.deepStrictEqual(validateWebviewMessage({ type: 'copy', format: 'md', sel: { r0: 0, r1: 1, c0: 0, c1: 1 } }).format, 'md');
  assert.strictEqual(validateWebviewMessage({ type: 'copy', format: 'html', sel: {} }), null);
});

test('Copy as Markdown uses the Excel display text', async () => {
  const ws = XLSX.utils.aoa_to_sheet([['share'], [0.25]]);
  ws.A2.z = '0%';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const { table } = await R.loadFile({ bytes: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) }, 'excel', {});
  assert.strictEqual(table.copy({ r0: 0, r1: 0, c0: 0, c1: 0 }, 'md').text.split('\n')[2], '| 25% |');
});

for (const [file, enc, first] of [
  ['enc-shift_jis.csv', 'shift_jis', '山田太郎'], ['enc-gb18030.csv', 'gb18030', '北京科技有限公司'], ['enc-big5.csv', 'big5', '台北科技有限公司'],
  ['enc-euc-kr.csv', 'euc-kr', '김철수'], ['enc-windows-1251.csv', 'windows-1251', 'Иван Петров'], ['enc-utf-16le-nobom.csv', 'utf-16le', 'Zoë'],
]) {
  test(`encoding: ${file} is detected as ${enc}`, async () => {
    const bytes = fs.readFileSync(path.join(FX, file));
    assert.strictEqual(detectEncoding(bytes), enc);
    const { table, info } = await R.loadFile({ path: path.join(FX, file) }, 'csv', {});
    assert.strictEqual(info.encoding, enc);
    assert.strictEqual(info.encodingAuto, true);
    assert.strictEqual(table.shown(0, 0), first);
  });
}

test('encoding: Western text stays Windows-1252, UTF-8 and BOMs win, a picked encoding wins over detection', async () => {
  assert.strictEqual(detectEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80, 0x0a])), 'windows-1252');
  assert.strictEqual(detectEncoding(Buffer.from('名前,東京\n', 'utf8')), 'utf-8');
  assert.strictEqual(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'utf-8');
  assert.strictEqual(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x41])), 'utf-16be');
  const p = path.join(FX, 'enc-shift_jis.csv');
  const forced = await R.loadFile({ path: p }, 'csv', { encoding: 'windows-1252' });
  assert.strictEqual(forced.info.encoding, 'windows-1252');
  assert.strictEqual(forced.info.encodingAuto, false);
  assert.notStrictEqual(forced.table.shown(0, 0), '山田太郎');
  const bogus = await R.loadFile({ path: p }, 'csv', { encoding: 'x-made-up' });
  assert.strictEqual(bogus.info.encoding, 'shift_jis', 'an unknown encoding name falls back to detection');
});

test('encoding: csvOptions validation and the toolbar list', () => {
  assert.strictEqual(validateWebviewMessage({ type: 'csvOptions', delimiter: 'auto', header: true, encoding: 'shift_jis' }).encoding, 'shift_jis');
  assert.strictEqual(validateWebviewMessage({ type: 'csvOptions', delimiter: 'auto', header: true, encoding: 'auto' }).encoding, 'auto');
  assert.strictEqual(validateWebviewMessage({ type: 'csvOptions', delimiter: 'auto', header: true, encoding: 'ebcdic' }), null);
  assert.ok(!('encoding' in validateWebviewMessage({ type: 'csvOptions', delimiter: 'auto', header: true })));
  const c = M.encodingChoices({ encoding: 'gb18030', encodingAuto: true });
  assert.strictEqual(c.selected, 'auto');
  assert.match(c.choices[0].label, /GB18030/);
  assert.strictEqual(M.encodingChoices({ encoding: 'big5', encodingAuto: false }).selected, 'big5');
  assert.deepStrictEqual(M.ENCODINGS.map(e => e[0]), CSV_ENCODINGS);
});

test('encoding: the session reads the file again with the picked encoding', async () => {
  const out = [];
  const session = createSession({ post: m => out.push(m), loader: (s, f, o, p) => R.loadFile(s, f, o, p) });
  await session.handle({ type: 'open', source: { path: path.join(FX, 'enc-big5.csv') }, format: 'csv', options: {} });
  await session.handle(validateWebviewMessage({ type: 'csvOptions', delimiter: 'auto', header: true, encoding: 'gb18030' }));
  const meta = out.filter(m => m.type === 'meta' && !m.loading).pop();
  assert.strictEqual(meta.info.encoding, 'gb18030');
  assert.strictEqual(meta.info.encodingAuto, false);
});

test('big .xlsx files stream: preview first, the same table as SheetJS, async sheet switch, formulas', async () => {
  // A 2+ MB workbook with formulas, a percent format, a date and an error on a second sheet.
  const n = 60000;
  const aoa = [['id', 'name', 'qty', 'price', 'total', 'day']];
  for (let i = 0; i < n; i++) aoa.push([i, `item ${i} ${'x'.repeat(i % 7)}`, i % 50, (i % 997) / 10, null, new Date(Date.UTC(2026, 0, 1 + (i % 300)))]);
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  for (let r = 2; r <= n + 1; r++) ws['E' + r] = { t: 'n', v: aoa[r - 1][2] * aoa[r - 1][3], f: `C${r}*D${r}`, z: '0.00' };
  const ws2 = XLSX.utils.aoa_to_sheet([['k', 'v'], ['share', 0.25], ['bad', 0]]);
  ws2.B2.z = '0%';
  ws2.B3 = { t: 'e', v: 7, w: '#DIV/0!', f: '1/0' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Big');
  XLSX.utils.book_append_sheet(wb, ws2, 'Small');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: false });
  assert.ok(buf.length >= R.STREAM_MIN_BYTES, `fixture is ${buf.length} bytes`);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tv-stream-'));
  const file = path.join(dir, 'big.xlsx');
  fs.writeFileSync(file, buf);
  try {
    let preview = null;
    const res = await R.loadFile({ path: file }, 'excel', {}, (t, i) => { preview = preview || { rows: t.rowCount, loading: i.loading }; });
    assert.ok(preview && preview.loading && preview.rows >= 1000 && preview.rows < n, JSON.stringify(preview));
    assert.strictEqual(res.info.streamed, true);
    assert.strictEqual(res.table.rowCount, n);
    assert.strictEqual(res.info.totalRows, n);
    assert.strictEqual(res.info.formulaCells, n);
    // Same values and display text as the SheetJS path on the same bytes.
    const ref = await R.loadFile({ bytes: buf }, 'excel', {});
    assert.ok(!ref.info.streamed);
    assert.deepStrictEqual(res.table.columns, ref.table.columns);
    for (const r of [0, 1, 999, 1000, 31337, n - 1]) {
      for (let c = 0; c < 6; c++) assert.strictEqual(res.table.shown(r, c), ref.table.shown(r, c), `row ${r} col ${c}`);
      assert.strictEqual(res.table.getCell(r, 4).formula, `=C${r + 2}*D${r + 2}`);
    }
    const small = await res.loadSheet('Small');
    assert.strictEqual(small.info.activeSheet, 'Small');
    assert.strictEqual(small.table.shown(0, 1), '25%');
    assert.strictEqual(small.table.shown(1, 1), '#DIV/0!');
    assert.strictEqual(small.table.getCell(1, 1).formula, '=1/0');
    // maxRows: the first N rows, and the banner says there are more.
    const cut = await R.loadFile({ path: file }, 'excel', { maxRows: 1000 });
    assert.strictEqual(cut.table.rowCount, 1000);
    assert.strictEqual(cut.info.truncated, true);
    assert.match(cut.info.truncatedReason, /first 1,000 rows/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged big .xlsx falls back to SheetJS and gives its plain message', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tv-stream-'));
  const file = path.join(dir, 'broken.xlsx');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(3 * 1024 * 1024, 7)]));
  try {
    await assert.rejects(R.loadFile({ path: file }, 'excel', {}), e => e.code === 'BAD_WORKBOOK' || /could not be read|zip|workbook/i.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
