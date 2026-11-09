'use strict';
// Extension-host side of the Query panel: which files a query may read, and the query history per file.
// Pure helpers with the vscode API passed in, so the tests can run them without VS Code.

const path = require('path');
const fs = require('fs');
const { parseSql, sourcesOf } = require('./core/sql/parse');
const { formatFromPath } = require('./core/formats');

const HISTORY_KEY = 'tableViewer.queryHistory';
const HISTORY_PER_FILE = 25;
const HISTORY_FILES = 200;

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Check every 'path' source of a query. Returns {raw: {path, format, sheet?} | {error}}.
 * Rules: the workspace must be trusted; a relative path is looked up next to the open file, then in each
 * workspace folder; the file must exist and sit inside a workspace folder or the open file's folder.
 * Throws the parser's SqlError (code 'SQL') for a query that does not parse.
 */
async function resolveQueryFiles(vscode, uri, sql) {
  const ast = parseSql(sql);
  const refs = sourcesOf(ast).filter(r => r.kind === 'path');
  const out = {};
  if (!refs.length) return out;
  const trusted = vscode.workspace.isTrusted !== false;
  const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
  const here = uri.scheme === 'file' ? path.dirname(uri.fsPath) : null;
  const roots = [...(here ? [here] : []), ...folders];
  for (const ref of refs) {
    const raw = ref.value;
    if (out[raw]) continue;
    if (!trusted) { out[raw] = { error: 'Reading other files in a query needs a trusted workspace. Run "Workspaces: Manage Workspace Trust" and trust this folder.' }; continue; }
    if (!roots.length) { out[raw] = { error: 'Other files can be read only when the open file is on disk.' }; continue; }
    let rel = raw;
    let sheet = null;
    const hash = raw.lastIndexOf('#');
    if (hash > 0 && /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(raw.slice(0, hash))) { rel = raw.slice(0, hash); sheet = raw.slice(hash + 1) || null; }
    const candidates = path.isAbsolute(rel) ? [path.normalize(rel)] : roots.map(r => path.resolve(r, rel));
    let found = null;
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) { found = c; break; } } catch { /* next */ }
    }
    if (!found) { out[raw] = { error: `File not found: '${rel}'. Paths are relative to the open file's folder or to the workspace folder.` }; continue; }
    let real = found;
    try { real = fs.realpathSync(found); } catch { /* keep found */ }
    if (!roots.some(r => inside(real, r) || inside(found, r))) { out[raw] = { error: `'${rel}' is outside the workspace. A query reads only files in the open folder.` }; continue; }
    const format = formatFromPath(found);
    if (!format) { out[raw] = { error: `'${rel}' is not a CSV, TSV, Parquet or Excel file.` }; continue; }
    out[raw] = { path: found, format, ...(sheet ? { sheet } : {}) };
  }
  return out;
}

function historyFor(context, key) {
  const all = (context.workspaceState && context.workspaceState.get(HISTORY_KEY)) || {};
  const list = all[key];
  return Array.isArray(list) ? list.filter(s => typeof s === 'string').slice(0, HISTORY_PER_FILE) : [];
}

/** Newest first, no duplicates, at most 25 per file and 200 files. Stored in this workspace only. */
function pushHistory(context, key, sql) {
  if (!context.workspaceState) return;
  const text = String(sql).trim();
  if (!text) return;
  const all = { ...(context.workspaceState.get(HISTORY_KEY) || {}) };
  const list = (Array.isArray(all[key]) ? all[key] : []).filter(s => s !== text);
  list.unshift(text.slice(0, 20000));
  delete all[key];
  all[key] = list.slice(0, HISTORY_PER_FILE);
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length - HISTORY_FILES; i++) delete all[keys[i]];
  context.workspaceState.update(HISTORY_KEY, all);
}

module.exports = { resolveQueryFiles, historyFor, pushHistory, inside, HISTORY_KEY };
