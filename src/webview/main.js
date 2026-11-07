'use strict';
/* global acquireVsCodeApi */
// Table Viewer webview. All file content goes into the DOM through textContent only.
const M = require('./math');

const vscode = acquireVsCodeApi();
// Scroll position and column widths from before the tab was hidden (the webview is rebuilt on show).
let savedView = vscode.getState() || null;
const ROW_H = 24;
const HEAD_H = 52; // header (28) + filter row (24)
const PAGE = 200;
let GUTTER_W = 64;
const NUMERIC = new Set(['int', 'float', 'decimal']);

const S = {
  fileName: document.getElementById('app').dataset.title || '',
  format: '',
  columns: [],
  widths: [],
  autoSized: false,
  rowCount: 0,
  totalRows: 0,
  version: -1,
  loading: true,
  info: {},
  sort: null,
  filters: { global: '', columns: {} },
  cache: new Map(),
  pending: new Map(),
  reqId: 1,
  anchor: null,
  focus: null,
  dragging: false,
  schemaOpen: false,
  error: '',
  timing: '',
  pro: { enabled: false },
  statsOpen: false,
  queryOpen: false,
  cellOpen: false, // cell panel with the full value of the focused cell
  cellReq: 0,
  cellData: null,
  cellPretty: true,
  formatted: true, // Excel number formats shown (worker state, sent in meta and view)
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function fmtN(n) { return Number(n).toLocaleString('en-US'); }

// ---------- layout ----------
const app = document.getElementById('app');
const toolbar = el('div', 'toolbar');
const title = el('span', 'title', S.fileName);
const fmtBadge = el('span', 'fmt');
const stats = el('span', 'stats');
const search = el('input', 'search');
search.type = 'search';
search.placeholder = 'Search all columns';
search.setAttribute('aria-label', 'Search all columns');
const sheetSel = el('select', 'sheet');
sheetSel.setAttribute('aria-label', 'Sheet');
sheetSel.hidden = true;
const btnSchema = el('button', 'btn', 'Schema');
btnSchema.title = 'Show columns and types (Parquet: full schema and file metadata)';
const btnCsv = el('button', 'btn', 'Copy CSV');
btnCsv.title = 'Copy the selection as CSV with a header row (no selection: the whole view)';
const btnJson = el('button', 'btn', 'Copy JSON');
btnJson.title = 'Copy the selection as a JSON array of objects (no selection: the whole view)';
const spacer = el('span', 'spacer');
const btnReload = el('button', 'btn', 'Reload');
btnReload.title = 'Read the file again. It also reloads by itself when the file changes on disk (tableViewer.autoReload). Sort and filters stay.';
const btnCompare = el('button', 'btn', 'Compare');
btnCompare.title = 'Compare with the Git HEAD version or with another table file, row by row, in the diff editor';
const btnFormats = el('button', 'btn toggle', 'Excel formats');
btnFormats.title = 'On: cells show the number format from the workbook (25%, $1,234.50, dates). Off: the stored values. Sort, filters and copy use the values either way.';
btnFormats.hidden = true;
// Pro controls. All hidden unless the host says Pro is switched on (config.PRO_ENABLED).
const proBadge = el('button', 'pro-badge', 'Pro');
proBadge.hidden = true;
const btnQuery = el('button', 'btn', 'SQL');
btnQuery.title = 'Filter rows with a SQL WHERE condition';
const btnStats = el('button', 'btn', 'Stats');
btnStats.title = 'Count, nulls, distinct, min, max, mean and top values for each column of the rows in view';
const btnExport = el('button', 'btn', 'Export');
btnExport.title = 'Save the rows in view (filtered and sorted) as CSV, TSV, JSON or JSON Lines';
btnQuery.hidden = btnStats.hidden = btnExport.hidden = true;
// CSV/TSV only: pick the delimiter and say whether the first line is a header. The file is read again.
const csvBox = el('span', 'csvopts');
csvBox.hidden = true;
const delimLabel = el('label', 'csvopt', 'Delimiter ');
const delimSel = el('select', 'sheet');
delimSel.setAttribute('aria-label', 'Delimiter');
delimSel.title = 'How the columns are split. Auto guesses from the first lines.';
delimLabel.append(delimSel);
const headerLabel = el('label', 'csvopt');
const headerChk = el('input');
headerChk.type = 'checkbox';
headerChk.checked = true;
headerChk.title = 'Off: the first line is data and the columns are named column_1, column_2, ...';
headerLabel.append(headerChk, document.createTextNode(' Header row'));
csvBox.append(delimLabel, headerLabel);
toolbar.append(title, fmtBadge, stats, spacer, csvBox, sheetSel, btnFormats, search, btnQuery, btnSchema, btnStats, btnCsv, btnJson, btnExport, btnCompare, btnReload, proBadge);

const queryBar = el('div', 'querybar');
queryBar.hidden = true;
const queryLabel = el('span', 'qlabel', 'WHERE');
const queryInput = el('input', 'qinput');
queryInput.placeholder = "fare > 20 AND (city = 'Paris' OR city LIKE 'Lon%') AND tip IS NOT NULL";
queryInput.setAttribute('aria-label', 'SQL WHERE condition');
queryInput.spellcheck = false;
const queryRun = el('button', 'btn', 'Apply');
const queryClear = el('button', 'btn', 'Clear');
const queryErr = el('span', 'qerr');
queryBar.append(queryLabel, queryInput, queryRun, queryClear, queryErr);
const statsPanel = el('div', 'statspanel');
statsPanel.hidden = true;

const banner = el('div', 'banner');
banner.hidden = true;
const schemaPanel = el('div', 'schema');
schemaPanel.hidden = true;

const grid = el('div', 'grid');
grid.tabIndex = 0;
grid.setAttribute('role', 'grid');
const sizer = el('div', 'sizer');
const stage = el('div', 'stage');
const head = el('div', 'head');
const filterRow = el('div', 'filters');
const body = el('div', 'body');
stage.append(head, filterRow, body);
sizer.append(stage);
grid.append(sizer);

// Cell panel: the full value of the focused cell, wrapped, with JSON indented.
const cellPanel = el('div', 'cellpanel');
cellPanel.hidden = true;
const cellHead = el('div', 'cellhead');
const cellCap = el('span', 'cellcap');
const cellSpacer = el('span', 'spacer');
const btnPretty = el('button', 'btn', 'Raw');
btnPretty.title = 'Switch between indented JSON and the raw text';
btnPretty.hidden = true;
const btnCopyCell = el('button', 'btn', 'Copy value');
btnCopyCell.title = 'Copy the full value as shown';
const btnCloseCell = el('button', 'btn', 'Close');
btnCloseCell.title = 'Close the panel (Esc)';
cellHead.append(cellCap, cellSpacer, btnPretty, btnCopyCell, btnCloseCell);
const cellValue = el('pre', 'cellvalue');
cellValue.tabIndex = 0;
cellPanel.append(cellHead, cellValue);

const status = el('div', 'status');
const statusLeft = el('span', 'left');
const statusMid = el('span', 'mid');
const statusRight = el('span', 'right');
status.append(statusLeft, statusMid, statusRight);
// The host renders the Sponsor / More free viewers line only when tableViewer.showSupportLinks is on.
const supportLine = document.getElementById('zovo-support');
if (supportLine) status.append(supportLine);
app.append(toolbar, queryBar, banner, schemaPanel, statsPanel, grid, cellPanel, status);

// ---------- header ----------
function totalWidth() { return GUTTER_W + S.widths.reduce((a, b) => a + b, 0); }

function buildHeader() {
  head.textContent = '';
  filterRow.textContent = '';
  const corner = el('div', 'cell gutter corner', '#');
  corner.title = 'Select all';
  corner.addEventListener('mousedown', e => { e.preventDefault(); selectAll(); });
  head.append(corner);
  filterRow.append(el('div', 'cell gutter'));
  S.columns.forEach((col, c) => {
    const h = el('div', 'cell hcell');
    h.style.width = S.widths[c] + 'px';
    h.dataset.col = String(c);
    const name = el('span', 'hname', col.name);
    const type = el('span', 'htype t-' + col.type, col.type);
    type.title = col.detail ? `${col.type} (${col.detail})` : col.type;
    const arrow = el('span', 'sort');
    if (S.sort && S.sort.col === c) arrow.textContent = S.sort.dir === 'asc' ? '▲' : '▼';
    h.title = `${col.name}\n${type.title}\nClick to sort`;
    const grip = el('span', 'grip');
    grip.title = 'Drag to resize. Double-click to fit the content.';
    grip.addEventListener('mousedown', e => startResize(e, c));
    grip.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); fitColumn(c); });
    h.append(name, type, arrow, grip);
    h.addEventListener('click', e => {
      if (e.target === grip) return;
      if (S.loading) return flash('Still loading. Sorting starts when all rows are in.');
      const next = M.nextSort(S.sort, c);
      flash('Sorting…', true);
      vscode.postMessage(next ? { type: 'sort', col: c, dir: next.dir } : { type: 'sort', col: null, dir: null });
    });
    head.append(h);
    const fcell = el('div', 'cell fcell');
    fcell.style.width = S.widths[c] + 'px';
    const inp = el('input', 'finput');
    inp.placeholder = NUMERIC.has(col.type) ? '>10, 5..9, =3' : 'contains';
    inp.title = NUMERIC.has(col.type)
      ? 'Filter: >10, >=10, <5, =3, !=3, 5..9, empty, !empty, or text'
      : 'Filter: text (contains), =exact, !not, empty, !empty';
    inp.setAttribute('aria-label', `Filter ${col.name}`);
    inp.value = S.filters.columns[c] || '';
    inp.disabled = S.loading;
    inp.addEventListener('input', () => {
      if (inp.value.trim()) S.filters.columns[c] = inp.value; else delete S.filters.columns[c];
      sendFilters();
    });
    fcell.append(inp);
    filterRow.append(fcell);
  });
  const w = totalWidth();
  head.style.width = w + 'px';
  filterRow.style.width = w + 'px';
}

function updateSortArrows() {
  head.querySelectorAll('.hcell').forEach(h => {
    const c = Number(h.dataset.col);
    h.querySelector('.sort').textContent = S.sort && S.sort.col === c ? (S.sort.dir === 'asc' ? '▲' : '▼') : '';
  });
}

let resize = null;
function startResize(e, c) {
  e.preventDefault();
  e.stopPropagation();
  resize = { c, x: e.clientX, w: S.widths[c] };
}
window.addEventListener('mousemove', e => {
  if (resize) {
    S.widths[resize.c] = Math.max(40, resize.w + e.clientX - resize.x);
    applyWidths();
    return;
  }
  if (S.dragging) {
    const hit = cellAt(e.clientX, e.clientY);
    if (hit) { S.focus = hit; paintSelection(); updateStatus(); }
  }
});
window.addEventListener('mouseup', () => { if (resize) saveView(); resize = null; S.dragging = false; });

/** Fit one column to the widest value in the rows loaded so far. */
function fitColumn(c) {
  const col = S.columns[c];
  if (!col) return;
  const samples = [];
  for (const page of S.cache.values()) for (const row of page) samples.push(row.cells[c]);
  S.widths[c] = M.fitWidth(col.name, col.type, samples);
  applyWidths();
  saveView();
  flash(`Fitted ${col.name} to ${fmtN(samples.length)} loaded rows`);
}

function applyWidths() {
  const hs = head.querySelectorAll('.hcell');
  const fs = filterRow.querySelectorAll('.fcell');
  S.widths.forEach((w, c) => { if (hs[c]) hs[c].style.width = w + 'px'; if (fs[c]) fs[c].style.width = w + 'px'; });
  const tw = totalWidth();
  head.style.width = tw + 'px';
  filterRow.style.width = tw + 'px';
  rowPool.length = 0;
  body.textContent = '';
  layout();
}

// ---------- filters ----------
let filterTimer = null;
function filterMessage() {
  const m = { type: 'filter', global: S.filters.global, columns: S.filters.columns };
  if (S.filters.query) m.query = S.filters.query;
  return m;
}
function sendFilters() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => vscode.postMessage(filterMessage()), 250);
}
search.addEventListener('input', () => {
  if (S.loading) return;
  S.filters.global = search.value;
  sendFilters();
});

// ---------- body rendering ----------
const rowPool = [];
let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function layout() {
  const bodyH = Math.min(S.rowCount * ROW_H, M.MAX_BODY_PX);
  sizer.style.height = (HEAD_H + bodyH) + 'px';
  const w = totalWidth();
  sizer.style.width = w + 'px';
  stage.style.width = w + 'px';
  render();
}

function viewportBodyH() { return Math.max(0, grid.clientHeight - HEAD_H); }

function visibleRange() {
  const vh = viewportBodyH();
  const { first, shift } = M.scrollToRow(grid.scrollTop, S.rowCount, ROW_H, vh);
  const count = Math.ceil((vh + shift) / ROW_H) + 1;
  return { first, last: Math.min(S.rowCount - 1, first + count - 1), shift };
}

// Only the columns in the horizontal viewport get cell elements, so a file with thousands of
// columns scrolls as fast as a narrow one. A spacer stands in for the columns to the left.
function makeRowEl() {
  const r = el('div', 'row');
  const g = el('div', 'cell gutter');
  const spacer = el('div', 'colspacer');
  r.append(g, spacer);
  r._g = g;
  r._spacer = spacer;
  r._cells = [];
  return r;
}

function syncRowCells(r, c0, c1) {
  const want = Math.max(0, c1 - c0 + 1);
  while (r._cells.length < want) { const d = el('div', 'cell'); r.append(d); r._cells.push(d); }
  while (r._cells.length > want) r._cells.pop().remove();
}

function render() {
  stage.style.height = Math.min(grid.clientHeight, HEAD_H + Math.min(S.rowCount * ROW_H, M.MAX_BODY_PX)) + 'px';
  if (!S.columns.length) { body.textContent = ''; return; }
  const { first, last, shift } = visibleRange();
  const n = Math.max(0, last - first + 1);
  const lefts = M.columnLefts(S.widths);
  const { c0, c1 } = M.visibleColumns(lefts, S.widths, grid.scrollLeft, grid.clientWidth, GUTTER_W);
  while (rowPool.length < n) { const r = makeRowEl(); rowPool.push(r); body.append(r); }
  body.style.transform = `translateY(${-shift}px)`;
  const sel = currentSel();
  const missing = [];
  for (let i = 0; i < rowPool.length; i++) {
    const r = rowPool[i];
    if (i >= n) { r.hidden = true; continue; }
    r.hidden = false;
    const vr = first + i;
    r._vr = vr;
    const page = S.cache.get(Math.floor(vr / PAGE));
    const row = page ? page[vr % PAGE] : null;
    r._g.textContent = row ? fmtN(row.id + 1) : fmtN(vr + 1);
    r._g.classList.toggle('selrow', !!sel && vr >= sel.r0 && vr <= sel.r1);
    syncRowCells(r, c0, c1);
    r._spacer.style.width = (c1 >= c0 ? lefts[c0] : 0) + 'px';
    for (let j = 0; j < r._cells.length; j++) {
      const c = c0 + j;
      const cell = r._cells[j];
      cell._c = c;
      cell.style.width = S.widths[c] + 'px';
      const v = row ? row.cells[c] : undefined;
      if (!row) { cell.textContent = ''; cell.className = 'cell pending' + (NUMERIC.has(S.columns[c].type) ? ' num' : ''); }
      else {
        cell.textContent = v === null ? '' : v;
        cell.className = 'cell' + (NUMERIC.has(S.columns[c].type) ? ' num' : '') + (v === null ? ' null' : '');
      }
      if (M.inSel(sel, vr, c)) cell.classList.add('sel');
      if (S.focus && S.focus.r === vr && S.focus.c === c) cell.classList.add('focus');
    }
    if (!row) missing.push(vr);
  }
  if (missing.length) request(missing[0], missing[missing.length - 1]);
}

function paintSelection() { render(); }

function request(first, last) {
  for (const p of M.pagesFor(first, last, PAGE)) {
    if (S.cache.has(p)) continue;
    let already = false;
    for (const q of S.pending.values()) if (q.page === p && q.version === S.version) already = true;
    if (already) continue;
    const reqId = S.reqId++;
    S.pending.set(reqId, { page: p, version: S.version });
    vscode.postMessage({ type: 'getRows', reqId, start: p * PAGE, count: PAGE });
  }
}

let saveTimer = null;
function saveView() {
  if (!S.columns.length) return;
  vscode.setState(M.viewState(grid.scrollTop, grid.scrollLeft, S.widths, S.info.activeSheet));
}
grid.addEventListener('scroll', () => {
  schedule();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveView, 200);
});
window.addEventListener('resize', schedule);

// ---------- selection ----------
function currentSel() { return S.anchor && S.focus ? M.normSel(S.anchor, S.focus) : null; }

function cellAt(x, y) {
  const rowEl = document.elementFromPoint(x, y);
  if (!rowEl) return null;
  const cell = rowEl.closest('.row > .cell');
  if (!cell) return null;
  const r = cell.parentElement._vr;
  if (r === undefined) return null;
  if (cell.classList.contains('gutter')) return { r, c: 0, gutter: true };
  return { r, c: cell._c === undefined ? 0 : cell._c, gutter: false };
}

body.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const hit = cellAt(e.clientX, e.clientY);
  if (!hit) return;
  e.preventDefault();
  grid.focus();
  if (hit.gutter) {
    const last = S.columns.length - 1;
    if (e.shiftKey && S.anchor) { S.focus = { r: hit.r, c: last }; S.anchor = { r: S.anchor.r, c: 0 }; }
    else { S.anchor = { r: hit.r, c: 0 }; S.focus = { r: hit.r, c: last }; }
  } else if (e.shiftKey && S.anchor) {
    S.focus = { r: hit.r, c: hit.c };
  } else {
    S.anchor = { r: hit.r, c: hit.c };
    S.focus = { r: hit.r, c: hit.c };
  }
  S.dragging = !hit.gutter;
  paintSelection();
  updateStatus();
  if (S.cellOpen && !hit.gutter) requestCell();
});

body.addEventListener('dblclick', e => {
  const hit = cellAt(e.clientX, e.clientY);
  if (!hit || hit.gutter) return;
  e.preventDefault();
  S.anchor = { r: hit.r, c: hit.c };
  S.focus = { r: hit.r, c: hit.c };
  S.dragging = false;
  render();
  updateStatus();
  openCell();
});

// ---------- cell panel ----------
function openCell() {
  if (!S.focus) return;
  const wasOpen = S.cellOpen;
  S.cellOpen = true;
  cellPanel.hidden = false;
  requestCell();
  if (!wasOpen) layout();
  ensureVisible(S.focus.r);
}

function closeCell() {
  S.cellOpen = false;
  S.cellData = null;
  S.cellReq = 0;
  cellPanel.hidden = true;
  layout();
  grid.focus();
}

function requestCell() {
  if (!S.cellOpen) return;
  if (!S.focus) { S.cellData = null; renderCell(); return; }
  const reqId = S.reqId++;
  S.cellReq = reqId;
  vscode.postMessage({ type: 'getCell', reqId, row: S.focus.r, col: S.focus.c });
}

function shownCellText() {
  const d = S.cellData;
  if (!d || d.value === null || d.value === undefined) return '';
  return M.cellText(d.value, S.columns[d.col] ? S.columns[d.col].type : '', S.cellPretty).text;
}

function renderCell() {
  const d = S.cellData;
  if (!d) {
    cellCap.textContent = 'Click a cell to see its full value.';
    cellValue.textContent = '';
    btnPretty.hidden = true;
    btnCopyCell.disabled = true;
    return;
  }
  const col = S.columns[d.col];
  const view = M.cellText(d.value, col ? col.type : '', S.cellPretty);
  cellCap.textContent = M.cellCaption(d.id + 1, col, d.length, d.truncated) + (view.json ? ' · JSON' : '') + (d.raw !== undefined && d.raw !== null ? ` · stored value ${d.raw}` : '');
  cellValue.textContent = d.value === null ? '' : view.text;
  cellValue.classList.toggle('null', d.value === null);
  btnPretty.hidden = !view.json;
  btnPretty.textContent = S.cellPretty ? 'Raw' : 'Indented';
  btnCopyCell.disabled = d.value === null;
}

btnCloseCell.addEventListener('click', closeCell);
btnPretty.addEventListener('click', () => { S.cellPretty = !S.cellPretty; renderCell(); });
btnCopyCell.addEventListener('click', () => {
  if (!S.cellData || S.cellData.value === null) return;
  vscode.postMessage({ type: 'copyText', text: shownCellText() });
});
cellPanel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeCell(); } });

function selectAll() {
  if (!S.rowCount || !S.columns.length) return;
  S.anchor = { r: 0, c: 0 };
  S.focus = { r: S.rowCount - 1, c: S.columns.length - 1 };
  paintSelection();
  updateStatus();
}

function ensureVisible(r) {
  const { first, last } = visibleRange();
  const vh = viewportBodyH();
  if (r < first + 1) grid.scrollTop = M.rowToScroll(r, S.rowCount, ROW_H, vh);
  else if (r > last - 1) grid.scrollTop = M.rowToScroll(Math.max(0, r - Math.floor(vh / ROW_H) + 1), S.rowCount, ROW_H, vh);
}

function ensureColVisible(c) {
  const lefts = M.columnLefts(S.widths);
  const viewW = grid.clientWidth - GUTTER_W;
  if (lefts[c] < grid.scrollLeft) grid.scrollLeft = lefts[c];
  else if (lefts[c] + S.widths[c] > grid.scrollLeft + viewW) grid.scrollLeft = lefts[c] + S.widths[c] - viewW;
}

grid.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copy('tsv', false); return; }
  if (!S.focus) return;
  if (e.key === 'Enter' && !mod) { e.preventDefault(); openCell(); return; }
  if (e.key === 'Escape' && S.cellOpen) { e.preventDefault(); closeCell(); return; }
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0] };
  const m = moves[e.key];
  if (!m) { if (e.key === 'Escape') { S.anchor = S.focus = null; render(); updateStatus(); } return; }
  e.preventDefault();
  const f = {
    r: Math.max(0, Math.min(S.rowCount - 1, S.focus.r + m[0])),
    c: Math.max(0, Math.min(S.columns.length - 1, S.focus.c + m[1])),
  };
  S.focus = f;
  if (!e.shiftKey) S.anchor = { ...f };
  ensureVisible(f.r);
  ensureColVisible(f.c);
  render();
  updateStatus();
  if (S.cellOpen) requestCell();
});

function copy(format, header = true) {
  if (!S.rowCount || !S.columns.length) return flash('Nothing to copy.');
  const sel = currentSel() || { r0: 0, r1: S.rowCount - 1, c0: 0, c1: S.columns.length - 1 };
  flash('Copying…', true);
  vscode.postMessage({ type: 'copy', format, sel: { ...sel, header } });
}
btnCsv.addEventListener('click', () => copy('csv'));
btnJson.addEventListener('click', () => copy('json'));
btnSchema.addEventListener('click', () => { S.schemaOpen = !S.schemaOpen; renderSchema(); layout(); });
btnReload.addEventListener('click', () => { flash('Reading the file again…', true); vscode.postMessage({ type: 'reload' }); });
btnCompare.addEventListener('click', () => vscode.postMessage({ type: 'compare' }));
btnFormats.addEventListener('click', () => vscode.postMessage({ type: 'formats', on: !S.formatted }));

function renderFormats() {
  const n = (S.info && S.info.formattedCells) || 0;
  btnFormats.hidden = !(S.format === 'excel' && n > 0);
  btnFormats.setAttribute('aria-pressed', S.formatted ? 'true' : 'false');
  btnFormats.classList.toggle('on', S.formatted);
  btnFormats.textContent = S.formatted ? 'Excel formats: on' : 'Excel formats: off';
}

// ---------- Pro ----------
function proOn() { return !!(S.pro.enabled && S.pro.licensed); }

function renderPro() {
  const p = S.pro;
  proBadge.hidden = !p.enabled;
  proBadge.classList.toggle('active', !!p.licensed);
  proBadge.title = p.licensed
    ? 'Table Viewer Pro is active' + (p.expires ? ` until ${p.expires}` : '')
    : (p.note ? p.note + ' ' : '') + 'Table Viewer Pro: bigger files, SQL filter, export, column stats. Click for details.';
  btnQuery.hidden = btnStats.hidden = btnExport.hidden = !proOn();
  if (!proOn()) { S.queryOpen = false; S.statsOpen = false; }
  queryBar.hidden = !S.queryOpen;
  btnQuery.classList.toggle('on', S.queryOpen || !!S.filters.query);
  statsPanel.hidden = !S.statsOpen;
  btnStats.classList.toggle('on', S.statsOpen);
}

proBadge.addEventListener('click', () => { if (!S.pro.licensed) vscode.postMessage({ type: 'openProPage' }); });
btnQuery.addEventListener('click', () => {
  S.queryOpen = !S.queryOpen;
  renderPro();
  if (S.queryOpen) queryInput.focus();
  layout();
});
function applyQuery() {
  if (S.loading) return flash('Still loading. The SQL filter starts when all rows are in.');
  const q = queryInput.value.trim();
  if (q) S.filters.query = q; else delete S.filters.query;
  queryErr.textContent = '';
  flash('Filtering…', true);
  clearTimeout(filterTimer);
  vscode.postMessage(filterMessage());
  renderPro();
}
queryRun.addEventListener('click', applyQuery);
queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyQuery(); } });
queryClear.addEventListener('click', () => { queryInput.value = ''; applyQuery(); });
btnStats.addEventListener('click', () => {
  S.statsOpen = !S.statsOpen;
  renderPro();
  if (S.statsOpen) requestStats();
  layout();
});
btnExport.addEventListener('click', () => {
  if (S.loading) return flash('Still loading. Export starts when all rows are in.');
  vscode.postMessage({ type: 'export' });
});

function requestStats() {
  if (!S.statsOpen) return;
  if (S.loading) { statsPanel.textContent = 'Stats start when all rows are in.'; return; }
  statsPanel.textContent = 'Counting…';
  vscode.postMessage({ type: 'stats' });
}

function renderStats(msg) {
  statsPanel.textContent = '';
  statsPanel.append(el('div', 'meta', `Stats for ${fmtN(msg.rows)} rows in view · ${fmtN(msg.ms)} ms`));
  const t = el('table', 'fields');
  const hr = el('tr');
  ['Column', 'Type', 'Count', 'Nulls', 'Distinct', 'Min', 'Max', 'Mean / length', 'Top values'].forEach(h => hr.append(el('th', null, h)));
  t.append(hr);
  for (const cells of M.statsRows(msg)) {
    const tr = el('tr');
    cells.forEach((v, i) => tr.append(el('td', i === 0 ? 'fname' : i >= 2 && i <= 4 ? 'num' : null, v)));
    t.append(tr);
  }
  statsPanel.append(t);
}
sheetSel.addEventListener('change', () => {
  flash('Loading sheet…', true);
  vscode.postMessage({ type: 'sheet', name: sheetSel.value });
});

// ---------- CSV options ----------
function renderCsvOptions() {
  const text = S.format === 'csv' || S.format === 'tsv';
  csvBox.hidden = !text || !!S.error && !S.columns.length;
  if (!text) return;
  const { choices, selected } = M.delimiterChoices(S.info);
  delimSel.textContent = '';
  for (const ch of choices) { const o = el('option', null, ch.label); o.value = ch.value; delimSel.append(o); }
  delimSel.value = selected;
  headerChk.checked = S.info.header !== false;
  delimSel.disabled = headerChk.disabled = S.loading;
}
function sendCsvOptions() {
  if (S.loading) return flash('Still loading. Change the delimiter when all rows are in.');
  flash('Reading the file again…', true);
  delimSel.disabled = headerChk.disabled = true;
  vscode.postMessage({ type: 'csvOptions', delimiter: delimSel.value, header: headerChk.checked });
}
delimSel.addEventListener('change', sendCsvOptions);
headerChk.addEventListener('change', sendCsvOptions);

// ---------- schema panel ----------
function kv(parent, k, v) {
  if (v === undefined || v === null || v === '') return;
  const row = el('div', 'kv');
  row.append(el('span', 'k', k), el('span', 'v', v));
  parent.append(row);
}

function renderSchema() {
  schemaPanel.hidden = !S.schemaOpen;
  btnSchema.classList.toggle('on', S.schemaOpen);
  if (!S.schemaOpen) return;
  schemaPanel.textContent = '';
  const sc = S.info.schema;
  const meta = el('div', 'meta');
  kv(meta, 'Rows', fmtN(S.info.totalRows ?? S.totalRows));
  kv(meta, 'Columns', fmtN(S.columns.length));
  kv(meta, 'File size', M.formatBytes(S.info.fileSize));
  if (sc) {
    kv(meta, 'Row groups', fmtN(sc.rowGroups));
    kv(meta, 'Compression', sc.codecs.join(', ') || 'none');
    kv(meta, 'Uncompressed', M.formatBytes(sc.uncompressedBytes));
    kv(meta, 'Created by', sc.createdBy);
    kv(meta, 'Format version', sc.version);
  }
  if (S.info.delimiter) kv(meta, 'Delimiter', S.info.delimiter === '\t' ? 'tab' : S.info.delimiter);
  if (S.info.activeSheet) kv(meta, 'Sheet', S.info.activeSheet);
  schemaPanel.append(meta);
  const t = el('table', 'fields');
  const hr = el('tr');
  const cols = sc ? ['Field', 'Physical type', 'Logical type', 'Repetition'] : ['Column', 'Type'];
  cols.forEach(h => hr.append(el('th', null, h)));
  t.append(hr);
  if (sc) {
    for (const f of sc.fields) {
      const tr = el('tr');
      const name = el('td', 'fname', f.name);
      name.style.paddingLeft = (6 + f.depth * 16) + 'px';
      tr.append(name, el('td', null, f.physical), el('td', null, f.logical), el('td', null, f.repetition));
      t.append(tr);
    }
  } else {
    for (const c of S.columns) {
      const tr = el('tr');
      tr.append(el('td', 'fname', c.name), el('td', null, c.type));
      t.append(tr);
    }
  }
  schemaPanel.append(t);
  if (sc && sc.keyValue.length) {
    const kvBox = el('div', 'meta kvmeta');
    kvBox.append(el('div', 'k', 'Key-value metadata'));
    for (const p of sc.keyValue) kv(kvBox, p.key, p.value.length > 300 ? p.value.slice(0, 300) + '…' : p.value);
    schemaPanel.append(kvBox);
  }
}

// ---------- status ----------
let flashTimer = null;
function flash(text, sticky) {
  statusMid.textContent = text;
  clearTimeout(flashTimer);
  if (!sticky) flashTimer = setTimeout(() => { statusMid.textContent = ''; }, 4000);
}

function updateStatus() {
  const total = S.info.totalRows ?? S.totalRows;
  let s;
  if (S.loading) s = `Loading… ${fmtN(S.totalRows)} rows so far`;
  else if (S.rowCount !== S.totalRows) s = `${fmtN(S.rowCount)} of ${fmtN(S.totalRows)} rows match`;
  else s = `${fmtN(S.totalRows)} rows`;
  stats.textContent = `${s} · ${fmtN(S.columns.length)} columns` + (total && total !== S.totalRows && !S.loading ? ` · file has ${fmtN(total)}` : '');
  const sel = currentSel();
  statusLeft.textContent = sel
    ? `Selected ${fmtN(sel.r1 - sel.r0 + 1)} × ${fmtN(sel.c1 - sel.c0 + 1)}` + (sel.r0 === sel.r1 && sel.c0 === sel.c1 && S.columns[sel.c0] ? ` · ${S.columns[sel.c0].name} (${S.columns[sel.c0].type})` : '')
    : 'Click a cell, drag or Shift+click to select. Double-click or Enter shows the full value. Ctrl/Cmd+C copies as TSV.';
  statusRight.textContent = S.timing;
  search.disabled = S.loading;
  btnCsv.disabled = btnJson.disabled = S.loading && !S.rowCount;
}

function showBanner() {
  const parts = [];
  if (S.error) parts.push(S.error);
  else if (S.info.truncated && S.info.truncatedReason) {
    parts.push(S.info.truncatedReason);
    if (S.pro.enabled && !S.pro.licensed) parts.push('Table Viewer Pro loads larger files.');
  }
  banner.textContent = '';
  if (!parts.length) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.classList.toggle('error', !!S.error);
  banner.append(el('span', null, parts.join(' ')));
  const link = el('button', 'link', 'Settings');
  link.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  banner.append(link);
}

// ---------- messages ----------
function sameColumns(a, b) {
  return a.length === b.length && a.every((c, i) => c.name === b[i].name && c.type === b[i].type);
}

window.addEventListener('message', ev => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'init':
      S.fileName = msg.fileName;
      S.format = msg.format;
      title.textContent = msg.fileName;
      fmtBadge.textContent = String(msg.format || '').toUpperCase();
      break;
    case 'meta': {
      const changed = !sameColumns(S.columns, msg.columns);
      S.version = msg.version;
      S.loading = !!msg.loading;
      S.info = msg.info || {};
      S.sort = msg.sort || null;
      S.rowCount = msg.viewCount;
      S.totalRows = msg.rowCount;
      if (typeof msg.formatted === 'boolean') S.formatted = msg.formatted;
      S.cache.clear();
      S.pending.clear();
      S.error = '';
      if (changed) {
        S.columns = msg.columns;
        S.widths = S.columns.map(c => M.autoWidth(c.name, c.type, []));
        S.autoSized = false;
        S.filters = { global: '', columns: {} };
        search.value = '';
        S.anchor = S.focus = null;
        rowPool.length = 0;
        body.textContent = '';
      }
      if (msg.filters) {
        // The worker owns the filter state. A reloaded tab gets it back here, and a new sheet clears it.
        clearTimeout(filterTimer);
        S.filters = M.filtersFromMeta(msg.filters);
        search.value = S.filters.global;
        queryInput.value = S.filters.query || '';
        renderPro();
      }
      GUTTER_W = M.gutterWidth(Math.max(S.totalRows, S.info.totalRows || 0));
      app.style.setProperty('--gutter-w', GUTTER_W + 'px');
      buildHeader();
      if (msg.firstRowsMs !== undefined) S.timing = `First rows in ${fmtN(msg.firstRowsMs)} ms`;
      if (msg.loadMs !== undefined && !msg.loading) S.timing = `Loaded in ${fmtN(msg.loadMs)} ms`;
      const sheets = S.info.sheets || [];
      sheetSel.hidden = sheets.length < 2;
      if (sheets.length >= 2) {
        sheetSel.textContent = '';
        for (const n of sheets) { const o = el('option', null, n); o.value = n; sheetSel.append(o); }
        sheetSel.value = S.info.activeSheet;
      }
      if (!S.loading) statusMid.textContent = '';
      if (msg.reloaded) {
        const b = msg.reloaded.before, a = msg.reloaded.after;
        const what = msg.reloaded.manual ? 'Reloaded' : 'Reloaded: the file changed on disk';
        flash(b === a ? `${what} (${fmtN(a)} rows)` : `${what} (${fmtN(b)} → ${fmtN(a)} rows)`);
      }
      renderFormats();
      showBanner();
      renderCsvOptions();
      if (S.cellOpen) { if (!S.focus || S.focus.r >= S.rowCount || S.focus.c >= S.columns.length) { S.anchor = S.focus = null; S.cellData = null; renderCell(); } else requestCell(); }
      renderSchema();
      updateStatus();
      layout();
      if (!S.loading) requestStats();
      if (savedView && !S.loading && S.columns.length) {
        const r = M.restoreView(savedView, S.columns.length, S.info.activeSheet);
        savedView = null;
        if (r) {
          if (r.widths) { S.widths = r.widths; S.autoSized = true; buildHeader(); applyWidths(); }
          grid.scrollTop = r.scrollTop;
          grid.scrollLeft = r.scrollLeft;
        }
      }
      break;
    }
    case 'rows': {
      const p = S.pending.get(msg.reqId);
      S.pending.delete(msg.reqId);
      if (!p || msg.version !== S.version) { if (p) schedule(); return; }
      S.cache.set(p.page, msg.rows);
      if (S.cache.size > 60) S.cache.delete(S.cache.keys().next().value);
      if (!S.autoSized && msg.rows.length) {
        S.autoSized = true;
        S.widths = S.columns.map((c, i) => M.autoWidth(c.name, c.type, msg.rows.slice(0, 100).map(r => r.cells[i])));
        buildHeader();
        applyWidths();
        return;
      }
      schedule();
      break;
    }
    case 'view':
      S.version = msg.version;
      S.rowCount = msg.viewCount;
      if (typeof msg.formatted === 'boolean') { S.formatted = msg.formatted; renderFormats(); }
      S.sort = msg.sort || null;
      S.cache.clear();
      S.pending.clear();
      S.anchor = S.focus = null;
      if (S.cellOpen) { S.cellData = null; renderCell(); }
      updateSortArrows();
      queryErr.textContent = '';
      flash(`Done in ${fmtN(msg.ms)} ms`);
      requestStats();
      updateStatus();
      layout();
      break;
    case 'copied':
      flash(`Copied ${fmtN(msg.rows)} rows as ${String(msg.format).toUpperCase()}` + (msg.truncated ? ' (cut at the copy limit)' : ''));
      break;
    case 'pro':
      S.pro = msg.enabled ? { enabled: true, licensed: !!msg.licensed, expires: msg.expires || null, note: msg.note || '' } : { enabled: false };
      renderPro();
      showBanner();
      layout();
      break;
    case 'stats':
      if (S.statsOpen && msg.version === S.version) renderStats(msg);
      break;
    case 'exporting':
      flash(`Exporting ${String(msg.format).toUpperCase()}…`, true);
      break;
    case 'exported':
      flash(msg.ok ? `Exported ${fmtN(msg.rows)} rows (${M.formatBytes(msg.bytes)})` : 'Export failed.');
      break;
    case 'cell':
      if (msg.reqId !== S.cellReq || !S.cellOpen) break;
      if (msg.version !== S.version || msg.missing) { S.cellData = null; renderCell(); break; }
      S.cellData = { id: msg.id, col: msg.col, value: msg.value, length: msg.length, truncated: !!msg.truncated, raw: typeof msg.raw === 'string' ? msg.raw : undefined };
      renderCell();
      break;
    case 'copiedText':
      flash(`Copied the value (${fmtN(msg.chars)} characters)`);
      break;
    case 'requestCopy':
      copy(msg.format === 'json' ? 'json' : 'csv');
      break;
    case 'error':
      if (msg.code === 'QUERY') {
        // The worker dropped the bad query and applied the other filters. Keep the text so it can be fixed.
        delete S.filters.query;
        renderPro();
        queryErr.textContent = msg.message;
        flash('The SQL filter has an error. It is not applied.');
        break;
      }
      if (msg.transient) { flash(msg.message); break; }
      S.error = msg.message;
      S.loading = false;
      renderCsvOptions();
      showBanner();
      updateStatus();
      break;
    default:
      break;
  }
});

updateStatus();
vscode.postMessage({ type: 'ready' });
