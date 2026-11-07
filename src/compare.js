'use strict';
// "Compare with Git HEAD" and "Compare with Another Table File": both tables are turned into CSV text
// (one section per Excel sheet) and shown in VS Code's own diff editor, so changed, added and removed
// rows are marked. The text comes from a read-only content provider. Nothing leaves the machine; git
// runs locally with hooks and fsmonitor switched off.

const path = require('path');
const { execFile } = require('child_process');
const { formatFromPath } = require('./core/formats');

const SCHEME = 'table-viewer-diff';
const PICK_FILTERS = { 'Data files': ['csv', 'tsv', 'tab', 'psv', 'parquet', 'pq', 'xlsx', 'xlsm', 'xlsb', 'xls', 'ods'] };

// Keeps the CSV text for the diff editor. Bounded, so long sessions do not grow forever.
class DiffStore {
  constructor(max) { this.max = max || 20; this.map = new Map(); this.seq = 0; }
  put(text) {
    const key = String(++this.seq);
    this.map.set(key, text);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return key;
  }
  get(key) { return this.map.has(key) ? this.map.get(key) : null; }
}

// Path of the virtual CSV file. The label shows in the diff tab; ".csv" lets CSV coloring apply.
function diffPath(label, fileName) {
  const safe = (s) => String(s).replace(/[\\/:*?"<>|#%]/g, '_').slice(0, 120);
  return '/' + safe(label) + '/' + safe(fileName) + '.csv';
}

function diffTitle(leftName, leftLabel, rightName, rightLabel) {
  if (leftName === rightName) return `${rightName} (${leftLabel} ↔ ${rightLabel}, as CSV)`;
  return `${leftName} ↔ ${rightName} (as CSV)`;
}

function isTableFile(p) { return !!formatFromPath(p || ''); }

// Runs git without a shell. Returns { ok, stdout (Buffer) } or { ok: false, code, error }.
function runGit(args, cwd, maxBuffer, exec) {
  const run = exec || execFile;
  return new Promise((resolve) => {
    run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'buffer', maxBuffer, timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.length ? stderr.toString('utf8') : String(err.message || err)).trim();
        return resolve({ ok: false, code: err.code, error: msg.slice(0, 400) });
      }
      resolve({ ok: true, stdout });
    });
  });
}

// Reads the committed bytes of a file. cat-file runs no textconv, smudge or LFS filter.
async function readFromHead(fsPath, maxBytes, exec) {
  const dir = path.dirname(fsPath);
  const base = path.basename(fsPath);
  const r = await runGit(['cat-file', 'blob', 'HEAD:./' + base], dir, Math.max(maxBytes, 1024 * 1024), exec);
  if (r.ok) return { ok: true, bytes: r.stdout };
  const e = r.error || '';
  if (r.code === 'ENOENT') return { ok: false, message: 'Git is not installed or not on the PATH.' };
  if (/not a git repository/i.test(e)) return { ok: false, message: 'This file is not in a Git repository.' };
  if (/exists on disk, but not in|does not exist in|not a valid object name|invalid object name|bad revision|unknown revision/i.test(e)) return { ok: false, message: 'This file has no committed version yet (it is new or the repository has no commits).' };
  if (/maxBuffer/i.test(e) || r.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ok: false, message: 'The committed version is larger than the file size limit (tableViewer.maxFileSizeMB or maxExcelSizeMB).' };
  return { ok: false, message: 'Git could not read the committed version: ' + e };
}

/** Git LFS pointer files are small text files that start with this line. */
function isLfsPointer(bytes) {
  const head = Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, Math.min(bytes.byteLength, 64)).toString('utf8');
  return head.startsWith('version https://git-lfs.github.com/spec/');
}

/**
 * Registers the text provider and the two commands.
 * toText(source, format, name) -> {ok, text, cut} | {ok:false, error}; source is {uri} or {bytes}.
 */
function registerCompare({ vscode, context, toText, maxBytes, activeUri, exec, prefix = 'tableViewer' }) {
  const store = new DiffStore();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => {
        const v = store.get(uri.query);
        return v === null ? '(This comparison is closed. Run the compare command again.)' : v;
      },
    }),
  );
  const virtualUri = (label, fileName, text) => vscode.Uri.from({ scheme: SCHEME, path: diffPath(label, fileName), query: store.put(text) });

  async function textOf(source, name, what) {
    const r = await toText(source, formatFromPath(name), name);
    if (r && r.ok) return r;
    vscode.window.showWarningMessage(`Table Viewer could not compare: ${what} could not be read. ${(r && r.error) || ''}`.trim());
    return null;
  }

  async function showDiff(left, right) {
    const title = diffTitle(left.name, left.label, right.name, right.label);
    const cut = left.cut || right.cut ? ' Only the first rows are compared (tableViewer.maxCompareRows).' : '';
    if (cut) vscode.window.showInformationMessage('Table Viewer:' + cut);
    await vscode.commands.executeCommand('vscode.diff', virtualUri(left.label, left.name, left.text), virtualUri(right.label, right.name, right.text), title, { preview: false });
  }

  function pickTarget(arg) {
    if (arg instanceof vscode.Uri) return arg;
    if (arg && arg.resourceUri instanceof vscode.Uri) return arg.resourceUri;
    return activeUri();
  }

  async function compareWithHead(arg) {
    const uri = pickTarget(arg);
    if (!uri) return vscode.window.showInformationMessage('Open a CSV, Parquet or Excel file in Table Viewer first, or right-click one in the Explorer.');
    if (!isTableFile(uri.path)) return vscode.window.showInformationMessage('Table Viewer compares .csv, .tsv, .parquet, .xlsx, .xls and .ods files.');
    if (uri.scheme !== 'file') return vscode.window.showInformationMessage('Compare with Git HEAD works on files on this computer only.');
    if (!vscode.workspace.isTrusted) return vscode.window.showInformationMessage('Compare with Git HEAD runs git, so it needs a trusted workspace. Trust this folder first, or use "Compare with Another Table File".');
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Table Viewer: comparing with Git HEAD' }, async () => {
      const head = await readFromHead(uri.fsPath, maxBytes(uri.path), exec);
      if (!head.ok) return vscode.window.showWarningMessage('Table Viewer: ' + head.message);
      const name = path.basename(uri.fsPath);
      if (isLfsPointer(head.bytes)) return vscode.window.showWarningMessage('Table Viewer: the committed version is a Git LFS pointer, not the data. Compare two checked-out files with "Compare with Another Table File" instead.');
      const left = await textOf({ bytes: head.bytes }, name, 'the committed version');
      if (!left) return undefined;
      const right = await textOf({ uri }, name, 'the file on disk');
      if (!right) return undefined;
      if (left.text === right.text) vscode.window.showInformationMessage(`Table Viewer: the values in ${name} are the same as in HEAD. Only formatting may differ.`);
      return showDiff({ name, label: 'HEAD', text: left.text, cut: left.cut }, { name, label: 'Working Tree', text: right.text, cut: right.cut });
    });
  }

  async function compareWithOther(arg, selected) {
    let a = pickTarget(arg);
    let b = null;
    if (Array.isArray(selected)) {
      const files = selected.filter((u) => u instanceof vscode.Uri && isTableFile(u.path));
      if (files.length === 2) { a = files[0]; b = files[1]; }
    }
    if (!a) {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title: 'Pick the first table file', filters: PICK_FILTERS });
      if (!picked || !picked[0]) return undefined;
      a = picked[0];
    }
    if (!b) {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title: 'Compare ' + path.posix.basename(a.path) + ' with', defaultUri: vscode.Uri.joinPath(a, '..'), filters: PICK_FILTERS });
      if (!picked || !picked[0]) return undefined;
      b = picked[0];
    }
    if (!isTableFile(a.path) || !isTableFile(b.path)) return vscode.window.showInformationMessage('Table Viewer compares .csv, .tsv, .parquet, .xlsx, .xls and .ods files.');
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Table Viewer: comparing tables' }, async () => {
      const an = path.posix.basename(a.path);
      const bn = path.posix.basename(b.path);
      const left = await textOf({ uri: a }, an, an);
      if (!left) return undefined;
      const right = await textOf({ uri: b }, bn, bn);
      if (!right) return undefined;
      return showDiff({ name: an, label: an === bn ? 'first' : 'A', text: left.text, cut: left.cut }, { name: bn, label: an === bn ? 'second' : 'B', text: right.text, cut: right.cut });
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(`${prefix}.compareWithHead`, compareWithHead),
    vscode.commands.registerCommand(`${prefix}.compareWithFile`, compareWithOther),
  );
  return { compareWithHead, compareWithOther, store };
}

module.exports = { registerCompare, readFromHead, runGit, DiffStore, diffPath, diffTitle, isTableFile, isLfsPointer, SCHEME };
