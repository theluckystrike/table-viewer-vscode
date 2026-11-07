'use strict';
// The extension host with the Pro switch ON (config replaced for this test file only), a mocked
// vscode module, SecretStorage, and the real bundled worker.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const L = require('../src/license');

const root = path.join(__dirname, '..');
const priv = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'fixtures', 'license-test-ed25519.pem')));
const testConfig = Object.freeze({
  ...require('../src/config'),
  PRO_ENABLED: true,
  LICENSE_PUBLIC_KEY: crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString(),
});
const goodKey = L.signLicense(L.makePayload({ email: 'buyer@example.com', plan: 'lifetime' }), priv);

const registered = { editors: [], commands: {} };
const calls = { context: [], external: [], info: [], error: [], warn: [] };
const ui = { input: undefined, pick: undefined, save: undefined, confirm: 'Remove' };
const secrets = new Map();
const uri = p => ({ scheme: 'file', path: p, fsPath: p, toString: () => 'file://' + p });
const vscodeMock = {
  Uri: {
    joinPath: (u, ...p) => uri(path.join(u.fsPath || u.path, ...p)),
    file: uri,
    parse: s => ({ toString: () => s }),
  },
  window: {
    registerCustomEditorProvider: (id, provider) => { registered.editors.push({ id, provider }); return { dispose() {} }; },
    showWarningMessage: async (m) => { calls.warn.push(m); return ui.confirm; },
    showInformationMessage: async m => { calls.info.push(m); },
    showErrorMessage: async m => { calls.error.push(m); },
    showInputBox: async o => { calls.validate = o.validateInput; return ui.input; },
    showQuickPick: async items => items.find(i => i.id === ui.pick),
    showSaveDialog: async () => ui.save,
  },
  commands: {
    registerCommand: (id, fn) => { registered.commands[id] = fn; return { dispose() {} }; },
    executeCommand: async (...a) => { if (a[0] === 'setContext') calls.context.push(a.slice(1)); },
  },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d, inspect: () => ({}) }), fs: {}, registerTextDocumentContentProvider: () => ({ dispose() {} }) },
  env: { clipboard: { writeText: async () => {} }, openExternal: async u => { calls.external.push(u.toString()); return true; } },
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'vscode') return vscodeMock;
  if (req === './config' && parent && parent.filename === path.join(root, 'src', 'extension.js')) return testConfig;
  return origLoad.call(this, req, parent, ...rest);
};

const context = {
  subscriptions: [], extensionUri: uri(root), extensionPath: root,
  secrets: {
    get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); },
  },
};
const ext = require('../src/extension');
ext.activate(context);

function fakePanel() {
  const p = { sent: [], waiters: [] };
  p.panel = {
    active: true, visible: true,
    webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      asWebviewUri: u => ({ toString: () => 'vscode-resource:' + u.path }),
      postMessage: m => { p.sent.push(m); p.waiters.slice().forEach(w => w()); return Promise.resolve(true); },
      onDidReceiveMessage: fn => { p.onMsg = fn; },
    },
    onDidChangeViewState: () => {},
    onDidDispose: fn => { p.onDispose = fn; },
  };
  p.until = (pred, from = 0) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + JSON.stringify(p.sent.map(m => m.type)))), 15000);
    const check = () => { const m = p.sent.slice(from).find(pred); if (m) { clearTimeout(timer); resolve(m); } };
    p.waiters.push(check); check();
  });
  return p;
}

async function openCsv(t) {
  const provider = registered.editors[0].provider;
  const p = fakePanel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uri(path.join(__dirname, 'fixtures', 'sample.csv'))), p.panel);
  t.after(() => p.onDispose());
  p.onMsg({ type: 'ready' });
  await p.until(m => m.type === 'meta' && !m.loading);
  return p;
}

test('Pro on: the palette shows the license commands and an unlicensed webview gets only the badge', async t => {
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  assert.deepStrictEqual(calls.context, [['tableViewer.proEnabled', true]]);
  const p = await openCsv(t);
  const pro = p.sent.find(m => m.type === 'pro');
  assert.deepStrictEqual(pro, { type: 'pro', enabled: true, licensed: false, plan: null, expires: null });
  p.onMsg({ type: 'openProPage' });
  assert.deepStrictEqual(calls.external, [testConfig.PRO_URL]);
  const from = p.sent.length;
  p.onMsg({ type: 'stats' });
  p.onMsg({ type: 'export' });
  const errs = await p.until(m => m.type === 'error' && m.code === 'PRO', from);
  assert.match(errs.message, /Pro feature/);
});

test('entering a key: bad keys are refused, a good key is stored in SecretStorage and unlocks open tables', async t => {
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  const p = await openCsv(t);
  ui.input = 'TVPRO1.nope.nope';
  await registered.commands['tableViewer.enterLicenseKey']();
  assert.match(calls.error.pop(), /not valid|damaged|not a Table Viewer/);
  assert.strictEqual(secrets.size, 0);
  assert.match(calls.validate('garbage'), /not a Table Viewer Pro license key/);
  assert.strictEqual(calls.validate(goodKey), null);

  const from = p.sent.length;
  ui.input = goodKey.slice(0, 50) + '\n' + goodKey.slice(50);
  await registered.commands['tableViewer.enterLicenseKey']();
  assert.strictEqual(secrets.get('tableViewer.licenseKey'), goodKey);
  assert.match(calls.info.pop(), /Table Viewer Pro is on/);
  const pro = await p.until(m => m.type === 'pro' && m.licensed, from);
  assert.strictEqual(pro.plan, 'lifetime');

  // The open table can now use the SQL filter and stats.
  p.onMsg({ type: 'filter', global: '', columns: {}, query: 'id >= 3' });
  const view = await p.until(m => m.type === 'view', from);
  assert.strictEqual(view.viewCount, 2);
  p.onMsg({ type: 'stats' });
  const stats = await p.until(m => m.type === 'stats', from);
  assert.strictEqual(stats.rows, 2);
});

test('export asks for a format and a file, then writes the filtered rows', async t => {
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-pro-ext-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = await openCsv(t);
  assert.ok(p.sent.some(m => m.type === 'pro' && m.licensed), 'a new tab opens licensed (key from SecretStorage)');
  p.onMsg({ type: 'filter', global: '', columns: { 0: '<=2' } });
  await p.until(m => m.type === 'view');
  ui.pick = 'jsonl';
  ui.save = uri(path.join(dir, 'out.jsonl'));
  const from = p.sent.length;
  p.onMsg({ type: 'export' });
  const done = await p.until(m => m.type === 'exported', from);
  assert.deepStrictEqual([done.ok, done.rows, done.format], [true, 2, 'jsonl']);
  const lines = fs.readFileSync(path.join(dir, 'out.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines.map(o => o.id), [1, 2]);
  assert.match(calls.info.pop(), /Exported 2 rows to out\.jsonl/);
  // Cancelled save dialog: nothing happens.
  ui.save = undefined;
  const before = p.sent.length;
  p.onMsg({ type: 'export', format: 'csv' });
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!p.sent.slice(before).some(m => m.type === 'exporting'));
});

test('removing the key turns Pro off in open tables', async t => {
  if (!fs.existsSync(path.join(root, 'dist', 'worker.js'))) return t.skip('run the build first');
  const p = await openCsv(t);
  const from = p.sent.length;
  await registered.commands['tableViewer.removeLicenseKey']();
  assert.strictEqual(secrets.size, 0);
  const pro = await p.until(m => m.type === 'pro', from);
  assert.strictEqual(pro.licensed, false);
});
