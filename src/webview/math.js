'use strict';
// Pure helpers for the webview grid (no DOM), so they can be unit tested in Node.

const MAX_BODY_PX = 8000000; // stay well under browser element height limits

/** Map a scrollTop to the first visible row and its pixel shift. Works past MAX_BODY_PX by scaling. */
function scrollToRow(scrollTop, rowCount, rowH, viewportBodyH) {
  const realH = rowCount * rowH;
  const bodyH = Math.min(realH, MAX_BODY_PX);
  const scrollRange = Math.max(0, bodyH - viewportBodyH);
  const realRange = Math.max(0, realH - viewportBodyH);
  const st = Math.max(0, Math.min(scrollTop, scrollRange));
  const offset = scrollRange === realRange ? st : scrollRange > 0 ? (st / scrollRange) * realRange : 0;
  let first = Math.floor(offset / rowH);
  if (first > Math.max(0, rowCount - 1)) first = Math.max(0, rowCount - 1);
  return { first, shift: offset - first * rowH, bodyH };
}

/** Inverse of scrollToRow: the scrollTop that puts row at the top. */
function rowToScroll(row, rowCount, rowH, viewportBodyH) {
  const realH = rowCount * rowH;
  const bodyH = Math.min(realH, MAX_BODY_PX);
  const scrollRange = Math.max(0, bodyH - viewportBodyH);
  const realRange = Math.max(0, realH - viewportBodyH);
  if (realRange === 0) return 0;
  if (realRange === scrollRange) return Math.min(scrollRange, row * rowH);
  return Math.min(scrollRange, (row * rowH / realRange) * scrollRange);
}

/** Pages (inclusive range) needed for rows [first, last]. */
function pagesFor(first, last, pageSize) {
  if (last < first) return [];
  const out = [];
  for (let p = Math.floor(first / pageSize); p <= Math.floor(last / pageSize); p++) out.push(p);
  return out;
}

/** Normalize an anchor/focus pair to a rectangle. */
function normSel(a, f) {
  return { r0: Math.min(a.r, f.r), r1: Math.max(a.r, f.r), c0: Math.min(a.c, f.c), c1: Math.max(a.c, f.c) };
}

function inSel(sel, r, c) {
  return !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
}

/** Initial column width from header text and sample cell text. */
function autoWidth(name, type, samples) {
  const headerPx = String(name).length * 7.6 + String(type || '').length * 6.2 + 48;
  let max = 0;
  for (const s of samples) if (s && s.length > max) max = s.length;
  return Math.max(64, Math.min(360, Math.round(Math.max(headerPx, max * 7.4 + 22))));
}

/** Width of the row-number column for a given row count. */
function gutterWidth(rowCount) {
  return Math.max(48, Math.round(Number(rowCount).toLocaleString('en-US').length * 7.6 + 22));
}

/** Next sort state when a header is clicked: none -> asc -> desc -> none. */
function nextSort(sort, col) {
  if (!sort || sort.col !== col) return { col, dir: 'asc' };
  if (sort.dir === 'asc') return { col, dir: 'desc' };
  return null;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Filter state from a worker 'meta' message, copied so the webview can edit it. */
function filtersFromMeta(f) {
  const out = { global: '', columns: {} };
  if (!f || typeof f !== 'object') return out;
  if (typeof f.global === 'string') out.global = f.global;
  if (f.columns && typeof f.columns === 'object') {
    for (const [k, v] of Object.entries(f.columns)) if (typeof v === 'string' && v.trim()) out.columns[k] = v;
  }
  return out;
}

/** View state the webview keeps with vscode.setState, so a hidden-then-shown tab keeps its place. */
function viewState(scrollTop, scrollLeft, widths, sheet) {
  return { scrollTop: Math.max(0, scrollTop | 0), scrollLeft: Math.max(0, scrollLeft | 0), widths: widths.slice(), sheet: sheet || '' };
}

/** What to restore from saved view state for a table with columnCount columns on sheet. Null if nothing fits. */
function restoreView(saved, columnCount, sheet) {
  if (!saved || typeof saved !== 'object') return null;
  if ((saved.sheet || '') !== (sheet || '')) return null;
  const ok = Array.isArray(saved.widths) && saved.widths.length === columnCount && columnCount > 0 &&
    saved.widths.every(w => Number.isFinite(w) && w >= 40 && w <= 5000);
  return {
    widths: ok ? saved.widths.slice() : null,
    scrollTop: Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0,
    scrollLeft: Number.isFinite(saved.scrollLeft) ? Math.max(0, saved.scrollLeft) : 0,
  };
}

module.exports = { gutterWidth, scrollToRow, rowToScroll, pagesFor, normSel, inSel, autoWidth, nextSort, formatBytes, filtersFromMeta, viewState, restoreView, MAX_BODY_PX };
