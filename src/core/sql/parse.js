'use strict';
// SELECT parser for the Query panel. Own code, no dependencies, no eval.
//
//   SELECT [DISTINCT] expr [AS alias], ... | *
//   FROM this | "Sheet 2" | 'data/orders.csv' | (SELECT ...) [AS] alias
//   [INNER | LEFT [OUTER] | CROSS] JOIN <source> [ON expr] ...
//   WHERE expr  GROUP BY expr|n, ...  HAVING expr  ORDER BY expr|n [ASC|DESC] [NULLS FIRST|LAST], ...
//   LIMIT n [OFFSET m]
//
// Expressions: + - * / % ||, = != <> < <= > >=, AND OR NOT, [NOT] LIKE / ILIKE, [NOT] IN (...),
// [NOT] BETWEEN a AND b, IS [NOT] NULL, CASE, CAST(x AS type), function calls, COUNT(*), COUNT(DISTINCT x).
// Names: bare, "double quoted", `backticks` or [brackets]; t.col for a column of one source.

const MAX_SQL_LEN = 20000;
const MAX_EXPR_DEPTH = 64;
const MAX_SUBQUERY_DEPTH = 8;

const KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'LIMIT', 'OFFSET', 'AS', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'AND', 'OR', 'NOT', 'LIKE',
  'ILIKE', 'IN', 'BETWEEN', 'IS', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'UNION', 'USING',
]);

class SqlError extends Error {
  constructor(message, pos) { super(message); this.code = 'SQL'; this.pos = pos; }
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') { i++; continue; }
    if (ch === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new SqlError(`The comment that starts at character ${i + 1} has no closing */.`, i);
      i = e + 2;
      continue;
    }
    const start = i;
    if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new SqlError(`Text that starts at character ${start + 1} has no closing quote.`, start);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      toks.push({ t: 'str', v: s, pos: start, end: i });
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new SqlError(`The name that starts at character ${start + 1} has no closing ${close}.`, start);
        if (src[i] === close) {
          if (close !== ']' && src[i + 1] === close) { s += close; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      toks.push({ t: 'id', v: s, quoted: true, pos: start, end: i });
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
      if (m && !/[\p{L}_]/u.test(src[i + m[0].length] || '')) {
        toks.push({ t: 'num', v: Number(m[0]), text: m[0], pos: start, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>' || two === '==' || two === '||') {
      toks.push({ t: 'op', v: two === '<>' ? '!=' : two === '==' ? '=' : two, pos: start, end: i + 2 });
      i += 2;
      continue;
    }
    if ('<>=+-*/%'.includes(ch)) { toks.push({ t: 'op', v: ch, pos: start, end: i + 1 }); i++; continue; }
    if ('(),.;'.includes(ch)) { toks.push({ t: ch, pos: start, end: i + 1 }); i++; continue; }
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(src.slice(i, i + 300));
    if (word) {
      const up = word[0].toUpperCase();
      if (KEYWORDS.has(up)) toks.push({ t: 'kw', v: up, raw: word[0], pos: start, end: i + word[0].length });
      else toks.push({ t: 'id', v: word[0], quoted: false, pos: start, end: i + word[0].length });
      i += word[0].length;
      continue;
    }
    throw new SqlError(`Unexpected "${ch}" at character ${i + 1}.`, i);
  }
  return toks;
}

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'MEDIAN']);

/**
 * Parse one SELECT statement. Returns the AST; throws SqlError with a plain message.
 */
function parseSql(src) {
  const text = String(src || '');
  if (text.length > MAX_SQL_LEN) throw new SqlError(`The query is longer than ${MAX_SQL_LEN.toLocaleString('en-US')} characters.`, 0);
  const toks = tokenize(text);
  let p = 0;
  let depth = 0;
  let subDepth = 0;
  const peek = (o = 0) => toks[p + o];
  const isKw = (v, k = peek()) => !!k && k.t === 'kw' && k.v === v;
  const at = k => (k ? `at character ${k.pos + 1}` : 'at the end');
  const fail = (msg, k = peek()) => { throw new SqlError(`${msg} ${at(k)}.`, k ? k.pos : text.length); };
  const expectKw = v => { if (!isKw(v)) fail(`Expected ${v}`); return toks[p++]; };
  const expect = (t, what) => { const k = peek(); if (!k || k.t !== t) fail(`Expected ${what}`); p++; return k; };
  const enter = () => { if (++depth > MAX_EXPR_DEPTH) throw new SqlError('The query is nested too deep.', 0); };
  const leave = () => { depth--; };
  const spanText = (a, b) => text.slice(a, b).replace(/\s+/g, ' ').trim();

  function ident(what) {
    const k = peek();
    if (k && k.t === 'id') { p++; return k; }
    // Non-reserved words used as names are common in data (first, last, left, right, all).
    if (k && k.t === 'kw' && ['FIRST', 'LAST', 'LEFT', 'RIGHT', 'ALL', 'FULL', 'NULLS', 'END'].includes(k.v)) { p++; return { t: 'id', v: k.raw, quoted: false, pos: k.pos, end: k.end }; }
    return fail(`Expected ${what}`);
  }

  function select() {
    if (++subDepth > MAX_SUBQUERY_DEPTH) throw new SqlError(`The query has more than ${MAX_SUBQUERY_DEPTH} nested SELECTs. Use fewer subqueries.`, peek() ? peek().pos : 0);
    expectKw('SELECT');
    const q = { k: 'select', distinct: false, items: [], from: null, joins: [], where: null, groupBy: [], having: null, orderBy: [], limit: null, offset: null };
    if (isKw('DISTINCT')) { p++; q.distinct = true; } else if (isKw('ALL')) p++;
    do {
      const start = peek() ? peek().pos : text.length;
      if (peek() && peek().t === 'op' && peek().v === '*') { p++; q.items.push({ star: true, table: null }); continue; }
      if (peek() && peek().t === 'id' && peek(1) && peek(1).t === '.' && peek(2) && peek(2).t === 'op' && peek(2).v === '*') {
        const t = peek().v; p += 3; q.items.push({ star: true, table: t }); continue;
      }
      const expr = orExpr();
      const end = toks[p - 1] ? toks[p - 1].end : text.length;
      let alias = null;
      if (isKw('AS')) { p++; alias = aliasName(); } else if (peek() && (peek().t === 'id' || (peek().t === 'str'))) alias = aliasName();
      q.items.push({ expr, alias, text: spanText(start, end) });
    } while (peek() && peek().t === ',' && ++p);
    if (isKw('FROM')) {
      p++;
      q.from = source();
      for (;;) {
        if (peek() && peek().t === ',') { p++; q.joins.push({ type: 'cross', item: source(), on: null }); continue; }
        let type = null;
        if (isKw('JOIN')) { type = 'inner'; p++; } else if (isKw('INNER') && isKw('JOIN', peek(1))) { type = 'inner'; p += 2; } else if (isKw('CROSS') && isKw('JOIN', peek(1))) { type = 'cross'; p += 2; } else if (isKw('LEFT')) {
          if (isKw('JOIN', peek(1))) { type = 'left'; p += 2; } else if (isKw('OUTER', peek(1)) && isKw('JOIN', peek(2))) { type = 'left'; p += 3; }
        } else if (isKw('RIGHT') || isKw('FULL')) {
          fail('RIGHT and FULL JOIN are not supported. Swap the two sources and use LEFT JOIN');
        }
        if (!type) break;
        const item = source();
        let on = null;
        if (type !== 'cross') {
          if (isKw('USING')) fail('USING is not supported. Write ON a.col = b.col');
          expectKw('ON');
          on = orExpr();
        }
        q.joins.push({ type, item, on });
      }
    }
    if (isKw('WHERE')) { p++; q.where = orExpr(); }
    if (isKw('GROUP')) { p++; expectKw('BY'); do { q.groupBy.push(orExpr()); } while (peek() && peek().t === ',' && ++p); }
    if (isKw('HAVING')) { p++; q.having = orExpr(); }
    if (isKw('ORDER')) {
      p++; expectKw('BY');
      do {
        const expr = orExpr();
        let desc = false;
        if (isKw('ASC')) p++; else if (isKw('DESC')) { p++; desc = true; }
        let nulls = null;
        if (isKw('NULLS')) { p++; if (isKw('FIRST')) { p++; nulls = 'first'; } else { expectKw('LAST'); nulls = 'last'; } }
        q.orderBy.push({ expr, desc, nulls });
      } while (peek() && peek().t === ',' && ++p);
    }
    if (isKw('LIMIT')) {
      p++;
      q.limit = count('LIMIT');
      if (peek() && peek().t === ',') { p++; q.offset = q.limit; q.limit = count('LIMIT'); } else if (isKw('OFFSET')) { p++; q.offset = count('OFFSET'); }
    } else if (isKw('OFFSET')) { p++; q.offset = count('OFFSET'); }
    if (isKw('UNION')) fail('UNION is not supported yet');
    subDepth--;
    return q;
  }

  function count(what) {
    const k = peek();
    if (!k || k.t !== 'num' || !Number.isInteger(k.v) || k.v < 0) fail(`${what} needs a whole number`);
    p++;
    return k.v;
  }

  function aliasName() {
    const k = peek();
    if (k && (k.t === 'id' || k.t === 'str')) { p++; return k.v; }
    if (k && k.t === 'kw' && !['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'JOIN', 'ON', 'INNER', 'LEFT', 'CROSS', 'UNION'].includes(k.v)) { p++; return k.raw; }
    return fail('Expected a name after AS');
  }

  function source() {
    const k = peek();
    let item;
    if (k && k.t === '(') {
      p++;
      if (!isKw('SELECT')) fail('Expected SELECT inside the parentheses');
      const query = select();
      expect(')', 'a closing )');
      item = { k: 'sub', query, alias: null, pos: k.pos };
    } else if (k && k.t === 'str') {
      p++;
      item = { k: 'table', ref: { kind: 'path', value: k.v }, alias: null, pos: k.pos };
    } else if (k && k.t === 'id') {
      p++;
      let name = k.v;
      // sheet.name or schema.table: keep dotted bare names together (FROM main.data reads "main.data").
      while (!k.quoted && peek() && peek().t === '.' && peek(1) && peek(1).t === 'id') { name += '.' + peek(1).v; p += 2; }
      item = { k: 'table', ref: { kind: 'name', value: name, quoted: !!k.quoted }, alias: null, pos: k.pos };
    } else {
      return fail("Expected a source after FROM or JOIN: this, a sheet name or a 'file path'");
    }
    if (isKw('AS')) { p++; item.alias = aliasName(); } else if (peek() && peek().t === 'id') item.alias = toks[p++].v;
    return item;
  }

  // ---------- expressions ----------
  function orExpr() {
    enter();
    let left = andExpr();
    while (isKw('OR')) { p++; left = { k: 'bin', op: 'or', a: left, b: andExpr() }; }
    leave();
    return left;
  }
  function andExpr() {
    let left = notExpr();
    while (isKw('AND')) { p++; left = { k: 'bin', op: 'and', a: left, b: notExpr() }; }
    return left;
  }
  function notExpr() {
    if (isKw('NOT')) { p++; enter(); const e = { k: 'not', a: notExpr() }; leave(); return e; }
    return predicate();
  }
  function predicate() {
    const left = concatExpr();
    const k = peek();
    if (k && k.t === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(k.v)) { p++; return { k: 'bin', op: k.v, a: left, b: concatExpr() }; }
    if (isKw('IS')) {
      p++;
      let neg = false;
      if (isKw('NOT')) { p++; neg = true; }
      expectKw('NULL');
      return { k: 'isnull', a: left, neg };
    }
    let neg = false;
    if (isKw('NOT') && (isKw('LIKE', peek(1)) || isKw('ILIKE', peek(1)) || isKw('IN', peek(1)) || isKw('BETWEEN', peek(1)))) { p++; neg = true; }
    if (isKw('LIKE') || isKw('ILIKE')) { p++; return { k: 'like', a: left, b: concatExpr(), neg }; }
    if (isKw('IN')) {
      p++;
      expect('(', 'a ( after IN');
      if (isKw('SELECT')) fail('IN (SELECT ...) is not supported. Use a JOIN');
      const list = [orExpr()];
      while (peek() && peek().t === ',') { p++; list.push(orExpr()); }
      expect(')', 'a closing ) for the IN list');
      return { k: 'in', a: left, list, neg };
    }
    if (isKw('BETWEEN')) {
      p++;
      const lo = concatExpr();
      expectKw('AND');
      return { k: 'between', a: left, lo, hi: concatExpr(), neg };
    }
    return left;
  }
  function concatExpr() {
    let left = addExpr();
    while (peek() && peek().t === 'op' && peek().v === '||') { p++; left = { k: 'bin', op: '||', a: left, b: addExpr() }; }
    return left;
  }
  function addExpr() {
    let left = mulExpr();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) { const op = toks[p++].v; left = { k: 'bin', op, a: left, b: mulExpr() }; }
    return left;
  }
  function mulExpr() {
    let left = unary();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) { const op = toks[p++].v; left = { k: 'bin', op, a: left, b: unary() }; }
    return left;
  }
  function unary() {
    const k = peek();
    if (k && k.t === 'op' && (k.v === '-' || k.v === '+')) {
      p++;
      enter();
      const a = unary();
      leave();
      if (k.v === '+') return a;
      if (a.k === 'lit' && typeof a.v === 'number') return { k: 'lit', v: -a.v };
      return { k: 'neg', a };
    }
    return primary();
  }
  function primary() {
    const k = peek();
    if (!k) return fail('Expected a value');
    if (k.t === 'num') { p++; return { k: 'lit', v: k.v, int: Number.isInteger(k.v) && !/[.eE]/.test(k.text) }; }
    if (k.t === 'str') { p++; return { k: 'lit', v: k.v }; }
    if (k.t === '(') {
      p++;
      if (isKw('SELECT')) fail('Subqueries in expressions are not supported. Use FROM (SELECT ...) or a JOIN');
      const e = orExpr();
      expect(')', 'a closing )');
      return e;
    }
    if (k.t === 'kw') {
      if (k.v === 'NULL') { p++; return { k: 'lit', v: null }; }
      if (k.v === 'TRUE' || k.v === 'FALSE') { p++; return { k: 'lit', v: k.v === 'TRUE' }; }
      if (k.v === 'CASE') return caseExpr();
      if (k.v === 'CAST') {
        p++;
        expect('(', 'a ( after CAST');
        const a = orExpr();
        expectKw('AS');
        const t = ident('a type name');
        let to = t.v.toUpperCase();
        if (peek() && peek().t === '(') { p++; while (peek() && peek().t !== ')') p++; expect(')', 'a closing )'); }
        if (to === 'DOUBLE' && peek() && peek().t === 'id' && peek().v.toUpperCase() === 'PRECISION') p++;
        expect(')', 'a closing ) for CAST');
        return { k: 'cast', a, to };
      }
      if ((k.v === 'LEFT' || k.v === 'RIGHT') && peek(1) && peek(1).t === '(') { p++; return call(k.v, k.pos); }
      if (['FIRST', 'LAST', 'ALL', 'NULLS', 'FULL'].includes(k.v)) { p++; return columnRef({ t: 'id', v: k.raw, pos: k.pos }); }
      return fail(`Unexpected ${k.v}`);
    }
    if (k.t === 'id') {
      p++;
      if (!k.quoted && peek() && peek().t === '(') return call(k.v.toUpperCase(), k.pos);
      return columnRef(k);
    }
    if (k.t === 'op' && k.v === '*') return fail('* is only allowed as SELECT * or COUNT(*)');
    return fail(`Unexpected ${k.t === 'op' ? k.v : k.t}`);
  }
  function columnRef(k) {
    if (peek() && peek().t === '.') {
      p++;
      const c = ident('a column name after the dot');
      return { k: 'col', table: k.v, name: c.v, pos: k.pos };
    }
    return { k: 'col', table: null, name: k.v, pos: k.pos };
  }
  function call(name, pos) {
    expect('(', 'a (');
    enter();
    const node = { k: 'fn', name, args: [], distinct: false, star: false, pos };
    if (peek() && peek().t === 'op' && peek().v === '*' && peek(1) && peek(1).t === ')') {
      if (name !== 'COUNT') fail(`${name}(*) is not valid. Only COUNT(*) takes a *`);
      p += 2; node.star = true; leave(); return node;
    }
    if (isKw('DISTINCT')) {
      if (!AGGREGATES.has(name)) fail(`DISTINCT works only inside COUNT, SUM, AVG and the other aggregates, not ${name}`);
      p++; node.distinct = true;
    }
    if (!(peek() && peek().t === ')')) {
      node.args.push(orExpr());
      while (peek() && peek().t === ',') { p++; node.args.push(orExpr()); }
    }
    expect(')', `a closing ) for ${name}`);
    leave();
    return node;
  }
  function caseExpr() {
    p++;
    enter();
    let base = null;
    if (!isKw('WHEN')) base = orExpr();
    const whens = [];
    while (isKw('WHEN')) {
      p++;
      const c = orExpr();
      expectKw('THEN');
      whens.push([c, orExpr()]);
    }
    if (!whens.length) fail('CASE needs at least one WHEN');
    let other = null;
    if (isKw('ELSE')) { p++; other = orExpr(); }
    expectKw('END');
    leave();
    return { k: 'case', base, whens, else: other };
  }

  if (!toks.length) throw new SqlError('The query is empty. Start with SELECT.', 0);
  if (!isKw('SELECT')) {
    const k = peek();
    if (k.t === 'kw' || k.t === 'id') {
      const w = String(k.v).toUpperCase();
      if (['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'ATTACH', 'PRAGMA', 'COPY', 'INSTALL', 'LOAD'].includes(w)) {
        throw new SqlError(`Only SELECT queries run here. ${w} would change data, and this viewer never writes to your files.`, k.pos);
      }
      if (w === 'WITH') throw new SqlError('WITH is not supported yet. Use FROM (SELECT ...) alias instead.', k.pos);
    }
    fail('Expected SELECT', k);
  }
  const q = select();
  while (peek() && peek().t === ';') p++;
  if (p < toks.length) {
    const k = toks[p];
    if (k.t === 'kw' && k.v === 'SELECT') throw new SqlError('Run one query at a time.', k.pos);
    fail(`Unexpected ${k.t === 'kw' ? k.v : k.t === 'id' ? `"${k.v}"` : k.v !== undefined ? JSON.stringify(k.v) : k.t}`, k);
  }
  return q;
}

/** Every source in a query, subqueries included (for the host: which files a query reads). */
function sourcesOf(q, out = []) {
  const visit = item => {
    if (!item) return;
    if (item.k === 'sub') sourcesOf(item.query, out);
    else out.push(item.ref);
  };
  visit(q.from);
  for (const j of q.joins) visit(j.item);
  return out;
}

module.exports = { parseSql, tokenize, sourcesOf, SqlError, AGGREGATES, MAX_SQL_LEN, MAX_SUBQUERY_DEPTH };
