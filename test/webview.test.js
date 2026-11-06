'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/webview/math');
const { buildHtml } = require('../src/html');

test('scroll mapping without scaling is 1:1', () => {
  const r = M.scrollToRow(240, 1000, 24, 480);
  assert.deepStrictEqual(r, { first: 10, shift: 0, bodyH: 24000 });
  assert.strictEqual(M.rowToScroll(10, 1000, 24, 480), 240);
});

test('scroll mapping scales past the max element height and reaches the last row', () => {
  const rows = 5000000;
  const top = M.scrollToRow(0, rows, 24, 600);
  assert.strictEqual(top.first, 0);
  assert.strictEqual(top.bodyH, M.MAX_BODY_PX);
  const bottom = M.scrollToRow(M.MAX_BODY_PX - 600, rows, 24, 600);
  assert.strictEqual(bottom.first + Math.ceil(600 / 24), rows);
  const mid = M.scrollToRow(M.rowToScroll(2500000, rows, 24, 600), rows, 24, 600);
  assert.ok(Math.abs(mid.first - 2500000) <= 1);
  const oneM = M.scrollToRow(M.MAX_BODY_PX, 1000000, 24, 600);
  assert.strictEqual(oneM.first, 1000000 - 25);
});

test('pages, selection and sort cycling', () => {
  assert.deepStrictEqual(M.pagesFor(190, 410, 200), [0, 1, 2]);
  assert.deepStrictEqual(M.pagesFor(5, 4, 200), []);
  assert.deepStrictEqual(M.normSel({ r: 5, c: 3 }, { r: 1, c: 0 }), { r0: 1, r1: 5, c0: 0, c1: 3 });
  assert.strictEqual(M.inSel({ r0: 1, r1: 5, c0: 0, c1: 3 }, 2, 3), true);
  assert.strictEqual(M.inSel(null, 2, 3), false);
  assert.deepStrictEqual(M.nextSort(null, 2), { col: 2, dir: 'asc' });
  assert.deepStrictEqual(M.nextSort({ col: 2, dir: 'asc' }, 2), { col: 2, dir: 'desc' });
  assert.strictEqual(M.nextSort({ col: 2, dir: 'desc' }, 2), null);
  assert.deepStrictEqual(M.nextSort({ col: 1, dir: 'desc' }, 2), { col: 2, dir: 'asc' });
  assert.ok(M.autoWidth('x', 'int', ['1']) >= 64);
  assert.strictEqual(M.autoWidth('x', 'string', ['y'.repeat(500)]), 360);
});

test('webview HTML has a strict CSP and escapes the title', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/w.js', styleUri: 'vscode-resource:/w.css', title: '"><img src=x onerror=alert(1)>.csv', nonce: 'N0NCE' });
  const csp = html.match(/content="(default-src[^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0NCE'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;\.csv/);
});

test('webview code never writes HTML from strings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('no network code in the shipped bundles', () => {
  for (const f of ['extension.js', 'worker.js', 'webview.js']) {
    const p = path.join(__dirname, '..', 'dist', f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(s, /require\(["'](https?|net|tls|http2|dgram)["']\)/, f);
  }
});

test('CSP nonce comes from crypto and is unique', () => {
  const { nonce } = require('../src/html');
  const a = nonce(), b = nonce();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.notStrictEqual(a, b);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'html.js'), 'utf8');
  assert.doesNotMatch(src, /Math\.random/);
});

// R7 T1 and T5: the webview takes its filter state from each meta message.
test('filters from meta are copied and cleaned', () => {
  const f = { global: 'abc', columns: { 0: '>3', 2: '  ', 3: 7 } };
  const got = M.filtersFromMeta(f);
  assert.deepStrictEqual(got, { global: 'abc', columns: { 0: '>3' } });
  got.columns[1] = 'x';
  assert.strictEqual(f.columns[1], undefined);
  assert.deepStrictEqual(M.filtersFromMeta(undefined), { global: '', columns: {} });
  assert.deepStrictEqual(M.filtersFromMeta({ global: '', columns: {} }), { global: '', columns: {} });
});

// R7 T1: scroll position and column widths survive the webview being rebuilt when the tab is shown again.
test('saved view state restores scroll and widths only when it fits the table', () => {
  const saved = JSON.parse(JSON.stringify(M.viewState(4800.7, 120, [80, 140, 60], 'Sheet1')));
  assert.deepStrictEqual(M.restoreView(saved, 3, 'Sheet1'), { widths: [80, 140, 60], scrollTop: 4800, scrollLeft: 120 });
  assert.deepStrictEqual(M.restoreView(saved, 4, 'Sheet1'), { widths: null, scrollTop: 4800, scrollLeft: 120 });
  assert.strictEqual(M.restoreView(saved, 3, 'Sheet2'), null);
  assert.strictEqual(M.restoreView(null, 3, ''), null);
  assert.deepStrictEqual(M.restoreView({ widths: [1e9], scrollTop: 'x' }, 1, undefined), { widths: null, scrollTop: 0, scrollLeft: 0 });
});
