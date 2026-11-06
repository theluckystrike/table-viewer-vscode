// Live harness for the Table Viewer webview: real html.js page (with its CSP), real dist/webview.js,
// real protocol (validateWebviewMessage + createSession) and real readers, all driven over CDP.
// Usage: node scripts/screenshot/live.js <extRoot> <cdpPort> <outDir> <scenario>
//   scenarios: parquet-dark (writes table-parquet-dark.png and table-schema-dark.png), xlsx-light, csv-light, csv-dark, probe (PROBE_FILE=...)
// Data in scripts/screenshot/data (or SHOT_DATA): make it with scripts/screenshot/make-data.sh.
// cdpPort: a Chrome started with ~/bin/agent-chrome (AGENT_CHROME_HEADLESS=1) or any Chrome with --remote-debugging-port.
const fs = require('fs');
const http = require('http');
const path = require('path');
const root = process.argv[2], cdpPort = process.argv[3], out = process.argv[4], scenario = process.argv[5];
const { buildHtml } = require(root + '/src/html');
const { validateWebviewMessage, createSession } = require(root + '/src/core/protocol');
const { loadFile } = require(root + '/src/core/readers');
const { formatFromPath } = require(root + '/src/core/formats');
const DATA = process.env.SHOT_DATA || path.join(__dirname, 'data');

const THEMES = {
  dark: `--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;
  --vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;--vscode-button-secondaryHoverBackground:#3c3c3c;
  --vscode-editor-selectionBackground:#264f78;--vscode-focusBorder:#0078d4;--vscode-list-hoverBackground:#2a2d2e;--vscode-textLink-foreground:#4daafc;--vscode-errorForeground:#f85149;--vscode-editorWarning-background:#cca70033;--vscode-editorWarning-foreground:#cca700;--vscode-inputValidation-errorBackground:#5a1d1d;
  --vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-yellow:#cca700;`,
  light: `--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;
  --vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-button-secondaryHoverBackground:#cccccc;
  --vscode-editor-selectionBackground:#add6ff;--vscode-focusBorder:#005fb8;--vscode-list-hoverBackground:#f2f2f2;--vscode-textLink-foreground:#005fb8;--vscode-errorForeground:#f85149;--vscode-editorWarning-background:#bf880033;--vscode-editorWarning-foreground:#895503;--vscode-inputValidation-errorBackground:#f2dede;
  --vscode-charts-blue:#1a85ff;--vscode-charts-green:#388a34;--vscode-charts-orange:#d18616;--vscode-charts-purple:#652d90;--vscode-charts-yellow:#bf8803;`,
};

const SCENARIOS = {
  'parquet-dark': { theme: 'dark', file: path.join(DATA, 'trips-2026-03.parquet') },
  'xlsx-light': { theme: 'light', file: path.join(DATA, 'earthquakes-2026-10.xlsx') },
  'csv-light': { theme: 'light', file: path.join(DATA, 'earthquakes-2026-10.csv') },
  'csv-dark': { theme: 'dark', file: path.join(DATA, 'earthquakes-2026-10.csv') },
  probe: { theme: 'dark', file: process.env.PROBE_FILE },
};
const sc = SCENARIOS[scenario];
const fileName = path.basename(sc.file);
const format = formatFromPath(sc.file);

const shim = `window.acquireVsCodeApi = () => { let st = null; return {
  postMessage: m => window.hostPost(JSON.stringify(m)), getState: () => st, setState: s => { st = s; } }; };`;
const files = {
  '/webview.js': [path.join(root, 'dist/webview.js'), 'text/javascript'],
  '/webview.css': [path.join(root, 'media/webview.css'), 'text/css'],
};
let NONCE = 'harnessnonceharnessnonceharness0';
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/index.html') {
    let html = buildHtml({ cspSource: `http://127.0.0.1:${server.address().port}`, scriptUri: '/webview.js', styleUri: '/webview.css', title: fileName, nonce: NONCE });
    // VS Code injects theme variables and the API itself; do the same before the webview script.
    html = html.replace('<link rel="stylesheet"', `<link rel="stylesheet" href="/theme.css"><link rel="stylesheet"`)
      .replace('<script nonce', `<script nonce="${NONCE}" src="/shim.js"></script><script nonce`);
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
  }
  if (u === '/shim.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(shim); }
  if (u === '/theme.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(`html{${THEMES[sc.theme]}--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Monaco,monospace;}
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);margin:0;padding:0 20px;}`);
  }
  const f = files[u];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f[1] }); fs.createReadStream(f[0]).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const waits = new Map(); const logs = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
  const toWebview = msg => send('Runtime.evaluate', { expression: `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(msg)} }))` });
  let lastMeta = null, lastView = null, copied = null;
  const session = createSession({ post: m => { if (m.type === 'meta') lastMeta = m; if (m.type === 'view') lastView = m; if (m.type === 'copyResult') { copied = m; toWebview({ type: 'copied', rows: m.rows, format: m.format }); return; } toWebview(m); }, loader: loadFile });
  let opened = false;
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === 'hostPost') {
      const msg = validateWebviewMessage(JSON.parse(m.params.payload));
      if (!msg) return;
      if (msg.type === 'ready') {
        toWebview({ type: 'init', fileName, format });
        if (!opened) { opened = true; session.handle({ type: 'open', source: { path: sc.file }, format, options: { maxRows: 1000000, maxFileSizeMB: 512, maxExcelSizeMB: 50 } }); }
        else session.handle({ type: 'resync' });
        return;
      }
      if (msg.type === 'copy') msg.maxRows = 100000;
      session.handle(msg);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === 'Log.entryAdded') logs.push('LOG ' + m.params.entry.level + ' ' + m.params.entry.text);
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Runtime.addBinding', { name: 'hostPost' });
  const W = Number(process.env.W || 1280), H = Number(process.env.H || 720);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  const t0 = Date.now();
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  // wait for the full load and the first rows drawn
  for (let i = 0; i < 600; i++) { await sleep(100); if (lastMeta && !lastMeta.loading) { const ok = await evalJs(`!!document.querySelector('.body .row .cell:not(.gutter):not(.pending)')`).catch(() => false); if (ok) break; } }
  const firstPaintMs = Date.now() - t0;
  await sleep(400);
  const box = async (sel, idx = 0) => JSON.parse(await evalJs(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.x + Math.min(10, b.width / 2), y: b.y + b.height / 2 }); })()`));
  const cellPos = async (r, c) => JSON.parse(await evalJs(`(() => { const b = document.querySelectorAll('.body .row:not([hidden])')[${r}].querySelectorAll('.cell')[${c}].getBoundingClientRect(); return JSON.stringify({x: b.x + 10, y: b.y + 8}); })()`));
  const click = async (p, mod = 0) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mod });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mod });
  };
  const typeText = async text => { for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); };
  const waitView = async () => { const v = lastView; for (let i = 0; i < 100 && lastView === v; i++) await sleep(50); await sleep(500); };
  const btn = async text => JSON.parse(await evalJs(`(() => { const e = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)} && b.offsetParent); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64')); console.log('shot', name); };
  const headerIdx = async name => evalJs(`[...document.querySelectorAll('.hcell')].findIndex(h => h.textContent.startsWith(${JSON.stringify(name)}))`);
  const sortBy = async (name, times = 1) => { const i = await headerIdx(name); for (let k = 0; k < times; k++) { await click(await box('.hcell .name, .hcell', i)); await waitView(); } };
  const filterCol = async (name, text) => { const i = await headerIdx(name); await click(await box('.fcell input', i)); await typeText(text); await waitView(); };
  const result = { scenario, file: fileName, firstPaintMs, loadMs: lastMeta && lastMeta.loadMs, rows: lastMeta && lastMeta.rowCount, cols: lastMeta && lastMeta.columns.length };

  if (scenario === 'parquet-dark') {
    await sortBy('fare_usd', 2);
    await click(await cellPos(2, 3)); await click(await cellPos(6, 6), 8); await sleep(300);
    await shot('table-parquet-dark.png');
    await click(await btn('Schema'));
    await sleep(500);
    await shot('table-schema-dark.png');
  } else if (scenario === 'xlsx-light') {
    await sortBy('magnitude', 2);
    await sleep(300);
    await shot('table-excel-light.png');
  } else if (scenario === 'csv-light' || scenario === 'csv-dark') {
    await filterCol('mag', '>=4.5');
    await click(await box('.search')); await typeText('Japan'); await waitView();
    await sortBy('depth', 2);
    await click(await cellPos(0, 1)); await click(await cellPos(3, 5), 8); await sleep(200);
    await click(await btn('Copy JSON')); await sleep(500);
    result.copiedRows = copied && copied.rows; result.copiedHead = copied && copied.text.slice(0, 200);
    await shot(`table-csv-${sc.theme}.png`);
  } else if (scenario === 'probe') {
    // scroll test: time 20 scroll frames
    const ts = Date.now();
    for (let i = 1; i <= 20; i++) { await evalJs(`document.querySelector('.grid, #grid, .scroller') && ((document.querySelector('.grid, #grid, .scroller')).scrollTop = ${i * 300})`); await evalJs('new Promise(r => requestAnimationFrame(() => r(1)))'); }
    result.scroll20Ms = Date.now() - ts;
    await evalJs(`document.querySelector('.grid').scrollLeft = 250000`); await sleep(300);
    result.hAlign = await evalJs(`(() => { const out = []; const row = document.querySelector('.body .row:not([hidden])');
      for (const cell of [...row.querySelectorAll('.cell:not(.gutter)')].slice(2, 6)) { const b = cell.getBoundingClientRect();
        const h = document.elementsFromPoint(b.x + b.width / 2, 40).find(e => e.classList.contains('hcell'));
        out.push([cell._c, h && h.dataset.col]); } return JSON.stringify(out); })()`);
    await shot('probe-h.png');
    await evalJs(`document.querySelector('.grid').scrollTop = 0`);
    result.domCells = await evalJs(`document.querySelectorAll('.cell').length`);
    result.inputs = await evalJs(`document.querySelectorAll('input').length`);
    await shot('probe.png');
  }
  result.viewCount = lastView ? lastView.viewCount : null;
  result.consoleErrors = logs;
  console.log(JSON.stringify(result));
  await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
  ws.close(); server.close();
  process.exit(0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
