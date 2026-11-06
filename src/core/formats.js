'use strict';
const path = require('path');

const FORMATS = {
  '.csv': 'csv', '.tsv': 'tsv', '.tab': 'tsv', '.psv': 'csv',
  '.parquet': 'parquet', '.pq': 'parquet',
  '.xlsx': 'excel', '.xlsm': 'excel', '.xlsb': 'excel', '.xls': 'excel', '.ods': 'excel',
};

function formatFromPath(p) {
  return FORMATS[path.extname(String(p)).toLowerCase()] || null;
}

module.exports = { FORMATS, formatFromPath };
