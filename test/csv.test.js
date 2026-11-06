'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CsvParser, parseCsv, detectDelimiter } = require('../src/core/csv');

test('quotes, escaped quotes, embedded newlines and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",\r\n', ',');
  assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'multi\nline', '']]);
});

test('last line without newline and empty quoted field', () => {
  assert.deepStrictEqual(parseCsv('a,b\n"",2', ','), [['a', 'b'], ['', '2']]);
  assert.deepStrictEqual(parseCsv('a,b\n1,""', ','), [['a', 'b'], ['1', '']]);
});

test('chunk boundaries anywhere give the same rows', () => {
  const text = 'h1,h2,h3\r\n"a""b",c,"d\r\ne"\r\n1,2,3\n"x",,"y"""\r\n';
  const whole = parseCsv(text, ',');
  for (let size = 1; size <= 7; size++) {
    const rows = [];
    const p = new CsvParser(',', r => rows.push(r));
    for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
    p.end();
    assert.deepStrictEqual(rows, whole, `chunk size ${size}`);
  }
});

test('stop() ends parsing', () => {
  const rows = [];
  const p = new CsvParser(',', r => { rows.push(r); if (rows.length === 2) p.stop(); });
  p.push('a\nb\nc\nd\n');
  p.end();
  assert.strictEqual(rows.length, 2);
});

test('delimiter detection', () => {
  assert.strictEqual(detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.strictEqual(detectDelimiter('a;b;c\n1;2,5;3\n'), ';');
  assert.strictEqual(detectDelimiter('a\tb\n1\t2\n'), '\t');
  assert.strictEqual(detectDelimiter('a|b|c\n1|2|3\n'), '|');
  assert.strictEqual(detectDelimiter('"x,y";b\n"1,2";3\n'), ';');
  assert.strictEqual(detectDelimiter('single\ncolumn\n'), ',');
});
