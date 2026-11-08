'use strict';
// Turns a data file into plain CSV text for VS Code's diff editor ("Compare with Git HEAD" and
// "Compare with Another Table File"). Excel workbooks give one section per sheet. Values are the raw
// values (not the Excel display text), so a change from 0.251 to 0.25 shows even if both display as 25%.

const { loadFile } = require('./readers');
const { formatValue, csvEscape } = require('./table');

function tableCsv(table, maxRows) {
  const n = Math.min(table.rowCount, maxRows);
  const lines = [table.columns.map(c => csvEscape(c.name, ',')).join(',')];
  for (let r = 0; r < n; r++) {
    const cells = new Array(table.columns.length);
    for (let c = 0; c < table.columns.length; c++) cells[c] = csvEscape(formatValue(table.get(r, c), table.columns[c].type), ',');
    lines.push(cells.join(','));
  }
  return { text: lines.join('\n'), cut: table.rowCount > n, rows: n };
}

/**
 * @param {{path?:string, bytes?:Uint8Array}} source
 * @param {string} format csv | tsv | parquet | excel
 * @param {object} options reader options (maxRows, delimiter, ...)
 * @param {number} maxRows rows per table in the text
 * @returns {Promise<{text:string, rows:number, cut:boolean, sheets:number}>}
 */
async function tableToText(source, format, options, maxRows) {
  const limit = Math.max(1, Math.floor(Number(maxRows) || 100000));
  const res = await loadFile(source, format, { ...(options || {}), maxRows: limit + 1 }, null);
  const note = `(cut at ${limit.toLocaleString('en-US')} rows, setting tableViewer.maxCompareRows)`;
  if (format === 'excel' && res.loadSheet && res.info.sheets && res.info.sheets.length > 1) {
    const parts = [];
    let rows = 0, cut = false;
    for (const name of res.info.sheets) {
      const t = name === res.info.activeSheet ? res.table : (await res.loadSheet(name)).table;
      const one = tableCsv(t, limit);
      rows += one.rows;
      cut = cut || one.cut;
      parts.push(`=== Sheet: ${name} ===\n${one.text}${one.cut ? '\n' + note : ''}`);
    }
    return { text: parts.join('\n\n') + '\n', rows, cut, sheets: res.info.sheets.length };
  }
  const one = tableCsv(res.table, limit);
  return { text: one.text + (one.cut ? '\n' + note : '') + '\n', rows: one.rows, cut: one.cut, sheets: 1 };
}

module.exports = { tableToText, tableCsv };
