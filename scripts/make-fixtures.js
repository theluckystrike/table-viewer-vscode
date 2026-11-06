'use strict';
// Writes CSV/TSV/Excel fixtures. Run: node scripts/make-fixtures.js test/fixtures
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const out = process.argv[2];
fs.writeFileSync(path.join(out, 'sample.csv'), 'id,name,price,active,joined\r\n1,Alice,10.5,true,2024-01-02\r\n2,"Bob, Jr.",7,false,2024-02-03\r\n3,"Say ""hi""",,TRUE,2024-03-04\r\n4,"multi\nline",12.25,false,\r\n');
fs.writeFileSync(path.join(out, 'sample.tsv'), 'city\tpop\nBerlin\t3645000\nParis\t2161000\n');
fs.writeFileSync(path.join(out, 'semicolon.csv'), '﻿a;b;c\n1;2;3\n4;5;6\n');
fs.writeFileSync(path.join(out, 'ragged.csv'), 'a,b\n1,2,3\n4\n\n');
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Region', 'Units', 'Price', 'Shipped', 'Date'],
  ['North', 10, 2.5, true, new Date(Date.UTC(2024, 0, 15))],
  ['South', 20, 3.75, false, new Date(Date.UTC(2024, 1, 20))],
  ['<script>alert(1)</script>', 5, null, true, new Date(Date.UTC(2024, 2, 1))],
], { cellDates: true, UTC: true }), 'Sales');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['k', 'v'], ['a', 1], ['b', 2]]), 'Second');
XLSX.writeFile(wb, path.join(out, 'sample.xlsx'));
XLSX.writeFile(wb, path.join(out, 'sample.xls'), { bookType: 'biff8' });
XLSX.writeFile(wb, path.join(out, 'sample.ods'), { bookType: 'ods' });
