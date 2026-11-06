'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage } = require('./core/protocol');
const { formatFromPath } = require('./core/formats');

const VIEW_TYPE = 'tableViewer.table';
const TEXT_VIEW_TYPE = 'tableViewer.tableText';
const STATE_MESSAGES = new Set(['meta', 'view', 'rows']);
const panels = new Set();
let activePanel = null;

function settings() {
  const c = vscode.workspace.getConfiguration('tableViewer');
  return {
    maxRows: c.get('maxRows', 1000000),
    maxFileSizeMB: c.get('maxFileSizeMB', 512),
    maxExcelSizeMB: c.get('maxExcelSizeMB', 50),
    maxCopyRows: c.get('maxCopyRows', 100000),
  };
}

class TableEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    const uri = document.uri;
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
    });

    const opts = settings();
    const format = formatFromPath(uri.path);
    let worker = null;
    let disposed = false;
    let webviewReady = false;
    let fatal = null; // host-side error (unsupported file, reader crash), resent to a reloaded webview
    const queue = [];
    // While the webview is gone (tab hidden) or not ready yet, keep only one-off notices. Table state
    // (meta, view, rows) is rebuilt with a 'resync' when the webview says 'ready' again.
    const toWebview = msg => {
      if (disposed) return;
      if (webviewReady) { panel.webview.postMessage(msg); return; }
      if (!STATE_MESSAGES.has(msg.type) && !(msg.type === 'error' && !msg.transient)) queue.push(msg);
    };
    const failHost = message => { fatal = { type: 'error', message }; toWebview(fatal); };

    const startWorker = async () => {
      let source;
      if (uri.scheme === 'file') {
        source = { path: uri.fsPath };
      } else {
        const stat = await vscode.workspace.fs.stat(uri);
        const limit = (format === 'excel' ? opts.maxExcelSizeMB : opts.maxFileSizeMB) * 1024 * 1024;
        if (stat.size > limit) throw new Error(`This remote file is ${(stat.size / 1048576).toFixed(0)} MB. Files that are not on disk are read whole, and the limit is ${Math.round(limit / 1048576)} MB.`);
        source = { bytes: await vscode.workspace.fs.readFile(uri) };
      }
      worker = new Worker(path.join(ctx.extensionPath, 'dist', 'worker.js'), {
        resourceLimits: { maxOldGenerationSizeMb: 4096 },
      });
      worker.on('message', msg => {
        if (msg && msg.type === 'copyResult') return onCopy(msg);
        toWebview(msg);
      });
      worker.on('error', e => failHost(`The reader stopped: ${e.message}`));
      worker.on('exit', code => {
        if (!disposed && code !== 0 && !fatal) failHost('The reader ran out of memory or crashed. Lower tableViewer.maxRows and reopen the file.');
      });
      worker.postMessage({ type: 'open', source, format, options: opts });
    };

    const onCopy = async msg => {
      await vscode.env.clipboard.writeText(msg.text || '');
      const fmt = String(msg.format).toUpperCase();
      const note = msg.truncated ? ` The selection was cut to the first ${msg.rows.toLocaleString('en-US')} rows (tableViewer.maxCopyRows).` : '';
      toWebview({ type: 'copied', rows: msg.rows, format: msg.format, truncated: !!msg.truncated });
      if (msg.truncated) vscode.window.showWarningMessage(`Copied ${msg.rows.toLocaleString('en-US')} rows as ${fmt}.${note}`);
    };

    const state = {
      panel,
      copy: format => panel.webview.postMessage({ type: 'requestCopy', format }),
    };
    panels.add(state);
    activePanel = state;
    panel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) activePanel = state;
      // retainContextWhenHidden is false, so a hidden tab has no webview. Hold messages until it is back.
      if (!e.webviewPanel.visible) webviewReady = false;
    });

    panel.webview.onDidReceiveMessage(raw => {
      const msg = validateWebviewMessage(raw);
      if (!msg) return;
      if (msg.type === 'ready') {
        // Sent on first load and again each time the tab is shown after being hidden.
        webviewReady = true;
        panel.webview.postMessage({ type: 'init', fileName: name, format });
        while (queue.length) panel.webview.postMessage(queue.shift());
        if (fatal) panel.webview.postMessage(fatal);
        else if (worker) worker.postMessage({ type: 'resync' });
        return;
      }
      if (msg.type === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'tableViewer');
        return;
      }
      if (!worker) return;
      if (msg.type === 'copy') msg.maxRows = settings().maxCopyRows;
      worker.postMessage(msg);
    });

    panel.onDidDispose(() => {
      disposed = true;
      panels.delete(state);
      if (activePanel === state) activePanel = null;
      if (worker) worker.terminate();
    });

    try {
      if (!format) throw new Error('Unsupported file type.');
      await startWorker();
    } catch (e) {
      failHost(e.message || String(e));
    }
  }
}

function activate(context) {
  const provider = new TableEditorProvider(context);
  context.subscriptions.push(
    ...[VIEW_TYPE, TEXT_VIEW_TYPE].map(id => vscode.window.registerCustomEditorProvider(id, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    })),
    vscode.commands.registerCommand('tableViewer.openInTableViewer', async uri => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) { vscode.window.showInformationMessage('Open a CSV, TSV, Parquet or Excel file first.'); return; }
      const fmt = formatFromPath(target.path);
      if (!fmt) { vscode.window.showInformationMessage('Table Viewer opens .csv, .tsv, .parquet, .xlsx, .xls and .ods files.'); return; }
      await vscode.commands.executeCommand('vscode.openWith', target, fmt === 'csv' || fmt === 'tsv' ? TEXT_VIEW_TYPE : VIEW_TYPE);
    }),
    vscode.commands.registerCommand('tableViewer.copySelectionAsCsv', () => activePanel && activePanel.copy('csv')),
    vscode.commands.registerCommand('tableViewer.copySelectionAsJson', () => activePanel && activePanel.copy('json')),
    vscode.commands.registerCommand('tableViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.table-viewer-vscode#tableViewer.start', false)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, TableEditorProvider };
