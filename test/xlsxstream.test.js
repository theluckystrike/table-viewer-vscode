'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const XLSX = require('xlsx');
const { openXlsx } = require('../src/core/xlsxstream');

const F = name => path.join(__dirname, 'fixtures', name);

// ---------- helpers ----------

/** Minimal ZIP writer: files = {name: string|Buffer}; method 8 (deflate) unless store:true. */
function makeZip(files, { store = false } = {}) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = store ? data : zlib.deflateRawSync(data);
    const nameB = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, nameB, comp);
    centrals.push(ch, nameB);
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const n = Object.keys(files).length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(n, 8); eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Hand-written workbook. sheets = [{name, xml(sheetData inner), dim?}], sst = [si inner xml], styles = cellXfs numFmtIds */
function handXlsx({ sheets, sst = null, numFmts = [], xfs = [0], date1904 = false, rawSheet = null, raw = {} }) {
  const files = {};
  const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  files['[Content_Types].xml'] = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>`
    + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${ct}.worksheet+xml"/>`).join('')
    + `<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>`
    + (sst ? `<Override PartName="/xl/sharedStrings.xml" ContentType="${ct}.sharedStrings+xml"/>` : '') + '</Types>';
  files['_rels/.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${RNS}"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  let rels = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${RNS}/worksheet" Target="${i % 2 ? '/xl/worksheets/' : 'worksheets/'}sheet${i + 1}.xml"/>`).join('');
  rels += `<Relationship Id="rS" Type="${RNS}/styles" Target="styles.xml"/>`;
  if (sst) rels += `<Relationship Id="rT" Type="${RNS}/sharedStrings" Target="sharedStrings.xml"/>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  files['xl/styles.xml'] = `<?xml version="1.0"?><styleSheet xmlns="${NS}"><numFmts count="${numFmts.length}">${numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>`).join('')}</numFmts><cellXfs count="${xfs.length}">${xfs.map(id => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id ? ' applyNumberFormat="1"' : ''}/>`).join('')}</cellXfs></styleSheet>`;
  if (sst) files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="${NS}" count="${sst.length}" uniqueCount="${sst.length}">${sst.map(s => `<si>${s}</si>`).join('')}</sst>`;
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = rawSheet && i === 0 ? rawSheet
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${RNS}">${s.dim ? `<dimension ref="${s.dim}"/>` : ''}<sheetData>${s.xml}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  });
  Object.assign(files, raw); // replace whole parts
  return makeZip(files);
}

const READ_OPTS = { type: 'buffer', dense: true, cellDates: true, cellNF: false, cellHTML: false, cellStyles: false, UTC: true, cellFormula: true };
const J = { header: 1, defval: null, blankrows: false, UTC: true };

const same = (a, b) => (a instanceof Date || b instanceof Date)
  ? (a instanceof Date && b instanceof Date && a.getTime() === b.getTime())
  : (Number.isNaN(a) && Number.isNaN(b)) || a === b;

/**
 * Asserts that xlsxstream gives what readers.js gets from SheetJS: rows (raw), shown (raw:false text of
 * number/date/boolean cells, error text for error cells) and formulas (cell.f). extraFormulasOk: formula
 * cells without a cached value, which SheetJS drops, may have formula text in our output.
 */
async function assertMatchesSheetJS(buf, label, { extraFormulasOk = true } = {}) {
  const wb = XLSX.read(buf, READ_OPTS);
  const ws = await openXlsx({ bytes: new Uint8Array(buf) });
  assert.deepStrictEqual(ws.sheets, wb.SheetNames, `${label}: sheet names`);
  for (const name of ws.sheets) {
    const sh = wb.Sheets[name];
    const exp = XLSX.utils.sheet_to_json(sh, { ...J, raw: true });
    const expW = XLSX.utils.sheet_to_json(sh, { ...J, raw: false });
    const got = await ws.readSheet(name);
    const where = `${label}/${name}`;
    assert.strictEqual(got.rows.length, exp.length, `${where}: row count`);
    assert.strictEqual(got.totalRows, exp.length, `${where}: totalRows`);
    assert.strictEqual(got.truncated, false);
    for (let r = 0; r < exp.length; r++) {
      assert.strictEqual(got.rows[r].length, exp[r].length, `${where}: width of row ${r}`);
      assert.strictEqual(got.rows[r].length, got.width);
      for (let c = 0; c < exp[r].length; c++) {
        const ev = exp[r][c], gv = got.rows[r][c];
        assert.ok(same(gv, ev), `${where}: [${r}][${c}] value ${String(gv)} !== ${String(ev)}`);
        if (typeof ev === 'number' || ev instanceof Date || typeof ev === 'boolean') {
          let gw = got.shown[r] ? got.shown[r][c] : null;
          if (gw === null && typeof ev === 'number') gw = String(ev);
          assert.strictEqual(gw, expW[r][c], `${where}: [${r}][${c}] shown`);
        }
      }
    }
    // formulas and error text: map output rows back to sheet rows (the non-blank rows of the range)
    const range = sh['!ref'] ? XLSX.utils.decode_range(sh['!ref']) : null;
    if (!range) continue;
    const dense = sh['!data'] || [];
    let r = 0, nf = 0;
    for (let R = range.s.r; R <= range.e.r; R++) {
      const row = dense[R] || [];
      let nb = false;
      for (let C = range.s.c; C <= range.e.c; C++) { const cl = row[C]; if (cl && cl.t !== 'e' && cl.t !== 'z' && cl.v != null) nb = true; }
      if (!nb) continue;
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cl = row[C], c = C - range.s.c;
        const gf = got.formulas && got.formulas[r] ? got.formulas[r][c] : null;
        if (cl && cl.f !== undefined) { nf++; assert.strictEqual(gf, cl.f, `${where}: [${r}][${c}] formula`); } else if (gf !== null) {
          assert.ok(extraFormulasOk && !cl, `${where}: [${r}][${c}] unexpected formula ${gf}`);
        }
        if (cl && cl.t === 'e') assert.strictEqual(got.shown[r] && got.shown[r][c], cl.w, `${where}: [${r}][${c}] error text`);
      }
      r++;
    }
    if (!nf && !extraFormulasOk) assert.strictEqual(got.formulas, null, `${where}: formulas should be null`);
  }
  return ws;
}

function sheetjsBook(sheets, props) {
  const wb = XLSX.utils.book_new();
  if (props) wb.Workbook = { WBProps: props };
  for (const [name, ws] of sheets) XLSX.utils.book_append_sheet(wb, ws, name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

// ---------- equality with SheetJS ----------

test('fixtures: every test/fixtures/*.xlsx matches SheetJS', async () => {
  const names = fs.readdirSync(path.join(__dirname, 'fixtures')).filter(n => /\.xlsx$/i.test(n));
  assert.ok(names.length > 0);
  for (const n of names) await assertMatchesSheetJS(fs.readFileSync(F(n)), n);
});

test('fixture from path equals fixture from bytes', async () => {
  const a = await openXlsx({ path: F('sample.xlsx') });
  const b = await openXlsx({ bytes: new Uint8Array(fs.readFileSync(F('sample.xlsx'))) });
  assert.deepStrictEqual(a.sheets, b.sheets);
  for (const s of a.sheets) assert.deepStrictEqual(await a.readSheet(s), await b.readSheet(s));
});

test('SheetJS-written workbook: dates, times, formats, booleans, errors, blank and ragged rows', async () => {
  const d = (y, m, dd, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, m - 1, dd, h, mi, s));
  const ws = XLSX.utils.aoa_to_sheet([
    ['name', 'when', 'time', 'pct', 'money', 'custom', 'flag', 'big'],
    ['a', d(2024, 1, 15), d(1899, 12, 30, 13, 45, 10), 0.257, 1234.5, 42, true, 1e15],
    [],
    ['b', d(2026, 11, 8, 17, 56, 5), d(1899, 12, 30, 0, 0, 1), -0.5, -99.999, 3.14159, false, 123456789012],
    ['ragged'],
    [null, null, null, null, null, null, null, 0.1 + 0.2],
    ['c', 45000, 0.75, 1, 0, -7, true, 1 / 3, 'extra col'],
  ], { cellDates: true });
  const fmt = (ref, z) => { ws[ref].z = z; };
  fmt('B2', 'yyyy-mm-dd'); fmt('B4', 'dd/mm/yyyy hh:mm:ss'); fmt('C2', 'h:mm:ss AM/PM'); fmt('C4', '[h]:mm:ss');
  fmt('D2', '0.0%'); fmt('D4', '0%'); fmt('E2', '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)'); fmt('E4', '#,##0.00;[Red]-#,##0.00');
  fmt('F2', '000000'); fmt('F4', '# ?/?'); fmt('B7', 'm/d/yy'); fmt('C7', 'h:mm'); fmt('D7', '0.00E+00'); fmt('E7', '@');
  ws.A9 = { t: 'e', v: 0x07 }; ws.B9 = { t: 'e', v: 0x2A }; ws.A10 = { t: 'e', v: 0x00 }; ws.B10 = { t: 's', v: '' };
  ws['!ref'] = 'A1:I10';
  const one = XLSX.utils.aoa_to_sheet([[7]]);
  await assertMatchesSheetJS(sheetjsBook([['Data', ws], ['One', one]]), 'sheetjs-types');
});

test('1904 date system', async () => {
  const xml = '<row r="1"><c r="A1" s="1"><v>42886</v></c><c r="B1" s="2"><v>42886.25</v></c><c r="C1" s="3"><v>0.5</v></c><c r="D1"><v>3</v></c><c r="E1" t="d" s="1"><v>2021-06-01</v></c></row>';
  const buf = handXlsx({ sheets: [{ name: 'S', xml, dim: 'A1:E1' }], date1904: true, numFmts: [[164, 'yyyy-mm-dd hh:mm']], xfs: [0, 14, 164, 21] });
  const x = await assertMatchesSheetJS(buf, '1904');
  assert.strictEqual(x.date1904, true);
  const r = await x.readSheet('S');
  assert.strictEqual(r.rows[0][0].toISOString(), '2021-06-01T00:00:00.000Z');
  assert.strictEqual(r.shown[0][1], '2021-06-01 06:00');
  // and the same through SheetJS' writer (dates written with date1904)
  const ws = XLSX.utils.aoa_to_sheet([['d'], [new Date(Date.UTC(2020, 5, 1))], [45000]], { cellDates: true });
  ws.A2.z = 'yyyy-mm-dd'; ws.A3.z = 'd-mmm-yy';
  await assertMatchesSheetJS(sheetjsBook([['S', ws]], { date1904: true }), '1904 sheetjs');
});

test('data starting at column C, with and without <dimension>', async () => {
  const xml = '<row r="3"><c r="C3" t="s"><v>0</v></c><c r="D3"><v>1</v></c></row><row r="5"><c r="E5"><v>2.5</v></c></row>';
  for (const dim of ['C3:E5', null, 'A1']) {
    const buf = handXlsx({ sheets: [{ name: 'S', xml, dim }], sst: ['<t>hdr</t>'] });
    await assertMatchesSheetJS(buf, `startC dim=${dim}`);
    const r = await (await openXlsx({ bytes: buf })).readSheet('S');
    assert.deepStrictEqual(r.rows, [['hdr', 1, null], [null, null, 2.5]]);
  }
  // a dimension wider than the data pads like SheetJS
  const buf = handXlsx({ sheets: [{ name: 'S', xml, dim: 'B2:G9' }], sst: ['<t>hdr</t>'] });
  await assertMatchesSheetJS(buf, 'wide dim');
});

test('hand-written XML: shared strings (rich text, phonetic, entities), inline strings, t="str", t="d", cells without r', async () => {
  const sst = [
    '<t>plain</t>',
    '<r><rPr><b/><vertAlign val="superscript"/></rPr><t>Bo</t></r><r><t xml:space="preserve">ld </t></r><rPh sb="0" eb="1"><t>ボ</t></rPh>',
    '<t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/>',
    '<t>a &amp; b &lt;c&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42; line_x000D_\r\nnext _x005F_x0041_</t>',
    '<t/>',
    '<t xml:space="preserve">  spaced  </t>',
  ];
  const xml = [
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>',
    '<row r="2"><c t="s"><v>4</v></c><c t="s"><v>5</v></c><c t="inlineStr"><is><t>in&amp;line</t></is></c><c t="inlineStr"><is><r><t>ri</t></r><r><rPr><i/></rPr><t>ch</t></r></is></c></row>',
    '<row><c r="A3" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c s="0" t="b" r="B3"><v>1</v></c><c r="C3" t="d"><v>2024-03-05T10:20:30</v></c><c r="D3" t="d" s="1"><v>2024-03-05</v></c></row>',
    '<row r="4"><c r="A4" s="1"/><c r="B4"/><c r="C4" t="n"/></row>', // only empty cells: blank row
    '<row r="6" spans="1:4" x14ac:dyDescent="0.25"><c r="B6" s="2"><v>45000.5</v></c><c r="C6" s="3"><v>0.125</v></c><c r="D6" s="4"><v>-1234.5</v></c></row>',
    '<row r="7"><c r="A7" t="str"><v></v></c></row>', // empty string from a str cell: not blank
  ].join('');
  const buf = handXlsx({
    sheets: [{ name: 'S', xml, dim: 'A1:D7' }], sst,
    numFmts: [[164, 'yyyy-mm-dd hh:mm'], [165, '#,##0.0" units"'], [166, '[Blue]#,##0.00;[Red]-#,##0.00']],
    xfs: [0, 14, 164, 165, 166],
  });
  await assertMatchesSheetJS(buf, 'hand-strings');
  const r = await (await openXlsx({ bytes: buf })).readSheet('S');
  assert.deepStrictEqual(r.rows[0], ['plain', 'Bold ', '東京', 'a & b <c> "q" \'s\' AB line\r\nnext _x0041_']);
  assert.deepStrictEqual(r.rows[1], ['', '  spaced  ', 'in&line', 'rich']);
  assert.strictEqual(r.rows.length, 5);
  assert.strictEqual(r.formulas[2][0], '"x"&"y"');
});

test('shared formulas are expanded like SheetJS; array formulas; formula without cached value', async () => {
  const xml = [
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><f t="shared" ref="C1:D3" si="0">A1+$B$1*B$1+$A1+Other!A1+SUM(A1:B1)+_xlfn.XLOOKUP(A1,A1:A3,B1:B3)</f><v>9</v></c><c r="D1"><f t="shared" si="0"/><v>9</v></c></row>',
    '<row r="2"><c r="A2"><v>3</v></c><c r="C2"><f t="shared" si="0"/><v>9</v></c><c r="D2"><f t="shared" si="0"></f><v>9</v></c></row>',
    '<row r="3"><c r="A3"><v>5</v></c><c r="C3"><f t="shared" si="0"/><v>9</v></c><c r="D3"><f t="shared" si="0"/><v>9</v></c>',
    '<c r="E3"><f t="array" ref="E3:E4">SUM(A1:A3*B1:B3)</f><v>11</v></c></row>',
    '<row r="4"><c r="A4"><v>7</v></c><c r="E4"><v>0</v></c><c r="F4"><f>A4*2</f><v></v></c><c r="G4" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>',
    '<row r="5"><c r="F5"><f>A5*2</f></c></row>', // only a formula without value: blank row
  ].join('');
  const buf = handXlsx({ sheets: [{ name: 'S', xml, dim: 'A1:G5' }] });
  await assertMatchesSheetJS(buf, 'shared-formulas');
  const r = await (await openXlsx({ bytes: buf })).readSheet('S');
  assert.strictEqual(r.formulas[1][3], 'B2+$B$1*C$1+$A2+Other!B2+SUM(B2:C2)+XLOOKUP(B2,B2:B4,C2:C4)');
  assert.strictEqual(r.rows[3][5], null); // no cached value -> null (as SheetJS) ...
  assert.strictEqual(r.formulas[3][5], 'A4*2'); // ... but the formula text is kept
  assert.strictEqual(r.rows[3][6], null); // error value -> null (as SheetJS raw) ...
  assert.strictEqual(r.shown[3][6], '#DIV/0!'); // ... error text in shown
  assert.strictEqual(r.rows.length, 4);
});

test('shared formula: string literals, quoted sheet names and structured refs are not shifted', async () => {
  const xml = '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="3">"A1"&amp;\'Q1 Data\'!B1&amp;Table1[[#This Row],[C1]]&amp;B1</f><v>1</v></c></row>'
    + '<row r="2"><c r="A2"><f t="shared" si="3"/><v>1</v></c></row>';
  const r = await (await openXlsx({ bytes: handXlsx({ sheets: [{ name: 'S', xml, dim: 'A1:A2' }] }) })).readSheet('S');
  assert.strictEqual(r.formulas[1][0], '"A1"&\'Q1 Data\'!B2&Table1[[#This Row],[C1]]&B2');
});

test('sheet with no formulas has formulas: null; empty sheet; single cell sheet', async () => {
  const buf = handXlsx({ sheets: [{ name: 'A', xml: '<row r="1"><c r="B2"><v>1</v></c></row>', dim: 'B2:B2' }, { name: 'B', xml: '' }] });
  const ws = await openXlsx({ bytes: buf });
  assert.deepStrictEqual(ws.sheets, ['A', 'B']);
  const a = await ws.readSheet('A');
  assert.deepStrictEqual(a, { rows: [[1]], shown: [null], formulas: null, totalRows: 1, width: 1, truncated: false });
  const b = await ws.readSheet('B');
  assert.deepStrictEqual(b.rows, []);
  assert.strictEqual(b.totalRows, 0);
  await assert.rejects(ws.readSheet('nope'), /No worksheet/);
  const self = handXlsx({ sheets: [{ name: 'A', xml: '' }], rawSheet: `<worksheet xmlns="${NS}"><sheetData/></worksheet>` });
  assert.deepStrictEqual((await (await openXlsx({ bytes: self })).readSheet('A')).rows, []);
});

test('maxRows stops early (truncated, totalRows null); onPreview is called once; countAll counts', async () => {
  const N = 2500;
  let xml = '<row r="1"><c r="A1" t="inlineStr"><is><t>n</t></is></c><c r="B1" t="inlineStr"><is><t>f</t></is></c></row>';
  for (let i = 2; i <= N + 1; i++) xml += `<row r="${i}"><c r="A${i}"><v>${i}</v></c><c r="B${i}"><f>A${i}*2</f><v>${i * 2}</v></c></row>${i % 7 ? '' : `<row r="${i}x"/>`}`;
  const buf = handXlsx({ sheets: [{ name: 'S', xml: xml.replace(/<row r="\d+x"\/>/g, '<row/>') }] });
  const ws = await openXlsx({ bytes: buf });
  const previews = [];
  const cut = await ws.readSheet('S', { maxRows: 1500, onPreview: (rows, shown, formulas) => previews.push([rows.length, rows[0][0], rows[999][0], formulas[999][1]]) });
  assert.strictEqual(cut.rows.length, 1500);
  assert.strictEqual(cut.truncated, true);
  assert.strictEqual(cut.totalRows, null);
  assert.deepStrictEqual(previews, [[1000, 'n', 1000, 'A1000*2']]);
  const all = await ws.readSheet('S', { maxRows: 1500, countAll: true });
  assert.strictEqual(all.totalRows, N + 1);
  assert.strictEqual(all.rows.length, 1500);
  assert.strictEqual(all.truncated, true);
  let calls = 0;
  const full = await ws.readSheet('S', { previewRows: 10, onPreview: () => calls++ });
  assert.strictEqual(calls, 1);
  assert.strictEqual(full.rows.length, N + 1);
  assert.strictEqual(full.totalRows, N + 1);
  assert.strictEqual(full.truncated, false);
  // a wider row past maxRows does not widen the returned rows
  const wide = handXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="D2"><v>3</v></c></row>' }] });
  const w1 = await (await openXlsx({ bytes: wide })).readSheet('S', { maxRows: 1, countAll: true });
  assert.deepStrictEqual([w1.rows, w1.width, w1.totalRows], [[[1]], 1, 2]);
  let none = 0;
  await ws.readSheet('S', { previewRows: N + 1, onPreview: () => none++ }); // not more rows than previewRows
  assert.strictEqual(none, 0);
  await assertMatchesSheetJS(buf, 'many rows');
});

test('a {path} source streams from disk and gives the same result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxstream-'));
  try {
    const buf = handXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c></row>' }] });
    const p = path.join(dir, 'a.xlsm');
    fs.writeFileSync(p, buf);
    const r = await (await openXlsx({ path: p })).readSheet('S');
    assert.deepStrictEqual(r.rows, [[1], ['x']]);
    // the file changing between open and read is refused
    const ws = await openXlsx({ path: p });
    fs.appendFileSync(p, Buffer.alloc(10));
    await assert.rejects(ws.readSheet('S'), /changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- hostile and damaged files ----------

test('hostile: sheet that inflates past maxInflatedMB -> XLSX_TOO_BIG', async () => {
  const row = '<row><c><v>1</v></c></row>';
  const big = row.repeat(Math.ceil(1.5 * 1024 * 1024 / row.length)); // ~1.5 MB of XML, compresses to a few KB
  const buf = handXlsx({ sheets: [{ name: 'S', xml: big }] });
  assert.ok(buf.length < 100 * 1024);
  const ws = await openXlsx({ bytes: buf }, { maxInflatedMB: 1 });
  await assert.rejects(ws.readSheet('S'), e => e.code === 'XLSX_TOO_BIG');
  // with maxRows the read stops before the cap
  const r = await ws.readSheet('S', { maxRows: 10 });
  assert.strictEqual(r.rows.length, 10);
  // a too-big sharedStrings is caught in openXlsx
  const sbuf = handXlsx({ sheets: [{ name: 'S', xml: '' }], sst: new Array(60000).fill('<t>aaaaaaaaaaaaaaaaaaaa</t>') });
  await assert.rejects(openXlsx({ bytes: sbuf }, { maxInflatedMB: 1 }), e => e.code === 'XLSX_TOO_BIG');
  await assert.rejects(openXlsx({ bytes: sbuf }, { maxSharedStringChars: 1000 }), e => e.code === 'XLSX_TOO_BIG');
});

test('hostile: truncated zip, central directory outside the file, non-zip bytes, empty file', async () => {
  const good = handXlsx({ sheets: [{ name: 'S', xml: '<row><c><v>1</v></c></row>' }] });
  await assert.rejects(openXlsx({ bytes: good.subarray(0, good.length - 30) }), e => e instanceof Error && !e.code);
  await assert.rejects(openXlsx({ bytes: good.subarray(0, Math.floor(good.length / 2)) }), Error);
  const bad = Buffer.from(good);
  bad.writeUInt32LE(good.length + 1000, bad.length - 6); // EOCD central directory offset
  await assert.rejects(openXlsx({ bytes: bad }), /outside the file/);
  // every local header offset -> far away
  const badLocal = Buffer.from(good);
  for (let p = good.readUInt32LE(good.length - 6); badLocal.readUInt32LE(p) === 0x02014b50; p += 46 + badLocal.readUInt16LE(p + 28)) badLocal.writeUInt32LE(0x7ffffff0, p + 42);
  await assert.rejects(openXlsx({ bytes: badLocal }).then(ws => ws.readSheet('S')), /outside the file/);
  await assert.rejects(openXlsx({ bytes: Buffer.from('this is not a zip file at all, just text'.repeat(10)) }), /Not a ZIP/);
  await assert.rejects(openXlsx({ bytes: new Uint8Array(0) }), /Not a ZIP/);
  // damaged deflate data inside the sheet entry
  const zipped = handXlsx({ sheets: [{ name: 'S', xml: '<row><c><v>1</v></c></row>'.repeat(5000) }] });
  const ws = await openXlsx({ bytes: zipped });
  const i = zipped.indexOf('xl/worksheets/sheet1.xml') + 'xl/worksheets/sheet1.xml'.length; // first occurrence: local header name
  const broken = Buffer.from(zipped);
  for (let k = i + 20; k < i + 60; k++) broken[k] ^= 0xff;
  await assert.rejects((await openXlsx({ bytes: broken })).readSheet('S'), Error);
  assert.ok(ws);
});

test('hostile: huge row/column numbers and bad shared string indexes do not allocate or crash', async () => {
  const xml = '<row r="99999999"><c r="A99999999"><v>1</v></c><c r="XFE99999999"><v>2</v></c><c r="ZZZZZ1"><v>3</v></c></row>'
    + '<row r="100000000"><c r="B100000000" t="s"><v>7</v></c><c r="C100000000" t="s"><v>-1</v></c><c r="D100000000" t="s"><v>99999999999999999999</v></c><c r="E100000000"><v>4</v></c></row>';
  const buf = handXlsx({ sheets: [{ name: 'S', xml }], sst: ['<t>only</t>'] });
  const r = await (await openXlsx({ bytes: buf })).readSheet('S');
  assert.deepStrictEqual(r.rows, [[1, null, null, null, null], [null, null, null, null, 4]]);
  assert.strictEqual(r.width, 5);
  // a dimension claiming the whole sheet does not pre-size rows to 16384 columns
  const wide = handXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1"><v>1</v></c></row>', dim: 'A1:XFD1048576' }] });
  assert.deepStrictEqual((await (await openXlsx({ bytes: wide })).readSheet('S')).rows, [[1]]);
  // rows x width is capped
  let many = '';
  for (let i = 1; i <= 200; i++) many += `<row r="${i}"><c r="A${i}"><v>1</v></c><c r="XFD${i}"><v>2</v></c></row>`;
  const mbuf = handXlsx({ sheets: [{ name: 'S', xml: many }] });
  await assert.rejects((await openXlsx({ bytes: mbuf }, { maxCells: 1e6 })).readSheet('S'), e => e.code === 'XLSX_TOO_BIG');
});

test('hostile: DOCTYPE entities in sharedStrings are not expanded or resolved', async () => {
  const sstXml = `<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY a "lollollol"><!ENTITY b "&a;&a;&a;&a;">]><sst xmlns="${NS}"><si><t>&xxe;</t></si><si><t>&b;</t></si></sst>`;
  const buf = handXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' }], sst: [], raw: { 'xl/sharedStrings.xml': sstXml } });
  const r = await (await openXlsx({ bytes: buf })).readSheet('S');
  assert.deepStrictEqual(r.rows, [['&xxe;', '&b;']]);
});

test('unsupported variants throw XLSX_STREAM_UNSUPPORTED (caller falls back to SheetJS)', async () => {
  const unsupported = e => e.code === 'XLSX_STREAM_UNSUPPORTED';
  const prefixed = handXlsx({ sheets: [{ name: 'S', xml: '' }], rawSheet: `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>` });
  await assert.rejects((await openXlsx({ bytes: prefixed })).readSheet('S'), unsupported);
  const strictSheet = handXlsx({ sheets: [{ name: 'S', xml: '' }], rawSheet: '<worksheet xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"><sheetData/></worksheet>' });
  await assert.rejects((await openXlsx({ bytes: strictSheet })).readSheet('S'), unsupported);
  const strictWb = handXlsx({ sheets: [{ name: 'S', xml: '' }], raw: { 'xl/workbook.xml': `<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="${RNS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` } });
  await assert.rejects(openXlsx({ bytes: strictWb }), unsupported);
  const xlsb = makeZip({ '_rels/.rels': '<Relationships/>', 'xl/workbook.bin': Buffer.alloc(10) });
  await assert.rejects(openXlsx({ bytes: xlsb }), unsupported);
});

// ---------- extra corpus (only on machines that have it) ----------

const CORPUS = [
  '/Users/mike/plugin-market-intel-work/run-20261107/wave11/out/SQL2-samples/dl-table',
  '/Users/mike/plugin-market-intel-work/run-20261107/wave11/out/VER7-samples/sql2/table',
];
test('extra corpus matches SheetJS where SheetJS can read it', { skip: !CORPUS.every(d => fs.existsSync(d)) }, async () => {
  for (const dir of CORPUS) {
    for (const n of fs.readdirSync(dir).filter(x => /\.xlsx$/i.test(x))) {
      const p = path.join(dir, n);
      const size = fs.statSync(p).size;
      if (size > 8 * 1024 * 1024) continue; // the 1M-row zip bomb is checked below
      if (n === 'protected_passtika.xlsx' || size === 0) {
        await assert.rejects(openXlsx({ path: p }), /Not a ZIP/, n);
        continue;
      }
      await assertMatchesSheetJS(fs.readFileSync(p), n);
    }
  }
  const bomb = path.join(CORPUS[1], 'zip-bomb-1m-rows.xlsx');
  if (fs.existsSync(bomb)) {
    const ws = await openXlsx({ path: bomb });
    const r = await ws.readSheet(ws.sheets[0], { maxRows: 5000 });
    assert.strictEqual(r.rows.length, 5000);
    assert.strictEqual(r.truncated, true);
  }
});
