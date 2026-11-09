'use strict';
// Save the rows in view as a Parquet file (hyparquet-writer, MIT). Used for "Save result" in the Query panel
// and for Export. Columns are typed from the grid: numbers, booleans, timestamps, else text.

const fs = require('fs');
const { formatValue } = require('./table');

function parquetColumns(table) {
  const n = table.viewCount;
  const cols = [];
  table.columns.forEach((c, ci) => {
    const vals = new Array(n);
    let allNum = true, allInt = true, allBool = true, allDate = true, any = false;
    for (let r = 0; r < n; r++) {
      const v = table.get(table.rowId(r), ci);
      vals[r] = v === undefined ? null : v;
      if (v === null || v === undefined) continue;
      any = true;
      if (typeof v === 'bigint') { allBool = false; allDate = false; if (!Number.isSafeInteger(Number(v))) allNum = false; continue; }
      if (typeof v !== 'number') allNum = false; else if (!Number.isSafeInteger(v)) allInt = false;
      if (typeof v !== 'boolean') allBool = false;
      if (!(v instanceof Date)) allDate = false;
    }
    let type, data;
    if (any && allNum && allInt && (c.type === 'int' || c.type === 'decimal' || vals.some(v => typeof v === 'bigint'))) {
      type = 'INT64';
      data = vals.map(v => (v === null ? null : BigInt(typeof v === 'bigint' ? v : Math.trunc(v))));
    } else if (any && allNum) {
      type = 'DOUBLE';
      data = vals.map(v => (v === null ? null : Number(v)));
    } else if (any && allBool) {
      type = 'BOOLEAN';
      data = vals;
    } else if (any && allDate) {
      type = 'TIMESTAMP';
      data = vals;
    } else {
      type = 'STRING';
      data = vals.map(v => (v === null ? null : typeof v === 'string' ? v : formatValue(v, c.type)));
    }
    cols.push({ name: c.name, data, type, nullable: true });
  });
  return cols;
}

/** Writes the view to `file`; returns the number of bytes. */
async function writeParquet(file, table) {
  const { parquetWriteBuffer } = await import('hyparquet-writer');
  const columnData = parquetColumns(table);
  const buf = parquetWriteBuffer({ columnData, rowGroupSize: 100000 });
  await fs.promises.writeFile(file, Buffer.from(buf));
  return buf.byteLength;
}

module.exports = { writeParquet, parquetColumns };
