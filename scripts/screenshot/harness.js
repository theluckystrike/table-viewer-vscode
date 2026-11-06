// Builds a static page with the real webview bundle and real rows from trips.parquet (sorted by fare, desc).
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const { loadFile } = require(root + '/src/core/readers');
const { columnsMeta } = require(root + '/src/core/protocol');
(async () => {
  const t0 = Date.now();
  const { table, info } = await loadFile({ path: path.join(__dirname, 'trips.parquet') }, 'parquet', {});
  const loadMs = Date.now() - t0;
  const ci = table.columns.findIndex(c => c.name === 'fare_usd');
  const t1 = Date.now();
  table.setSort(ci, 'desc');
  const sortMs = Date.now() - t1;
  const pages = { 0: table.getRows(0, 200) };
  const meta = { type: 'meta', version: 1, loading: false, columns: columnsMeta(table), rowCount: table.rowCount, viewCount: table.viewCount, info, sort: table.sort, loadMs };
  const script = `
    window.__msgs = ${JSON.stringify({ meta, pages, sortMs })};
    window.acquireVsCodeApi = () => ({ postMessage(m) {
      const D = window.__msgs;
      const send = x => setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: x })), 0);
      if (m.type === 'ready') { send({ type: 'init', fileName: 'trips-2026-03.parquet', format: 'parquet' }); send(D.meta); }
      if (m.type === 'getRows') send({ type: 'rows', reqId: m.reqId, version: 1, start: m.start, rows: D.pages[m.start / 200] || [] });
    }});`;
  const theme = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Monaco,monospace;
  --vscode-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;
  --vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;
  --vscode-editor-selectionBackground:#264f78;--vscode-focusBorder:#0078d4;--vscode-list-hoverBackground:#2a2d2e;--vscode-textLink-foreground:#4daafc;
  --vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-yellow:#cca700;}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}</style><link rel="stylesheet" href="file://${root}/media/webview.css"></head>
<body><div id="app" data-title="trips-2026-03.parquet"></div><script>${script}</script><script src="file://${root}/dist/webview.js"></script></body></html>`;
  fs.writeFileSync(path.join(__dirname, 'harness.html'), html);
  console.log('load', loadMs, 'ms sort', sortMs, 'ms rows', table.rowCount);
})();
