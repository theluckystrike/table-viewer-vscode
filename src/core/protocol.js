'use strict';
// Message protocol shared by the webview, the extension host and the worker.
// Webview -> host: ready, getRows, sort, filter, copy, sheet, openSettings, openProPage, stats, export,
//   csvOptions (delimiter and header row for CSV/TSV), getCell (full text of one cell), copyText
// Host -> worker: open, getRows, sort, filter, copy, sheet, resync, entitlement, stats, export, csvOptions, getCell,
//   reload (the file changed on disk: read it again, keep sort, filters and sheet), formats (Excel number formats on/off)
// Worker -> host -> webview: meta, rows, view, copyResult, stats, exportResult, cell, error
// Host -> webview: init, pro (Pro switch and license state), copied, exported
// The SQL filter (filter.query), stats and export are free since 0.4. 'formulas' shows Excel formula text.
// The webview is destroyed when its tab is hidden (retainContextWhenHidden: false) and sends 'ready'
// again when shown. The host then sends 'resync' and the worker answers with a full 'meta' that carries
// the current sort, filters and sheet, plus the last load error, so the new webview can rebuild its state.

const MAX_PAGE = 2000;
const MAX_FILTER_LEN = 500;
const COPY_FORMATS = new Set(['csv', 'tsv', 'json', 'md']);
const EXPORT_FORMATS = new Set(['csv', 'tsv', 'json', 'jsonl', 'parquet']);
const MAX_SQL_LEN = 20000;
const MAX_QUERY_LEN = 2000;
// 'auto' detects the delimiter. The others match readers.CSV_DELIMITERS.
const CSV_DELIMITER_CHOICES = new Set(['auto', ',', '\t', ';', '|', ':']);
// 'auto' detects the encoding (BOM, UTF-8, then Shift_JIS / GB18030 / EUC-KR / Big5 / Windows-1252). See readers.CSV_ENCODINGS.
const { CSV_ENCODINGS } = require('./encoding');
const MAX_COPY_TEXT = 1000000;

function int(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** Validate and normalize a message coming from the webview. Returns null for anything unknown. */
function validateWebviewMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
  switch (msg.type) {
    case 'ready':
    case 'openSettings':
    case 'openProPage':
    case 'stats':
    case 'reload':
    case 'compare':
    case 'queryCancel':
    case 'queryBack':
      return { type: msg.type };
    case 'query':
      return typeof msg.sql === 'string' && msg.sql.trim() ? { type: 'query', sql: msg.sql.slice(0, MAX_SQL_LEN) } : null;
    case 'formats':
      return typeof msg.on === 'boolean' ? { type: 'formats', on: msg.on } : null;
    case 'formulas':
      return typeof msg.on === 'boolean' ? { type: 'formulas', on: msg.on } : null;
    case 'export':
      // The host asks for the format and the file; the webview may suggest a format.
      return EXPORT_FORMATS.has(msg.format) ? { type: 'export', format: msg.format } : { type: 'export' };
    case 'getRows':
      return {
        type: 'getRows',
        reqId: int(msg.reqId, 0, Number.MAX_SAFE_INTEGER, 0),
        start: int(msg.start, 0, Number.MAX_SAFE_INTEGER, 0),
        count: int(msg.count, 0, MAX_PAGE, 0),
      };
    case 'sort': {
      if (msg.col === null || msg.col === undefined || msg.dir === null || msg.dir === undefined) return { type: 'sort', col: null, dir: null };
      const col = Number(msg.col);
      if (!Number.isInteger(col) || col < 0 || col > 1e6 || (msg.dir !== 'asc' && msg.dir !== 'desc')) return null;
      return { type: 'sort', col, dir: msg.dir };
    }
    case 'filter': {
      const columns = {};
      if (msg.columns && typeof msg.columns === 'object') {
        for (const [k, v] of Object.entries(msg.columns)) {
          const c = Number(k);
          if (!Number.isInteger(c) || c < 0 || c > 1e6) continue;
          if (typeof v !== 'string' || !v.trim()) continue;
          columns[c] = v.slice(0, MAX_FILTER_LEN);
        }
      }
      const out = { type: 'filter', global: typeof msg.global === 'string' ? msg.global.slice(0, MAX_FILTER_LEN) : '', columns };
      if (typeof msg.query === 'string' && msg.query.trim()) out.query = msg.query.slice(0, MAX_QUERY_LEN);
      return out;
    }
    case 'copy': {
      if (!COPY_FORMATS.has(msg.format)) return null;
      const s = msg.sel || {};
      const sel = {
        r0: int(s.r0, 0, Number.MAX_SAFE_INTEGER, 0), r1: int(s.r1, 0, Number.MAX_SAFE_INTEGER, 0),
        c0: int(s.c0, 0, 1e6, 0), c1: int(s.c1, 0, 1e6, 0), header: s.header !== false,
      };
      return { type: 'copy', format: msg.format, sel };
    }
    case 'sheet':
      return typeof msg.name === 'string' ? { type: 'sheet', name: msg.name.slice(0, 300) } : null;
    case 'csvOptions': {
      if (!CSV_DELIMITER_CHOICES.has(msg.delimiter) || typeof msg.header !== 'boolean') return null;
      const out = { type: 'csvOptions', delimiter: msg.delimiter, header: msg.header };
      if (msg.encoding !== undefined) {
        if (msg.encoding !== 'auto' && !CSV_ENCODINGS.includes(msg.encoding)) return null;
        out.encoding = msg.encoding;
      }
      return out;
    }
    case 'getCell':
      return {
        type: 'getCell',
        reqId: int(msg.reqId, 0, Number.MAX_SAFE_INTEGER, 0),
        row: int(msg.row, 0, Number.MAX_SAFE_INTEGER, 0),
        col: int(msg.col, 0, 1e6, 0),
      };
    case 'copyText':
      return typeof msg.text === 'string' ? { type: 'copyText', text: msg.text.slice(0, MAX_COPY_TEXT) } : null;
    default:
      return null;
  }
}

/** Column info sent to the webview. */
function columnsMeta(table) {
  return table.columns.map(c => ({ name: c.name, type: c.type, detail: c.detail || '' }));
}

/**
 * Worker-side session. post(msg) sends to the host. loader(source, format, options, onPreview, sheet) loads a table.
 */
/**
 * engine: the query engine (src/core/sql/engine.js), passed in by the worker. Without it, queries and Parquet export
 * answer with a message (the extension host imports this file only to validate messages).
 */
function createSession({ post, loader, now = () => Date.now(), writeFile = null, engine = null }) {
  let table = null;
  let info = {};
  let loadSheet = null;
  let loading = false;
  let version = 0;
  let started = 0;
  let loadMs = null; // time of the full load, resent on resync
  let lastError = null; // non-transient error, resent on resync
  // SQL filter, column stats and export are free since 0.4 (no paywall). The flag stays so an old host that
  // sends pro: false still works, but nothing is locked by it any more.
  let pro = true;
  let lastOpen = null; // the 'open' message, reused when the CSV options change
  let formatted = true; // Excel number formats shown (tableViewer.excelFormats, toolbar switch)
  let showFormulas = false; // Excel: formula text instead of results (toolbar switch "Formulas")
  let pendingReload = null; // a reload asked for while a load was running
  // Query panel: while a result is shown, `table`/`info` hold the result and `saved` holds the file.
  let saved = null;
  let running = null; // {id, ctx} of the query that is running
  let queryId = 0;
  const proOnly = what => post({ type: 'error', message: `${what} is a Table Viewer Pro feature.`, code: 'PRO', transient: true });

  const sendMeta = (extra = {}) => {
    post({
      type: 'meta', version, loading,
      columns: table ? columnsMeta(table) : [],
      rowCount: table ? table.rowCount : 0,
      viewCount: table ? table.viewCount : 0,
      info, sort: table ? table.sort : null,
      filters: filtersOut(),
      formatted,
      showFormulas,
      ...extra,
    });
  };

  function filtersOut() {
    if (!table || !table.filters) return { global: '', columns: {} };
    const f = { global: table.filters.global, columns: { ...table.filters.columns } };
    if (table.filters.query) f.query = table.filters.query;
    return f;
  }

  /** Show the file again (after a query result). */
  function restoreFile() {
    if (!saved) return false;
    table = saved.table;
    info = saved.info;
    saved = null;
    return true;
  }

  async function open(msg) {
    restoreFile();
    lastOpen = msg;
    loading = true;
    started = now();
    const options = msg.options || {};
    if (typeof options.excelFormats === 'boolean') formatted = options.excelFormats;
    try {
      const res = await loader(msg.source, msg.format, options, (preview, previewInfo) => {
        table = preview;
        info = previewInfo;
        version++;
        sendMeta({ firstRowsMs: now() - started });
      });
      table = res.table;
      table.formatted = formatted;
      table.showFormulas = showFormulas;
      info = res.info;
      loadSheet = res.loadSheet || null;
      loading = false;
      lastError = null;
      version++;
      loadMs = now() - started;
      sendMeta({ loadMs });
    } catch (e) {
      loading = false;
      fail(e);
    }
    return runPendingReload();
  }

  function runPendingReload() {
    if (!pendingReload) return undefined;
    const next = pendingReload;
    pendingReload = null;
    return reload(next);
  }

  /**
   * The file changed on disk (or the user pressed Reload). Read it again without a preview, so the old
   * rows stay on screen until the new ones are ready. Sort, filters and the Excel sheet carry over by
   * column name. If the new read fails (a half-written file), the last good table stays and a transient
   * notice says so; the next change event tries again.
   */
  async function reload(msg) {
    if (!lastOpen) return undefined;
    if (loading) { pendingReload = msg; return undefined; }
    restoreFile();
    const prev = table ? {
      names: table.columns.map(c => c.name),
      sort: table.sort,
      filters: table.filters,
      sheet: info && info.activeSheet,
      rows: table.rowCount,
    } : null;
    const req = { ...lastOpen, source: msg.source || lastOpen.source };
    loading = true;
    const t0 = now();
    let res;
    try {
      res = await loader(req.source, req.format, req.options || {}, null);
      if (prev && prev.sheet && res.loadSheet && res.info && res.info.sheets && res.info.sheets.includes(prev.sheet) && res.info.activeSheet !== prev.sheet) {
        const s = await res.loadSheet(prev.sheet);
        s.loadSheet = res.loadSheet;
        s.info.fileSize = res.info.fileSize;
        res = s;
      }
    } catch (e) {
      loading = false;
      if (!table) { fail(e); return runPendingReload(); } // nothing shown yet: show the error as on open
      post({ type: 'error', message: `The file changed on disk but could not be read again: ${e && e.message ? e.message : e}. The table still shows the last version that was read.`, code: 'RELOAD', transient: true });
      return runPendingReload();
    }
    lastOpen = req;
    table = res.table;
    table.formatted = formatted;
    table.showFormulas = showFormulas;
    info = res.info;
    loadSheet = res.loadSheet || null;
    lastError = null;
    if (prev) carryOver(prev);
    loading = false;
    version++;
    loadMs = now() - t0;
    sendMeta({ loadMs, reloaded: { before: prev ? prev.rows : 0, after: table.rowCount, manual: !!msg.manual } });
    return runPendingReload();
  }

  /** Re-apply sort and filters on the new table, matching columns by name. */
  function carryOver(prev) {
    const idx = new Map(table.columns.map((c, i) => [c.name, i]));
    const map = i => (i >= 0 && i < prev.names.length && idx.has(prev.names[i]) ? idx.get(prev.names[i]) : -1);
    const columns = {};
    for (const [k, v] of Object.entries(prev.filters.columns || {})) {
      const j = map(Number(k));
      if (j >= 0) columns[j] = v;
    }
    const f = { global: prev.filters.global || '', columns };
    if (prev.filters.query && pro) f.query = prev.filters.query;
    try { table.setFilters(f); } catch { table.setFilters({ global: f.global, columns }); }
    if (prev.sort) {
      const j = map(prev.sort.col);
      if (j >= 0) table.setSort(j, prev.sort.dir);
    }
  }

  /** Show another sheet of the workbook. The streaming reader loads it from the file (async). */
  async function switchSheet(name) {
    if (!loadSheet || loading) return undefined;
    restoreFile();
    const fn = loadSheet;
    loading = true;
    let res;
    try { res = await fn(name); } catch (e) { loading = false; fail(e); return runPendingReload(); }
    loading = false;
    lastError = null;
    res.info.fileSize = info.fileSize;
    table = res.table;
    table.formatted = formatted;
    table.showFormulas = showFormulas;
    info = res.info;
    version++;
    sendMeta({ loadMs: 0 });
    return runPendingReload();
  }

  /** Post a non-transient error and remember it so a reloaded webview sees it too. */
  function fail(e) {
    lastError = { type: 'error', message: e && e.message ? e.message : String(e), code: e && e.code };
    post(lastError);
  }

  function handle(msg) {
    switch (msg.type) {
      case 'open':
        return open(msg);
      case 'getRows': {
        if (!table) return post({ type: 'rows', reqId: msg.reqId, version, start: msg.start, rows: [] });
        return post({ type: 'rows', reqId: msg.reqId, version, start: msg.start, rows: table.getRows(msg.start, msg.count) });
      }
      case 'sort':
      case 'filter': {
        if (!table || loading) return post({ type: 'error', message: 'Still loading. Sorting and filtering start when all rows are in.', code: 'BUSY', transient: true });
        const t0 = now();
        if (msg.type === 'sort') {
          if (msg.col !== null && msg.col >= table.columns.length) return post({ type: 'error', message: 'No such column.', transient: true });
          table.setSort(msg.col, msg.dir);
        } else {
          let query = msg.query || '';
          if (query && !pro) { proOnly('The SQL filter'); query = ''; }
          try {
            table.setFilters({ global: msg.global, columns: msg.columns, query });
          } catch (e) {
            if (!e || e.code !== 'QUERY') throw e;
            // Apply the other filters without the query, then report the query error.
            table.setFilters({ global: msg.global, columns: msg.columns });
            version++;
            post({ type: 'view', version, viewCount: table.viewCount, sort: table.sort, ms: now() - t0 });
            return post({ type: 'error', message: e.message, code: 'QUERY', transient: true });
          }
        }
        version++;
        return post({ type: 'view', version, viewCount: table.viewCount, sort: table.sort, ms: now() - t0 });
      }
      case 'copy': {
        if (!table) return post({ type: 'copyResult', text: '', rows: 0, format: msg.format, truncated: false });
        const r = table.copy(msg.sel, msg.format, msg.maxRows || 100000);
        return post({ type: 'copyResult', format: msg.format, ...r });
      }
      case 'sheet':
        return switchSheet(msg.name);
      case 'entitlement': {
        // Nothing is locked since 0.4: the SQL filter, stats and export are free.
        return undefined;
      }
      case 'stats': {
        if (!pro) return proOnly('Column stats');
        if (!table || loading) return post({ type: 'error', message: 'Still loading. Stats start when all rows are in.', code: 'BUSY', transient: true });
        const t0 = now();
        const res = require('./stats').computeStats(table);
        return post({ type: 'stats', version, ms: now() - t0, ...res });
      }
      case 'export':
        return exportView(msg);
      case 'csvOptions': {
        if (!lastOpen || (lastOpen.format !== 'csv' && lastOpen.format !== 'tsv')) {
          return post({ type: 'error', message: 'Delimiter and header options are for CSV and TSV files.', transient: true });
        }
        if (loading) return post({ type: 'error', message: 'Still loading. Change the delimiter when all rows are in.', code: 'BUSY', transient: true });
        const options = { ...(lastOpen.options || {}), delimiter: msg.delimiter, header: msg.header };
        if (msg.encoding !== undefined) options.encoding = msg.encoding;
        return open({ ...lastOpen, options });
      }
      case 'getCell': {
        const cell = table ? table.getCell(msg.row, msg.col) : null;
        if (!cell) return post({ type: 'cell', reqId: msg.reqId, version, row: msg.row, col: msg.col, missing: true });
        return post({ type: 'cell', reqId: msg.reqId, version, row: msg.row, col: msg.col, ...cell });
      }
      case 'reload':
        return reload(msg);
      case 'formats': {
        formatted = !!msg.on;
        if (!table) return undefined;
        table.formatted = formatted;
        table.showFormulas = showFormulas;
        if (table.filters.global) table.rebuild(); // the search also matches the Excel text
        version++;
        return post({ type: 'view', version, viewCount: table.viewCount, sort: table.sort, ms: 0, formatted });
      }
      case 'formulas': {
        showFormulas = !!msg.on;
        if (!table) return undefined;
        table.showFormulas = showFormulas;
        if (table.filters.global) table.rebuild(); // the search also matches the formula text
        version++;
        return post({ type: 'view', version, viewCount: table.viewCount, sort: table.sort, ms: 0, formatted, showFormulas });
      }
      case 'query':
        return runQuery(msg);
      case 'queryCancel':
        if (running) running.ctx.cancelled = true;
        return undefined;
      case 'queryBack':
        if (restoreFile()) { version++; sendMeta({ loadMs: loadMs || 0 }); }
        return undefined;
      case 'resync':
        sendMeta(loading || loadMs === null ? { resync: true } : { resync: true, loadMs });
        if (lastError) post(lastError);
        return undefined;
      default:
        return post({ type: 'error', message: `Unknown message ${msg.type}`, transient: true });
    }
  }

  /**
   * Run one SELECT from the Query panel. msg: {sql, files, allowStream, allowFiles, memCapMB, maxResultRows, fileName}.
   * Progress goes out as queryProgress; the end as queryDone, and on success the result replaces the grid
   * (sort, filter, copy, stats and export then work on it). queryBack shows the file again.
   */
  async function runQuery(msg) {
    if (running) return post({ type: 'queryDone', ok: false, error: 'A query is already running. Cancel it first.' });
    if (!lastOpen || loading || !(saved ? saved.table : table)) return post({ type: 'queryDone', ok: false, error: 'Still loading. Queries start when all rows are in.' });
    if (!engine) return post({ type: 'queryDone', ok: false, error: 'Queries are not available here.' });
    const sqlMod = engine;
    const { createResolver, resultTable } = engine;
    const id = ++queryId;
    const t0 = now();
    const notes = [];
    const ctx = sqlMod.createContext({
      now,
      onProgress: p => post({ type: 'queryProgress', id, rows: p.rows, bytes: p.bytes, totalBytes: p.totalBytes, ms: p.ms }),
    });
    running = { id, ctx };
    post({ type: 'queryProgress', id, rows: 0, bytes: 0, totalBytes: 0, ms: 0 });
    const file = {
      table: saved ? saved.table : table,
      info: saved ? saved.info : info,
      source: lastOpen.source,
      format: lastOpen.format,
      options: lastOpen.options,
      loadSheet,
      fileName: msg.fileName || lastOpen.source.path || lastOpen.source.name || '',
    };
    const resolve = createResolver({
      file,
      result: saved ? table : null,
      files: msg.files || {},
      allowStream: msg.allowStream !== false,
      allowFiles: msg.allowFiles !== false,
      note: n => { if (!notes.includes(n)) notes.push(n); },
      loaders: msg.loaders,
    });
    let res;
    try {
      res = await sqlMod.runSql(msg.sql, {
        resolve,
        memCapMB: msg.memCapMB || sqlMod.DEFAULTS.memCapMB,
        maxResultRows: msg.maxResultRows || sqlMod.DEFAULTS.maxResultRows,
      }, ctx);
    } catch (e) {
      running = null;
      const cancelled = !!(e && e.cancelled);
      return post({
        type: 'queryDone', id, ok: false, cancelled, rows: ctx.rows, ms: now() - t0,
        error: cancelled ? `Cancelled after ${ctx.rows.toLocaleString('en-US')} rows.` : (e && e.code === 'SQL' ? e.message : `The query failed: ${e && e.message ? e.message : e}`),
      });
    }
    running = null;
    for (const n of ctx.notes) if (!notes.includes(n)) notes.push(n);
    const result = resultTable(res);
    if (!saved) saved = { table, info };
    table = result;
    table.formatted = false;
    const ms = now() - t0;
    info = {
      format: 'query', totalRows: result.rowCount, truncated: !!res.truncated,
      truncatedReason: res.truncated ? `The result is cut at ${result.rowCount.toLocaleString('en-US')} rows (limit tableViewer.maxRows). Add LIMIT, WHERE or GROUP BY, or save the result.` : '',
      query: { sql: msg.sql, ms, scanned: ctx.rows, bytes: ctx.bytes, notes, file: saved.info && saved.info.format },
    };
    version++;
    sendMeta({ loadMs: ms });
    return post({ type: 'queryDone', id, ok: true, rows: result.rowCount, columns: result.columns.length, scanned: ctx.rows, ms, truncated: !!res.truncated, notes });
  }

  /** Export the whole view. msg: {format, path?}. With a path and writeFile, streams to the file; else returns the text. */
  async function exportView(msg) {
    const reply = extra => post({ type: 'exportResult', format: msg.format, path: msg.path || null, ...extra });
    if (!pro) { proOnly('Export'); return reply({ ok: false, error: 'Export is a Table Viewer Pro feature.' }); }
    if (!table || loading) return reply({ ok: false, error: 'Still loading. Export starts when all rows are in.' });
    if (!EXPORT_FORMATS.has(msg.format)) return reply({ ok: false, error: 'Unknown export format.' });
    const t0 = now();
    const rows = table.viewCount;
    if (msg.format === 'parquet') {
      if (!msg.path) return reply({ ok: false, error: 'Parquet files can be saved only to a folder on this computer.' });
      try {
        if (!engine) throw new Error('Parquet export is not available here.');
        const bytes = await engine.writeParquet(msg.path, table);
        return reply({ ok: true, rows, bytes, ms: now() - t0 });
      } catch (e) {
        return reply({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    }
    try {
      if (msg.path && writeFile) {
        const bytes = await writeFile(msg.path, table.exportChunks(msg.format));
        return reply({ ok: true, rows, bytes, ms: now() - t0 });
      }
      let text = '';
      for (const chunk of table.exportChunks(msg.format)) text += chunk;
      return reply({ ok: true, rows, bytes: Buffer.byteLength(text), text, ms: now() - t0 });
    } catch (e) {
      return reply({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  return { handle, fail, get table() { return table; }, get version() { return version; }, get pro() { return pro; }, get showingResult() { return !!saved; } };
}

module.exports = { validateWebviewMessage, createSession, columnsMeta, MAX_PAGE, EXPORT_FORMATS, CSV_DELIMITER_CHOICES };
