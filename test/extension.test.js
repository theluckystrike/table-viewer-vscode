'use strict';
// Runs the extension host code with a mocked vscode module and the real bundled worker.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const registered = { editors: [], commands: {} };
let clipboard = '';
const vscodeMock = {
  Uri: {
    joinPath: (u, ...p) => ({ ...u, path: path.join(u.path, ...p), fsPath: path.join(u.fsPath || u.path, ...p) }),
    file: p => ({ scheme: 'file', path: p, fsPath: p }),
  },
  window: {
    registerCustomEditorProvider: (id, provider) => { registered.editors.push({ id, provider }); return { dispose() {} }; },
    showWarningMessage: () => {}, showInformationMessage: () => {},
  },
  commands: { registerCommand: (id, fn) => { registered.commands[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), fs: {} },
  env: { clipboard: { writeText: async t => { clipboard = t; } } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };

test('activate registers both editors and the commands', () => {
  const ext = require('../src/extension');
  ext.activate({ subscriptions: [], extensionUri: vscodeMock.Uri.file(root), extensionPath: root });
  assert.deepStrictEqual(registered.editors.map(e => e.id), ['tableViewer.table', 'tableViewer.tableText']);
  for (const id of ['tableViewer.openInTableViewer', 'tableViewer.copySelectionAsCsv', 'tableViewer.copySelectionAsJson', 'tableViewer.openWalkthrough']) {
    assert.ok(registered.commands[id], id);
  }
  const pkg = require('../package.json');
  assert.deepStrictEqual(pkg.contributes.customEditors.map(e => e.viewType), ['tableViewer.table', 'tableViewer.tableText']);
  assert.deepStrictEqual(Object.keys(registered.commands).sort(), pkg.contributes.commands.map(c => c.command).sort());
});

test('a CSV opens, rows flow to the webview, and copy reaches the clipboard', async t => {
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  const provider = registered.editors[0].provider;
  const toWebview = [];
  let onMsg, onDispose;
  const waiters = [];
  const panel = {
    active: true,
    webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      asWebviewUri: u => ({ toString: () => 'vscode-resource:' + u.path }),
      postMessage: m => { toWebview.push(m); waiters.slice().forEach(w => w()); return Promise.resolve(true); },
      onDidReceiveMessage: fn => { onMsg = fn; },
    },
    onDidChangeViewState: () => {},
    onDidDispose: fn => { onDispose = fn; },
  };
  const until = pred => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + JSON.stringify(toWebview.map(m => m.type)))), 15000);
    const check = () => { const m = toWebview.find(pred); if (m) { clearTimeout(timer); resolve(m); } };
    waiters.push(check); check();
  });
  const file = path.join(__dirname, 'fixtures', 'sample.csv');
  const doc = provider.openCustomDocument(vscodeMock.Uri.file(file));
  await provider.resolveCustomEditor(doc, panel);
  t.after(() => onDispose());
  assert.match(panel.webview.html, /Content-Security-Policy/);
  onMsg({ type: 'ready' });
  const init = await until(m => m.type === 'init');
  assert.deepStrictEqual(init, { type: 'init', fileName: 'sample.csv', format: 'csv' });
  const meta = await until(m => m.type === 'meta' && !m.loading);
  assert.strictEqual(meta.rowCount, 4);
  onMsg({ type: 'getRows', reqId: 1, start: 0, count: 200 });
  const rows = await until(m => m.type === 'rows');
  assert.strictEqual(rows.rows[1].cells[1], 'Bob, Jr.');
  onMsg({ type: 'bogus' });
  onMsg({ type: 'copy', format: 'csv', sel: { r0: 1, r1: 1, c0: 0, c1: 1 } });
  await until(m => m.type === 'copied');
  assert.strictEqual(clipboard, 'id,name\r\n2,"Bob, Jr."');
});

test('an unsupported file shows an error instead of crashing', async () => {
  const provider = registered.editors[0].provider;
  const got = [];
  let onMsg;
  const panel = {
    webview: { cspSource: 'x', options: {}, asWebviewUri: u => ({ toString: () => u.path }), postMessage: m => { got.push(m); }, onDidReceiveMessage: fn => { onMsg = fn; } },
    onDidChangeViewState: () => {}, onDidDispose: () => {},
  };
  await provider.resolveCustomEditor(provider.openCustomDocument(vscodeMock.Uri.file('/tmp/x.json')), panel);
  onMsg({ type: 'ready' });
  assert.ok(got.some(m => m.type === 'error' && /Unsupported/.test(m.message)));
});

// R7 T1: with retainContextWhenHidden false, VS Code destroys the webview when the tab is hidden and
// loads it again when the tab is shown, which sends a second 'ready'. The table must come back.
function fakePanel() {
  const p = { sent: [], waiters: [], visible: true, active: true };
  p.panel = {
    get active() { return p.active; }, get visible() { return p.visible; },
    webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      asWebviewUri: u => ({ toString: () => 'vscode-resource:' + u.path }),
      postMessage: m => { p.sent.push(m); p.waiters.slice().forEach(w => w()); return Promise.resolve(p.visible); },
      onDidReceiveMessage: fn => { p.onMsg = fn; },
    },
    onDidChangeViewState: fn => { p.onView = fn; },
    onDidDispose: fn => { p.onDispose = fn; },
  };
  p.setVisible = v => { p.visible = v; p.active = v; p.onView({ webviewPanel: p.panel }); };
  p.until = (pred, from = 0) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + JSON.stringify(p.sent.map(m => m.type)))), 15000);
    const check = () => { const m = p.sent.slice(from).find(pred); if (m) { clearTimeout(timer); resolve(m); } };
    p.waiters.push(check); check();
  });
  return p;
}

test('the table comes back with its sort and filters after the tab is hidden and shown', async t => {
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  const provider = registered.editors[0].provider;
  const p = fakePanel();
  await provider.resolveCustomEditor(provider.openCustomDocument(vscodeMock.Uri.file(path.join(__dirname, 'fixtures', 'sample.csv'))), p.panel);
  t.after(() => p.onDispose());
  p.onMsg({ type: 'ready' });
  await p.until(m => m.type === 'meta' && !m.loading && m.rowCount === 4);
  p.onMsg({ type: 'sort', col: 0, dir: 'desc' });
  await p.until(m => m.type === 'view');
  p.onMsg({ type: 'filter', global: '', columns: { 0: '>1' } });
  await p.until(m => m.type === 'view' && m.viewCount === 3);

  p.setVisible(false); // webview destroyed
  p.setVisible(true);  // webview rebuilt; its script starts again and says ready
  const from = p.sent.length;
  p.onMsg({ type: 'ready' });
  assert.strictEqual(p.sent[from].type, 'init');
  const meta = await p.until(m => m.type === 'meta', from);
  assert.strictEqual(meta.loading, false);
  assert.strictEqual(meta.rowCount, 4);
  assert.strictEqual(meta.viewCount, 3);
  assert.strictEqual(meta.columns.length, 5);
  assert.deepStrictEqual(meta.sort, { col: 0, dir: 'desc' });
  assert.deepStrictEqual(meta.filters, { global: '', columns: { 0: '>1' } });
  p.onMsg({ type: 'getRows', reqId: 1, start: 0, count: 200 });
  const rows = await p.until(m => m.type === 'rows', from);
  assert.deepStrictEqual(rows.rows.map(r => r.cells[0]), ['4', '3', '2']);
});

test('a load that finishes while the tab is hidden is not lost', async t => {
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  const provider = registered.editors[0].provider;
  const p = fakePanel();
  await provider.resolveCustomEditor(provider.openCustomDocument(vscodeMock.Uri.file(path.join(__dirname, 'fixtures', 'sample.parquet'))), p.panel);
  t.after(() => p.onDispose());
  p.onMsg({ type: 'ready' });
  p.setVisible(false); // hidden before the worker answers
  const hiddenAt = p.sent.length;
  await new Promise(r => setTimeout(r, 1500)); // the worker finishes the load in the background
  assert.deepStrictEqual(p.sent.slice(hiddenAt).map(m => m.type), [], 'nothing is posted to a hidden webview');
  p.setVisible(true);
  p.onMsg({ type: 'ready' });
  const meta = await p.until(m => m.type === 'meta' && !m.loading, hiddenAt);
  assert.ok(meta.rowCount > 0);
  assert.ok(meta.columns.length > 0);
  assert.ok(meta.loadMs >= 0);
});

test('an error is shown again after the tab is hidden and shown', async () => {
  const provider = registered.editors[0].provider;
  const p = fakePanel();
  await provider.resolveCustomEditor(provider.openCustomDocument(vscodeMock.Uri.file('/tmp/x.json')), p.panel);
  p.onMsg({ type: 'ready' });
  p.setVisible(false);
  p.setVisible(true);
  const from = p.sent.length;
  p.onMsg({ type: 'ready' });
  assert.deepStrictEqual(p.sent.slice(from).map(m => m.type), ['init', 'error']);
  assert.match(p.sent[from + 1].message, /Unsupported/);
});
