'use strict';
// Sponsor field, support commands and the showSupportLinks setting, with a mocked vscode module.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const settings = {};
const registered = { editors: [], commands: {} };
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
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), fs: {}, registerTextDocumentContentProvider: () => ({ dispose() {} }) },
  env: { clipboard: { writeText: async () => {} } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };

test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const support = require('../src/support');
  assert.strictEqual(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.strictEqual(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes('tableViewer.supportDeveloper') && ids.includes('tableViewer.moreViewers'));
  const cfg = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
  const prop = cfg.map(c => c.properties['tableViewer.showSupportLinks']).find(Boolean);
  assert.strictEqual(prop.default, true);
  assert.ok(support.otherProducts('zovo.table-viewer-vscode').every(p => p.id !== 'zovo.table-viewer-vscode'));
});

test('support: the footer shows by default and tableViewer.showSupportLinks=false hides it', async () => {
  const ext = require('../src/extension');
  ext.activate({ subscriptions: [], extensionUri: vscodeMock.Uri.file(root), extensionPath: root });
  assert.ok(registered.commands['tableViewer.supportDeveloper'] && registered.commands['tableViewer.moreViewers']);
  const provider = registered.editors[0].provider;
  for (const [value, shown] of [[undefined, true], [false, false]]) {
    if (value === undefined) delete settings.showSupportLinks; else settings.showSupportLinks = value;
    const panel = {
      webview: { cspSource: 'vscode-resource:', options: {}, html: '', asWebviewUri: u => ({ toString: () => 'vscode-resource:' + u.path }), postMessage: () => Promise.resolve(true), onDidReceiveMessage: () => {} },
      onDidChangeViewState: () => {}, onDidDispose: () => {},
    };
    await provider.resolveCustomEditor(provider.openCustomDocument(vscodeMock.Uri.file('/tmp/x.json')), panel);
    const html = panel.webview.html;
    assert.strictEqual(/id="zovo-support"/.test(html), shown, String(value));
    assert.strictEqual(html.includes('command:tableViewer.supportDeveloper'), shown);
    assert.deepStrictEqual(panel.webview.options.enableCommandUris, ['tableViewer.supportDeveloper', 'tableViewer.moreViewers', 'workbench.action.openSettings']);
    const csp = html.match(/content="(default-src[^"]+)"/)[1];
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  }
  // the webview script moves the line into its bottom status bar
  assert.match(fs.readFileSync(path.join(root, 'src', 'webview', 'main.js'), 'utf8'), /getElementById\('zovo-support'\)/);
});
