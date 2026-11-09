'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage } = require('./core/protocol');
const { formatFromPath } = require('./core/formats');
const config = require('./config');
const { verifyLicense, normalizeKey } = require('./license');
const { entitlement, effectiveLimits, isEnabled, canUse } = require('./pro');
const { createSponsorsRail } = require('./sponsors');
const { resolveQueryFiles, pushHistory, historyFor } = require('./queryhost');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const { registerCompare } = require('./compare');

let rating = { success() {}, failure() {} };

const VIEW_TYPE = 'tableViewer.table';
const TEXT_VIEW_TYPE = 'tableViewer.tableText';
const STATE_MESSAGES = new Set(['meta', 'view', 'rows', 'cell']);
// Delimiter and header choice per CSV/TSV file, kept in workspace state (newest 200 files).
const CSV_OPTIONS_KEY = 'tableViewer.csvOptions';
const CSV_OPTIONS_MAX = 200;
const panels = new Set();
let activePanel = null;
// License state. Checked offline against the public key in config; loaded from SecretStorage on activate.
let licenseCheck = null;
let licenseLoaded = Promise.resolve();
// GitHub Sponsors unlock (Zovo Pro). Created only when the Pro switch is on, so the shipped build has no rail at all.
let sponsors = null;
const SPONSORS_SKU = 'xlsx-pro';

function settings() {
  const c = vscode.workspace.getConfiguration('tableViewer');
  return {
    maxRows: c.get('maxRows', 1000000),
    maxFileSizeMB: c.get('maxFileSizeMB', 512),
    maxExcelSizeMB: c.get('maxExcelSizeMB', 50),
    maxCopyRows: c.get('maxCopyRows', 100000),
    queryMemoryMB: c.get('queryMemoryMB', 512),
    excelFormats: c.get('excelFormats', true) !== false,
  };
}

function autoReloadOn() {
  return vscode.workspace.getConfiguration('tableViewer').get('autoReload', true) !== false;
}

// Wait this long after the last change event before reading the file again (writers often save in steps).
const RELOAD_DEBOUNCE_MS = 400;

/** Names of the size settings the user set (so Pro defaults do not override them). */
function userSetKeys() {
  const c = vscode.workspace.getConfiguration('tableViewer');
  if (typeof c.inspect !== 'function') return [];
  return ['maxRows', 'maxFileSizeMB', 'maxExcelSizeMB'].filter(k => {
    const i = c.inspect(k);
    return !!i && [i.globalValue, i.workspaceValue, i.workspaceFolderValue].some(v => v !== undefined);
  });
}

function currentEntitlement() {
  // Re-check the stored key each time, so a yearly key stops on its end date without a restart.
  if (licenseCheck && licenseCheck.key) licenseCheck = { ...verifyLicense(licenseCheck.key, { publicKey: config.LICENSE_PUBLIC_KEY }), key: licenseCheck.key };
  return entitlement(config, licenseCheck, !!(sponsors && sponsors.isPro(SPONSORS_SKU)));
}

/** What the webview needs to draw the Pro badge and buttons. Nothing when Pro is switched off. */
function proState(ent) {
  if (!ent.enabled) return { type: 'pro', enabled: false };
  const out = { type: 'pro', enabled: true, licensed: ent.licensed, plan: ent.plan, expires: ent.expires };
  if (!ent.licensed && licenseCheck && licenseCheck.reason === 'expired') out.note = licenseCheck.message;
  return out;
}

function setLicense(check) {
  licenseCheck = check;
  const ent = currentEntitlement();
  for (const p of panels) p.setPro(ent);
}

const EXPORT_CHOICES = [
  { id: 'csv', label: 'CSV', description: 'comma-separated, with a header row' },
  { id: 'tsv', label: 'TSV', description: 'tab-separated, with a header row' },
  { id: 'json', label: 'JSON', description: 'one array of objects' },
  { id: 'jsonl', label: 'JSON Lines', description: 'one object per line' },
  { id: 'parquet', label: 'Parquet', description: 'typed and compressed, for pandas, DuckDB, Spark or this viewer', pro: 'save-parquet' },
];

class TableEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    // Before the HTML is set, so the webview's first 'ready' cannot arrive before the listener exists.
    await licenseLoaded;
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('tableViewer') };
    const uri = document.uri;
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'tableViewer'),
    });

    let ent = currentEntitlement();
    const opts = effectiveLimits(settings(), ent, userSetKeys());
    delete opts.capped;
    const format = formatFromPath(uri.path);
    const isText = format === 'csv' || format === 'tsv';
    const fileKey = uri.toString();
    if (isText) Object.assign(opts, savedCsvOptions(ctx, fileKey));
    let exportTarget = null;
    let queryShown = false; // the grid shows a query result (worker meta with info.query)
    const postHistory = () => toWebview({ type: 'queryHistory', items: historyFor(ctx, fileKey) });
    let worker = null;
    let disposed = false;
    let webviewReady = false;
    let counted = false; // one success per opened tab, for the rating prompt
    let fatal = null; // host-side error (unsupported file, reader crash), resent to a reloaded webview
    const queue = [];
    // While the webview is gone (tab hidden) or not ready yet, keep only one-off notices. Table state
    // (meta, view, rows) is rebuilt with a 'resync' when the webview says 'ready' again.
    const toWebview = msg => {
      if (disposed) return;
      if (webviewReady) { panel.webview.postMessage(msg); return; }
      if (!STATE_MESSAGES.has(msg.type) && !(msg.type === 'error' && !msg.transient)) queue.push(msg);
    };
    const failHost = message => { fatal = { type: 'error', message }; rating.failure(); toWebview(fatal); };

    const readSource = async () => {
      if (uri.scheme === 'file') return { path: uri.fsPath };
      const stat = await vscode.workspace.fs.stat(uri);
      const limit = (format === 'excel' ? opts.maxExcelSizeMB : opts.maxFileSizeMB) * 1024 * 1024;
      if (stat.size > limit) throw new Error(`This remote file is ${(stat.size / 1048576).toFixed(0)} MB. Files that are not on disk are read whole, and the limit is ${Math.round(limit / 1048576)} MB.`);
      return { bytes: await vscode.workspace.fs.readFile(uri), name: uri.path };
    };

    // Read the file again in the same worker. Sort, filters and the sheet carry over (see protocol.reload).
    let reloadTimer = null;
    const reloadNow = async (manual) => {
      if (disposed || !worker || fatal) return;
      try {
        worker.postMessage({ type: 'reload', source: await readSource(), manual: manual === true });
      } catch (e) {
        toWebview({ type: 'error', message: `The file changed but could not be read again: ${e.message || e}`, transient: true });
      }
    };
    const scheduleReload = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadNow, RELOAD_DEBOUNCE_MS);
    };
    let watcher = null;
    if (format && uri.scheme === 'file' && typeof vscode.workspace.createFileSystemWatcher === 'function') {
      // One watcher for this one file. It also sees changes from git, scripts and agents outside VS Code.
      watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name));
      const onChange = () => { if (autoReloadOn()) scheduleReload(); };
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(() => toWebview({ type: 'error', message: 'The file was deleted or moved on disk. The table shows the last version that was read.', transient: true }));
    }

    const startWorker = async () => {
      const source = await readSource();
      worker = new Worker(path.join(ctx.extensionPath, 'dist', 'worker.js'), {
        resourceLimits: { maxOldGenerationSizeMb: 4096 },
      });
      worker.on('message', msg => {
        if (msg && msg.type === 'error' && !msg.transient) rating.failure();
        if (!counted && opensWithData(msg)) { counted = true; rating.success(); }
        if (msg && msg.type === 'copyResult') return onCopy(msg);
        if (msg && msg.type === 'exportResult') return onExport(msg);
        if (msg && msg.type === 'meta') queryShown = !!(msg.info && msg.info.query);
        toWebview(msg);
      });
      worker.on('error', e => failHost(`The reader stopped: ${e.message}`));
      worker.on('exit', code => {
        if (!disposed && code !== 0 && !fatal) failHost('The reader ran out of memory or crashed. Lower tableViewer.maxRows and reopen the file.');
      });
      worker.postMessage({ type: 'open', source, format, options: opts, pro: isEnabled('export', ent) });
    };

    const proError = message => toWebview({ type: 'error', message, code: 'PRO', transient: true });

    const startExport = async suggested => {
      if (!isEnabled('export', ent)) return proError('Export is a Table Viewer Pro feature.');
      if (exportTarget) return proError('An export is already running.');
      let fmt = suggested;
      if (!fmt) {
        const items = EXPORT_CHOICES.map(c => ({ ...c, description: c.pro && ent.enabled && !ent.licensed ? `${c.description} (Pro)` : c.description }));
      const pick = await vscode.window.showQuickPick(items, { title: queryShown ? 'Save the query result' : 'Export the rows in view', placeHolder: 'Pick a format' });
        if (!pick) return undefined;
        fmt = pick.id;
      }
      const choice = EXPORT_CHOICES.find(c => c.id === fmt);
      if (choice.pro && !canUse(choice.pro, ent)) return proError('Saving as Parquet is a Zovo Pro feature. CSV, TSV, JSON and JSON Lines are free.');
      const base = name.replace(/\.[^.]+$/, '');
      const dir = uri.scheme === 'file' ? vscode.Uri.joinPath(uri, '..') : undefined;
      const target = await vscode.window.showSaveDialog({
        title: `Export ${choice.label}`,
        saveLabel: 'Export',
        defaultUri: dir ? vscode.Uri.joinPath(dir, `${base}-${queryShown ? 'query' : 'export'}.${fmt}`) : undefined,
        filters: { [choice.label]: [fmt] },
      });
      if (!target || !worker) return undefined;
      exportTarget = target;
      toWebview({ type: 'exporting', format: fmt });
      worker.postMessage({ type: 'export', format: fmt, path: target.scheme === 'file' ? target.fsPath : undefined });
      return undefined;
    };

    const onExport = async msg => {
      const target = exportTarget;
      exportTarget = null;
      if (!msg.ok) {
        toWebview({ type: 'exported', ok: false });
        vscode.window.showErrorMessage(`Export failed: ${msg.error}`);
        return;
      }
      try {
        if (typeof msg.text === 'string' && target) await vscode.workspace.fs.writeFile(target, Buffer.from(msg.text, 'utf8'));
      } catch (e) {
        toWebview({ type: 'exported', ok: false });
        vscode.window.showErrorMessage(`Export failed: ${e.message || e}`);
        return;
      }
      toWebview({ type: 'exported', ok: true, rows: msg.rows, bytes: msg.bytes, format: msg.format });
      const file = target ? path.posix.basename(target.path) : 'the file';
      vscode.window.showInformationMessage(`Exported ${Number(msg.rows).toLocaleString('en-US')} rows to ${file}.`);
    };

    const onCopy = async msg => {
      await vscode.env.clipboard.writeText(msg.text || '');
      const fmt = msg.format === 'md' ? 'Markdown' : String(msg.format).toUpperCase();
      const note = msg.truncated ? ` The selection was cut to the first ${msg.rows.toLocaleString('en-US')} rows (tableViewer.maxCopyRows).` : '';
      toWebview({ type: 'copied', rows: msg.rows, format: msg.format, truncated: !!msg.truncated });
      if (msg.truncated) vscode.window.showWarningMessage(`Copied ${msg.rows.toLocaleString('en-US')} rows as ${fmt}.${note}`);
    };

    // Query panel: check the files a query names (workspace trust, inside the workspace), keep the history,
    // and hand the query to the worker. The worker never sees a path the host did not check.
    const startQuery = async sql => {
      if (!worker) return;
      pushHistory(ctx, fileKey, sql);
      postHistory();
      let files = {};
      try {
        files = await resolveQueryFiles(vscode, uri, sql);
      } catch (e) {
        if (e && e.code === 'SQL') { toWebview({ type: 'queryDone', ok: false, error: e.message }); return; }
        throw e;
      }
      const s = settings();
      worker.postMessage({
        type: 'query', sql, files, fileName: name,
        allowStream: canUse('large-files', ent), allowFiles: canUse('query-join-files', ent),
        memCapMB: Math.max(64, Number(s.queryMemoryMB) || 512), maxResultRows: Math.max(1000, Number(s.maxRows) || 1000000),
      });
    };

    const state = {
      panel,
      uri,
      copy: format => panel.webview.postMessage({ type: 'requestCopy', format }),
      openQuery: () => panel.webview.postMessage({ type: 'openQuery' }),
      setPro: next => {
        ent = next;
        if (worker) worker.postMessage({ type: 'entitlement', pro: isEnabled('export', ent) });
        toWebview(proState(ent));
      },
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
        if (ent.enabled) panel.webview.postMessage(proState(ent));
        while (queue.length) panel.webview.postMessage(queue.shift());
        panel.webview.postMessage({ type: 'queryHistory', items: historyFor(ctx, fileKey) });
        if (fatal) panel.webview.postMessage(fatal);
        else if (worker) worker.postMessage({ type: 'resync' });
        return;
      }
      if (msg.type === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'tableViewer');
        return;
      }
      if (msg.type === 'openProPage') {
        if (ent.enabled) vscode.env.openExternal(vscode.Uri.parse(config.PRO_URL));
        return;
      }
      if (msg.type === 'export') { startExport(msg.format); return; }
      if (msg.type === 'reload') { clearTimeout(reloadTimer); reloadNow(true); return; }
      if (msg.type === 'compare') { pickCompare(uri); return; }
      if (msg.type === 'copyText') {
        Promise.resolve(vscode.env.clipboard.writeText(msg.text))
          .then(() => toWebview({ type: 'copiedText', chars: msg.text.length }), () => {});
        return;
      }
      if (msg.type === 'query') { startQuery(msg.sql); return; }
      if (msg.type === 'csvOptions' && isText) saveCsvOptions(ctx, fileKey, msg);
      if (!worker) return;
      if (msg.type === 'copy') msg.maxRows = settings().maxCopyRows;
      worker.postMessage(msg);
    });

    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(reloadTimer);
      if (watcher) watcher.dispose();
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

/** The delimiter and header choice saved for one file, as reader options ({} when none). */
function savedCsvOptions(context, key) {
  const all = (context.workspaceState && context.workspaceState.get(CSV_OPTIONS_KEY)) || {};
  const o = all[key];
  if (!o || typeof o !== 'object') return {};
  const out = {};
  if (typeof o.delimiter === 'string') out.delimiter = o.delimiter;
  if (typeof o.header === 'boolean') out.header = o.header;
  if (typeof o.encoding === 'string') out.encoding = o.encoding;
  return out;
}

/** Remember the choice. Back to auto with a header row removes the entry. */
function saveCsvOptions(context, key, msg) {
  if (!context.workspaceState) return;
  const all = { ...(context.workspaceState.get(CSV_OPTIONS_KEY) || {}) };
  delete all[key];
  const enc = typeof msg.encoding === 'string' && msg.encoding !== 'auto' ? msg.encoding : null;
  if (msg.delimiter !== 'auto' || msg.header === false || enc) {
    all[key] = { delimiter: msg.delimiter, header: msg.header };
    if (enc) all[key].encoding = enc;
  }
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length - CSV_OPTIONS_MAX; i++) delete all[keys[i]];
  context.workspaceState.update(CSV_OPTIONS_KEY, all);
}

async function loadStoredLicense(context) {
  if (!config.PRO_ENABLED || !context.secrets) return;
  licenseCheck = null;
  try {
    const key = await context.secrets.get(config.LICENSE_SECRET);
    if (key) licenseCheck = { ...verifyLicense(key, { publicKey: config.LICENSE_PUBLIC_KEY }), key };
  } catch {
    licenseCheck = null;
  }
}

async function enterLicenseKey(context) {
  if (!config.PRO_ENABLED) {
    vscode.window.showInformationMessage('Table Viewer Pro is not available yet. Every feature in this version is free.');
    return;
  }
  const check = v => verifyLicense(v, { publicKey: config.LICENSE_PUBLIC_KEY });
  const raw = await vscode.window.showInputBox({
    title: 'Table Viewer: Enter license key',
    prompt: 'Paste the key from your purchase email. It starts with TVPRO1. The check runs offline.',
    ignoreFocusOut: true,
    validateInput: v => (!v || !v.trim() ? null : check(v).valid ? null : check(v).message),
  });
  if (raw === undefined || !raw.trim()) return;
  const res = check(raw);
  if (!res.valid) { vscode.window.showErrorMessage(res.message); return; }
  const key = normalizeKey(raw);
  await context.secrets.store(config.LICENSE_SECRET, key);
  setLicense({ ...res, key });
  const until = res.license.expires ? ` until ${res.license.expires}` : '';
  vscode.window.showInformationMessage(`Table Viewer Pro is on${until}. Thank you! Reopen a file to load past the free size limits.`);
}

async function removeLicenseKey(context) {
  if (!config.PRO_ENABLED || !context.secrets) return;
  const ok = await vscode.window.showWarningMessage('Remove the Zovo Pro license key and the GitHub Sponsors unlock from this machine?', { modal: true }, 'Remove');
  if (ok !== 'Remove') return;
  await context.secrets.delete(config.LICENSE_SECRET);
  if (sponsors) await sponsors.remove();
  setLicense(null);
  vscode.window.showInformationMessage('The license key is removed. You can enter it again at any time.');
}

/** "Unlock Zovo Pro with GitHub Sponsors": one GitHub sign-in and one question to GitHub, only on this click. */
async function unlockWithSponsors() {
  if (!config.PRO_ENABLED || !sponsors) {
    vscode.window.showInformationMessage('Every feature in this version of the table viewer is free. There is nothing to unlock.');
    return;
  }
  const r = await sponsors.unlock();
  if (r.reason === 'cancelled') return;
  if (r.pro) { setLicense(licenseCheck); vscode.window.showInformationMessage('Zovo Pro is on. Thank you.'); return; }
  if (r.reason === 'not-sponsor' || r.reason === 'below-minimum') {
    const pick = await vscode.window.showInformationMessage(r.message, 'Open GitHub Sponsors');
    if (pick) sponsors.openSponsorsPage();
    return;
  }
  vscode.window.showWarningMessage(`${r.message} Nothing changed.`);
}

/** Toolbar "Compare" button: pick Git HEAD or another file. */
async function pickCompare(uri) {
  const items = [
    { label: '$(git-commit) Compare with Git HEAD', description: 'the committed version of this file', cmd: 'tableViewer.compareWithHead' },
    { label: '$(files) Compare with Another Table File...', description: 'CSV, TSV, Parquet or Excel', cmd: 'tableViewer.compareWithFile' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Compare ' + path.posix.basename(uri.path), placeHolder: 'Shows changed, added and removed rows in the diff editor' });
  if (pick) await vscode.commands.executeCommand(pick.cmd, uri);
}

/** One-shot worker that turns a table file into CSV text for the diff editor. */
function tableText(context, source, format, name) {
  const s = settings();
  const max = vscode.workspace.getConfiguration('tableViewer').get('maxCompareRows', 100000);
  return new Promise(resolve => {
    let done = false;
    const w = new Worker(path.join(context.extensionPath, 'dist', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    const finish = r => { if (done) return; done = true; w.terminate(); resolve(r); };
    w.on('message', m => { if (m && m.type === 'textResult') finish(m); });
    w.on('error', e => finish({ ok: false, error: e.message }));
    w.on('exit', () => finish({ ok: false, error: 'The reader stopped (out of memory?). Lower tableViewer.maxCompareRows.' }));
    w.postMessage({ type: 'toText', source, format, options: { maxFileSizeMB: s.maxFileSizeMB, maxExcelSizeMB: s.maxExcelSizeMB }, maxRows: max, name });
  });
}

async function compareSource(src) {
  if (src.bytes) return { bytes: src.bytes };
  const uri = src.uri;
  if (uri.scheme === 'file') return { path: uri.fsPath };
  return { bytes: await vscode.workspace.fs.readFile(uri) };
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.table-viewer-vscode', section: 'tableViewer', name: 'XLSX Viewer' });
  registerSupport({ vscode, context, prefix: 'tableViewer', selfId: 'zovo.table-viewer-vscode' });
  const provider = new TableEditorProvider(context);
  registerCompare({
    vscode, context,
    toText: async (src, format, name) => {
      if (!format) return { ok: false, error: 'Not a table file.' };
      try { return await tableText(context, await compareSource(src), format, name); } catch (e) { return { ok: false, error: e.message || String(e) }; }
    },
    maxBytes: p => { const s = settings(); return (formatFromPath(p) === 'excel' ? s.maxExcelSizeMB : s.maxFileSizeMB) * 1024 * 1024; },
    activeUri: () => (activePanel ? activePanel.uri : null),
  });
  vscode.commands.executeCommand('setContext', 'tableViewer.proEnabled', !!config.PRO_ENABLED);
  if (config.PRO_ENABLED && context.secrets) {
    sponsors = createSponsorsRail({ vscode, context });
    context.subscriptions.push(sponsors.onDidChange(() => setLicense(licenseCheck)));
  }
  licenseLoaded = Promise.all([loadStoredLicense(context), sponsors ? sponsors.ready : null]);
  if (context.secrets && context.secrets.onDidChange) {
    // Another window entered or removed the key.
    context.subscriptions.push(context.secrets.onDidChange(e => {
      if (e.key === config.LICENSE_SECRET) licenseLoaded = loadStoredLicense(context).then(() => setLicense(licenseCheck));
    }));
  }
  context.subscriptions.push(
    ...[VIEW_TYPE, TEXT_VIEW_TYPE].map(id => vscode.window.registerCustomEditorProvider(id, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    })),
    vscode.commands.registerCommand('tableViewer.openInTableViewer', async uri => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) { vscode.window.showInformationMessage('Open a CSV, TSV, Parquet or Excel file first.'); return; }
      if (target.scheme === 'table-viewer-diff') { vscode.window.showInformationMessage('This is the text of a comparison. Open the data file itself in Table Viewer.'); return; }
      const fmt = formatFromPath(target.path);
      if (!fmt) { vscode.window.showInformationMessage('Table Viewer opens .csv, .tsv, .parquet, .xlsx, .xls and .ods files.'); return; }
      await vscode.commands.executeCommand('vscode.openWith', target, fmt === 'csv' || fmt === 'tsv' ? TEXT_VIEW_TYPE : VIEW_TYPE);
    }),
    vscode.commands.registerCommand('tableViewer.copySelectionAsCsv', () => activePanel && activePanel.copy('csv')),
    vscode.commands.registerCommand('tableViewer.copySelectionAsJson', () => activePanel && activePanel.copy('json')),
    vscode.commands.registerCommand('tableViewer.copySelectionAsMarkdown', () => activePanel && activePanel.copy('md')),
    vscode.commands.registerCommand('tableViewer.enterLicenseKey', () => enterLicenseKey(context)),
    vscode.commands.registerCommand('tableViewer.removeLicenseKey', () => removeLicenseKey(context)),
    vscode.commands.registerCommand('tableViewer.unlockWithSponsors', () => unlockWithSponsors()),
    vscode.commands.registerCommand('tableViewer.newQuery', () => activePanel && activePanel.openQuery()),
    vscode.commands.registerCommand('tableViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.table-viewer-vscode#tableViewer.start', false)),
  );
}

function deactivate() {}

/**
 * A table with at least one column counts as a good open for the rating ask. With no columns the view shows
 * "This file is empty", "no rows or columns" or an error, and the ask must not come next to that note.
 */
// A good open is the meta of a finished load (loading false) with at least one column. The streaming reader
// first sends a preview meta (loading true); that one does not count, because the full read can still fail
// (VER10: a damaged 2 MB workbook showed 'could not be read' after its preview had already counted and asked).
function opensWithData(msg) {
  return !!(msg && msg.type === 'meta' && !msg.loading && Array.isArray(msg.columns) && msg.columns.length > 0);
}

module.exports = {
  savedCsvOptions, saveCsvOptions, activate, deactivate, TableEditorProvider, opensWithData };
