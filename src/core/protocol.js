'use strict';
// Message protocol shared by the webview, the extension host and the worker.
// Webview -> host: ready, getRows, sort, filter, copy, sheet, openSettings
// Host -> worker: open, getRows, sort, filter, copy, sheet, resync
// Worker -> host -> webview: meta, rows, view, copyResult, error
// The webview is destroyed when its tab is hidden (retainContextWhenHidden: false) and sends 'ready'
// again when shown. The host then sends 'resync' and the worker answers with a full 'meta' that carries
// the current sort, filters and sheet, plus the last load error, so the new webview can rebuild its state.

const MAX_PAGE = 2000;
const MAX_FILTER_LEN = 500;
const COPY_FORMATS = new Set(['csv', 'tsv', 'json']);

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
      return { type: msg.type };
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
      return { type: 'filter', global: typeof msg.global === 'string' ? msg.global.slice(0, MAX_FILTER_LEN) : '', columns };
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
function createSession({ post, loader, now = () => Date.now() }) {
  let table = null;
  let info = {};
  let loadSheet = null;
  let loading = false;
  let version = 0;
  let started = 0;
  let loadMs = null; // time of the full load, resent on resync
  let lastError = null; // non-transient error, resent on resync

  const sendMeta = (extra = {}) => {
    post({
      type: 'meta', version, loading,
      columns: table ? columnsMeta(table) : [],
      rowCount: table ? table.rowCount : 0,
      viewCount: table ? table.viewCount : 0,
      info, sort: table ? table.sort : null,
      filters: table && table.filters ? { global: table.filters.global, columns: { ...table.filters.columns } } : { global: '', columns: {} },
      ...extra,
    });
  };

  async function open(msg) {
    loading = true;
    started = now();
    const options = msg.options || {};
    try {
      const res = await loader(msg.source, msg.format, options, (preview, previewInfo) => {
        table = preview;
        info = previewInfo;
        version++;
        sendMeta({ firstRowsMs: now() - started });
      });
      table = res.table;
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
          table.setFilters({ global: msg.global, columns: msg.columns });
        }
        version++;
        return post({ type: 'view', version, viewCount: table.viewCount, sort: table.sort, ms: now() - t0 });
      }
      case 'copy': {
        if (!table) return post({ type: 'copyResult', text: '', rows: 0, format: msg.format, truncated: false });
        const r = table.copy(msg.sel, msg.format, msg.maxRows || 100000);
        return post({ type: 'copyResult', format: msg.format, ...r });
      }
      case 'sheet': {
        if (!loadSheet || loading) return undefined;
        let res;
        try { res = loadSheet(msg.name); } catch (e) { return fail(e); }
        lastError = null;
        res.info.fileSize = info.fileSize;
        table = res.table;
        info = res.info;
        version++;
        return sendMeta({ loadMs: 0 });
      }
      case 'resync':
        sendMeta(loading || loadMs === null ? { resync: true } : { resync: true, loadMs });
        if (lastError) post(lastError);
        return undefined;
      default:
        return post({ type: 'error', message: `Unknown message ${msg.type}`, transient: true });
    }
  }

  return { handle, fail, get table() { return table; }, get version() { return version; } };
}

module.exports = { validateWebviewMessage, createSession, columnsMeta, MAX_PAGE };
