'use strict';
// Executes one parsed SELECT over row sources (see sources.js), streaming the first source.
//
// - GROUP BY keeps only one row and the aggregate state per group, so a 5 GB CSV aggregates in little memory.
// - JOIN: every source after the first is read into memory once (hash table on the ON equalities); the first
//   source is streamed past it. Put the biggest file first.
// - Without ORDER BY, LIMIT stops reading as soon as it has its rows. ORDER BY with LIMIT keeps only the top rows.
// - A memory cap (estimated bytes of what the query keeps) stops a query that would not fit, with a clear
//   message instead of a crash. There is no spill to disk.

const { parseSql, SqlError, AGGREGATES } = require('./parse');
const V = require('./values');
const { rowsSource } = require('./sources');

const MB = 1024 * 1024;
const DEFAULTS = { memCapMB: 512, maxResultRows: 1000000, maxPairs: 300e6 };

function tooBig(capMB, what) {
  return new SqlError(`The query needs more memory than its limit (${capMB} MB, setting tableViewer.queryMemoryMB) ${what}. Add a WHERE condition or a LIMIT, group by fewer values, or put the bigger file first in a JOIN.`, 0);
}

function rowBytes(r) {
  let b = 48 + 8 * r.length;
  for (let i = 0; i < r.length; i++) {
    const v = r[i];
    if (typeof v === 'string') b += 2 * v.length + 24;
    else if (v !== null && typeof v === 'object') b += 64;
  }
  return b;
}

/**
 * Make a context: progress, cancel and memory accounting shared by one query run and its subqueries.
 * @param {{onProgress?:Function, progressMs?:number, now?:()=>number}} o
 */
function createContext(o = {}) {
  const now = o.now || (() => Date.now());
  const ctx = {
    rows: 0, bytes: 0, mem: 0, pairs: 0, totalBytes: 0,
    cancelled: false, started: now(), lastProgress: 0, lastYield: now(), opened: [], notes: [],
    check() { if (ctx.cancelled) { const e = new SqlError('The query was cancelled.', 0); e.cancelled = true; throw e; } },
    async tick() {
      ctx.check();
      const t = now();
      if (o.onProgress && t - ctx.lastProgress >= (o.progressMs || 250)) {
        ctx.lastProgress = t;
        o.onProgress({ rows: ctx.rows, bytes: ctx.bytes, totalBytes: ctx.totalBytes, ms: t - ctx.started });
      }
      // Let the worker read a Cancel message now and then, even when every read is served from cache.
      if (t - ctx.lastYield >= 40) { ctx.lastYield = t; await new Promise(r => setImmediate(r)); ctx.check(); }
    },
  };
  return ctx;
}

/**
 * Run a query.
 * @param {string|object} sql text or AST
 * @param {{resolve:(ref:object)=>Promise<object>, memCapMB?:number, maxResultRows?:number, maxPairs?:number}} env
 * @param {object} ctx from createContext
 * @returns {Promise<{columns:{name:string,type?:string}[], rows:any[][], truncated:boolean, notes:string[]}>}
 */
async function runSql(sql, env, ctx = createContext()) {
  const ast = typeof sql === 'string' ? parseSql(sql) : sql;
  const e = { ...DEFAULTS, ...env };
  try {
    return await execSelect(ast, e, ctx);
  } finally {
    for (const r of ctx.opened) { try { if (r.close) await r.close(); } catch { /* already closed */ } }
  }
}

function containsAgg(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.k === 'fn' && AGGREGATES.has(node.name) && !((node.name === 'MIN' || node.name === 'MAX') && node.args.length > 1)) return true;
  for (const k of ['a', 'b', 'lo', 'hi', 'base', 'else']) if (node[k] && containsAgg(node[k])) return true;
  if (node.args && node.args.some(containsAgg)) return true;
  if (node.list && node.list.some(containsAgg)) return true;
  if (node.whens && node.whens.some(([c, v]) => containsAgg(c) || containsAgg(v))) return true;
  return false;
}

function splitAnd(node, out = []) {
  if (!node) return out;
  if (node.k === 'bin' && node.op === 'and') { splitAnd(node.a, out); splitAnd(node.b, out); } else out.push(node);
  return out;
}

function andAll(list) {
  if (!list.length) return null;
  return list.reduce((a, b) => ({ k: 'bin', op: 'and', a, b }));
}

async function execSelect(q, env, ctx) {
  // ---------- sources ----------
  const items = [q.from || { k: 'table', ref: { kind: 'this' }, alias: null }, ...q.joins.map(j => j.item)];
  const rels = [];
  for (const item of items) {
    ctx.check();
    let rel;
    if (item.k === 'sub') {
      const r = await execSelect(item.query, env, ctx);
      rel = rowsSource(r.columns, r.rows, item.alias || 'subquery');
    } else {
      rel = await env.resolve(item.ref);
      ctx.opened.push(rel);
    }
    rels.push({ rel, alias: item.alias || rel.name || 'source', names: [item.alias, rel.name, ...(rel.altNames || [])].filter(Boolean).map(s => String(s).toLowerCase()) });
  }
  let width = 0;
  for (const r of rels) { r.offset = width; width += r.rel.columns.length; r.need = new Set(); }
  if (rels[0].rel.totalBytes && !ctx.totalBytes) ctx.totalBytes = rels[0].rel.totalBytes;
  const relOf = abs => { for (let i = rels.length - 1; i >= 0; i--) if (abs >= rels[i].offset) return i; return 0; };

  // ---------- name resolution ----------
  function listColumns() {
    const all = [];
    for (const r of rels) for (const c of r.rel.columns) all.push(rels.length > 1 ? `${r.alias}.${c.name}` : c.name);
    return all.slice(0, 12).join(', ') + (all.length > 12 ? ', …' : '');
  }
  function findIn(r, name) {
    const cols = r.rel.columns;
    let i = cols.findIndex(c => c.name === name);
    if (i >= 0) return i;
    const low = name.toLowerCase();
    const hits = [];
    cols.forEach((c, j) => { if (c.name.toLowerCase() === low) hits.push(j); });
    return hits.length === 1 ? hits[0] : -1;
  }
  function resolveCol(node) {
    if (node.table) {
      const low = node.table.toLowerCase();
      const r = rels.find(x => x.alias.toLowerCase() === low) || rels.find(x => x.names.includes(low));
      if (!r) throw new SqlError(`No source named "${node.table}". Sources: ${rels.map(x => x.alias).join(', ')}.`, node.pos || 0);
      const i = findIn(r, node.name);
      if (i < 0) throw new SqlError(`${r.alias} has no column "${node.name}". Columns: ${r.rel.columns.slice(0, 12).map(c => c.name).join(', ')}.`, node.pos || 0);
      r.need.add(i);
      return r.offset + i;
    }
    const exact = [];
    for (const r of rels) { const i = r.rel.columns.findIndex(c => c.name === node.name); if (i >= 0) exact.push([r, i]); }
    let hits = exact;
    if (!hits.length) {
      for (const r of rels) { const i = findIn(r, node.name); if (i >= 0) hits.push([r, i]); }
    }
    if (hits.length > 1) throw new SqlError(`Column "${node.name}" is in ${hits.map(h => h[0].alias).join(' and ')}. Write ${hits[0][0].alias}."${node.name}".`, node.pos || 0);
    if (!hits.length) throw new SqlError(`No column named "${node.name}". Columns: ${listColumns()}. Put names with spaces in "double quotes" and text in 'single quotes'.`, node.pos || 0);
    const [r, i] = hits[0];
    r.need.add(i);
    return r.offset + i;
  }

  // ---------- compiler ----------
  const specs = []; // aggregate slots
  function compile(node, mode, shift = 0) {
    switch (node.k) {
      case 'lit': { const v = node.v; return () => v; }
      case 'col': {
        const i = resolveCol(node) - shift;
        if (mode === 'group') return g => { if (!g.rep) return null; const v = g.rep[i]; return v === undefined ? null : v; };
        return r => { const v = r[i]; return v === undefined ? null : v; };
      }
      case 'neg': { const a = compile(node.a, mode, shift); return x => { const v = V.num(a(x)); return v === null ? null : -v; }; }
      case 'not': { const a = compile(node.a, mode, shift); return x => { const v = V.truthy(a(x)); return v === null ? null : !v; }; }
      case 'bin': {
        const a = compile(node.a, mode, shift), b = compile(node.b, mode, shift);
        switch (node.op) {
          case 'and': return x => { const l = V.truthy(a(x)); if (l === false) return false; const r = V.truthy(b(x)); if (r === false) return false; return l === null || r === null ? null : true; };
          case 'or': return x => { const l = V.truthy(a(x)); if (l === true) return true; const r = V.truthy(b(x)); if (r === true) return true; return l === null || r === null ? null : false; };
          case '=': return x => { const l = a(x), r = b(x); return V.isNull(l) || V.isNull(r) ? null : V.cmp(l, r) === 0; };
          case '!=': return x => { const l = a(x), r = b(x); return V.isNull(l) || V.isNull(r) ? null : V.cmp(l, r) !== 0; };
          case '<': return x => { const l = a(x), r = b(x); return V.isNull(l) || V.isNull(r) ? null : V.cmp(l, r) < 0; };
          case '<=': return x => { const l = a(x), r = b(x); return V.isNull(l) || V.isNull(r) ? null : V.cmp(l, r) <= 0; };
          case '>': return x => { const l = a(x), r = b(x); return V.isNull(l) || V.isNull(r) ? null : V.cmp(l, r) > 0; };
          case '>=': return x => { const l = a(x), r = b(x); return V.isNull(l) || V.isNull(r) ? null : V.cmp(l, r) >= 0; };
          default: { const op = node.op; return x => V.binary(op, a(x), b(x)); }
        }
      }
      case 'isnull': { const a = compile(node.a, mode, shift); return node.neg ? x => !V.isNull(a(x)) : x => V.isNull(a(x)); }
      case 'like': {
        const a = compile(node.a, mode, shift);
        if (node.b.k === 'lit') {
          if (node.b.v === null) return () => null;
          const re = V.likeRegex(node.b.v, true);
          return x => { const s = V.text(a(x)); if (s === null) return null; const m = re.test(s); return node.neg ? !m : m; };
        }
        const b = compile(node.b, mode, shift);
        return x => { const s = V.text(a(x)), pat = V.text(b(x)); if (s === null || pat === null) return null; const m = V.likeRegex(pat, true).test(s); return node.neg ? !m : m; };
      }
      case 'in': {
        const a = compile(node.a, mode, shift);
        if (node.list.every(e => e.k === 'lit')) {
          const vals = node.list.map(e => e.v);
          const hasNull = vals.some(V.isNull);
          const keys = new Set(vals.filter(v => !V.isNull(v)).map(V.keyOf));
          return x => { const v = a(x); if (V.isNull(v)) return null; if (keys.has(V.keyOf(v))) return !node.neg; return hasNull ? null : node.neg; };
        }
        const fs = node.list.map(e => compile(e, mode, shift));
        return x => {
          const v = a(x);
          if (V.isNull(v)) return null;
          let sawNull = false;
          for (const f of fs) { const w = f(x); if (V.isNull(w)) { sawNull = true; continue; } if (V.cmp(v, w) === 0) return !node.neg; }
          return sawNull ? null : node.neg;
        };
      }
      case 'between': {
        const a = compile(node.a, mode, shift), lo = compile(node.lo, mode, shift), hi = compile(node.hi, mode, shift);
        return x => {
          const v = a(x), l = lo(x), h = hi(x);
          if (V.isNull(v) || V.isNull(l) || V.isNull(h)) return null;
          const inside = V.cmp(v, l) >= 0 && V.cmp(v, h) <= 0;
          return node.neg ? !inside : inside;
        };
      }
      case 'case': {
        const base = node.base ? compile(node.base, mode, shift) : null;
        const whens = node.whens.map(([c, v]) => [compile(c, mode, shift), compile(v, mode, shift)]);
        const other = node.else ? compile(node.else, mode, shift) : () => null;
        if (base) return x => { const b = base(x); if (!V.isNull(b)) for (const [c, v] of whens) { const w = c(x); if (!V.isNull(w) && V.cmp(b, w) === 0) return v(x); } return other(x); };
        return x => { for (const [c, v] of whens) if (V.truthy(c(x)) === true) return v(x); return other(x); };
      }
      case 'cast': { const a = compile(node.a, mode, shift); const to = node.to; V.cast('1', to); return x => V.cast(a(x), to); }
      case 'fn': return compileFn(node, mode, shift);
      default: throw new SqlError('Unsupported expression.', 0);
    }
  }

  function compileFn(node, mode, shift) {
    const name = node.name;
    const isAgg = AGGREGATES.has(name) && !((name === 'MIN' || name === 'MAX') && node.args.length > 1);
    if (isAgg) {
      if (mode !== 'group') throw new SqlError(`${name}() cannot be used in WHERE, ON, GROUP BY or inside another aggregate. Use HAVING to filter on it.`, node.pos || 0);
      const nargs = node.args.length;
      if (!node.star) {
        const max = name === 'GROUP_CONCAT' || name === 'STRING_AGG' ? 2 : 1;
        if (nargs < 1 || nargs > max) throw new SqlError(`${name}() takes ${max === 1 ? 'one value' : 'one or two values'}.`, node.pos || 0);
      }
      const spec = {
        name, distinct: node.distinct, star: node.star,
        arg: node.star ? null : compile(node.args[0], 'row'),
        sep: nargs > 1 ? (node.args[1].k === 'lit' ? V.text(node.args[1].v) : null) : (name === 'STRING_AGG' ? ',' : ','),
      };
      if (nargs > 1 && node.args[1].k !== 'lit') throw new SqlError(`The separator of ${name}() must be a text value like ', '.`, node.pos || 0);
      const slot = specs.push(spec) - 1;
      return g => g.acc[slot];
    }
    const f = V.FUNCTIONS[name];
    if (!f) {
      throw new SqlError(`Unknown function ${name}(). Some that work: LOWER, UPPER, SUBSTR, REPLACE, ROUND, COALESCE, CAST, DATE_TRUNC, STRFTIME, YEAR, COUNT, SUM, AVG, MIN, MAX.`, node.pos || 0);
    }
    if (node.star) throw new SqlError(`${name}(*) is not valid.`, node.pos || 0);
    const [min, max, fn] = f;
    if (node.args.length < min || node.args.length > max) {
      throw new SqlError(`${name}() takes ${min === max ? min : `${min} to ${max}`} value${max === 1 ? '' : 's'}, not ${node.args.length}.`, node.pos || 0);
    }
    const args = node.args.map(a => compile(a, mode, shift));
    if (args.length === 1) { const a0 = args[0]; return x => fn([a0(x)]); }
    if (args.length === 2) { const a0 = args[0], a1 = args[1]; return x => fn([a0(x), a1(x)]); }
    return x => fn(args.map(a => a(x)));
  }

  function refsOf(node, out = new Set()) {
    if (!node || typeof node !== 'object') return out;
    if (node.k === 'col') { out.add(relOf(resolveCol(node))); return out; }
    for (const k of ['a', 'b', 'lo', 'hi', 'base', 'else']) if (node[k]) refsOf(node[k], out);
    if (node.args) node.args.forEach(n => refsOf(n, out));
    if (node.list) node.list.forEach(n => refsOf(n, out));
    if (node.whens) node.whens.forEach(([c, v]) => { refsOf(c, out); refsOf(v, out); });
    return out;
  }

  // ---------- joins ----------
  const joins = q.joins.map((j, idx) => {
    const ri = idx + 1;
    const r = rels[ri];
    const J = { type: j.type, ri, keysL: [], keysR: [], residual: null, map: null, rows: null, nullRow: new Array(r.rel.columns.length).fill(null) };
    const rest = [];
    for (const c of splitAnd(j.on)) {
      if (c.k === 'bin' && c.op === '=' && !containsAgg(c)) {
        const ra = refsOf(c.a), rb = refsOf(c.b);
        const onlyRight = s => s.size > 0 && [...s].every(x => x === ri);
        const onlyLeft = s => s.size > 0 && [...s].every(x => x < ri);
        if (onlyRight(ra) && onlyLeft(rb)) { J.keysR.push(compile(c.a, 'row', r.offset)); J.keysL.push(compile(c.b, 'row')); continue; }
        if (onlyRight(rb) && onlyLeft(ra)) { J.keysR.push(compile(c.b, 'row', r.offset)); J.keysL.push(compile(c.a, 'row')); continue; }
      }
      const refs = refsOf(c);
      if ([...refs].some(x => x > ri)) throw new SqlError('An ON condition uses a source that is joined later. Move that condition to the later JOIN or to WHERE.', 0);
      rest.push(c);
    }
    const res = andAll(rest);
    if (res) J.residual = compile(res, 'row');
    return J;
  });

  // ---------- SELECT list, GROUP BY, HAVING, ORDER BY ----------
  const grouped = q.groupBy.length > 0 || q.items.some(it => !it.star && containsAgg(it.expr)) || containsAgg(q.having) || q.orderBy.some(o => containsAgg(o.expr));
  const mode = grouped ? 'group' : 'row';
  const where = q.where ? (containsAgg(q.where) ? fail('Aggregates like COUNT() go in HAVING, not WHERE.') : compile(q.where, 'row')) : null;

  const outCols = [];
  for (const it of q.items) {
    if (it.star) {
      let any = false;
      for (const r of rels) {
        if (it.table && !(r.alias.toLowerCase() === it.table.toLowerCase() || r.names.includes(it.table.toLowerCase()))) continue;
        any = true;
        r.rel.columns.forEach((c, j) => {
          const idx = r.offset + j;
          r.need.add(j);
          outCols.push({ name: c.name, type: c.type, f: mode === 'group' ? (g => (g.rep ? nn(g.rep[idx]) : null)) : (row => nn(row[idx])) });
        });
      }
      if (!any) throw new SqlError(`No source named "${it.table}" for ${it.table}.*.`, 0);
      continue;
    }
    const f = compile(it.expr, mode);
    let type = null;
    if (it.expr.k === 'col') { const abs = resolveCol(it.expr); const r = rels[relOf(abs)]; type = r.rel.columns[abs - r.offset].type; }
    outCols.push({ name: it.alias || (it.expr.k === 'col' ? it.expr.name : it.text), aliased: !!it.alias, type, f, expr: it.expr });
  }

  const groupFns = q.groupBy.map(e => {
    if (e.k === 'lit' && Number.isInteger(e.v)) {
      const it = q.items[e.v - 1];
      if (!it || it.star) throw new SqlError(`GROUP BY ${e.v} needs a SELECT item number ${e.v} that is not *.`, 0);
      if (containsAgg(it.expr)) throw new SqlError(`GROUP BY ${e.v} points at an aggregate.`, 0);
      return compile(it.expr, 'row');
    }
    if (e.k === 'col' && !e.table) {
      try { return compile(e, 'row'); } catch (err) {
        const it = q.items.find(x => !x.star && x.alias && x.alias.toLowerCase() === e.name.toLowerCase());
        if (it && !containsAgg(it.expr)) return compile(it.expr, 'row');
        throw err;
      }
    }
    if (containsAgg(e)) throw new SqlError('GROUP BY cannot use an aggregate.', 0);
    return compile(e, 'row');
  });

  const having = q.having ? compile(q.having, 'group') : null;
  if (having && !grouped) throw new SqlError('HAVING needs GROUP BY or an aggregate.', 0);

  const order = q.orderBy.map(o => {
    const spec = { desc: o.desc, nulls: o.nulls };
    if (o.expr.k === 'lit' && Number.isInteger(o.expr.v)) {
      if (o.expr.v < 1 || o.expr.v > outCols.length) throw new SqlError(`ORDER BY ${o.expr.v}: the SELECT list has ${outCols.length} columns.`, 0);
      spec.out = o.expr.v - 1;
      return spec;
    }
    if (o.expr.k === 'col' && !o.expr.table) {
      const i = outCols.findIndex(c => c.aliased && c.name.toLowerCase() === o.expr.name.toLowerCase());
      if (i >= 0) { spec.out = i; return spec; }
    }
    spec.f = compile(o.expr, mode);
    return spec;
  });

  // WHERE conjuncts on the first source that a Parquet reader can check against row group statistics.
  const first = rels[0];
  if (where && first.rel.prune) {
    for (const c of splitAnd(q.where)) {
      if (c.k !== 'bin' || !['=', '<', '<=', '>', '>='].includes(c.op)) continue;
      let col = c.a, lit = c.b, op = c.op;
      if (col.k !== 'col') { col = c.b; lit = c.a; op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' }[op]; }
      if (col.k !== 'col' || lit.k !== 'lit' || V.isNull(lit.v)) continue;
      const abs = resolveCol(col);
      if (relOf(abs) !== 0) continue;
      const t = first.rel.columns[abs].type;
      let value = null;
      if ((t === 'int' || t === 'float') && typeof lit.v === 'number') value = lit.v;
      else if ((t === 'date' || t === 'timestamp') && typeof lit.v === 'string') value = V.toDate(lit.v);
      if (value !== null) first.rel.prune.push({ col: abs, op, value });
    }
  }

  // ---------- run ----------
  const capMB = env.memCapMB;
  const cap = capMB * MB;
  const addMem = (n, what) => { ctx.mem += n; if (ctx.mem > cap) throw tooBig(capMB, what); };

  // Read every joined source once.
  for (const J of joins) {
    const r = rels[J.ri];
    const rows = [];
    const map = J.keysR.length ? new Map() : null;
    for await (const batch of r.rel.scan(r.need, ctx)) {
      for (const row of batch) {
        if (map) {
          let key = '';
          let hasNull = false;
          for (let k = 0; k < J.keysR.length; k++) { const v = J.keysR[k](row); if (V.isNull(v)) { hasNull = true; break; } key += V.keyOf(v) + '\u0001'; }
          if (hasNull) continue; // NULL never equals anything
          const list = map.get(key);
          if (list) list.push(row); else map.set(key, [row]);
          addMem(rowBytes(row) + (list ? 8 : 80 + 2 * key.length), `while reading ${r.alias} for the JOIN`);
        } else {
          rows.push(row);
          addMem(rowBytes(row), `while reading ${r.alias} for the JOIN`);
        }
      }
    }
    J.map = map;
    J.rows = rows;
  }

  const distinct = q.distinct ? new Set() : null;
  const limit = q.limit, offset = q.offset || 0;
  const maxOut = env.maxResultRows;
  let stop = false;
  let truncated = false;
  const out = [];
  let skipped = 0;
  let orderBuf = [];
  let orderMem = 0;
  const groups = grouped ? new Map() : null;
  const nk = groupFns.length;

  const cmpKeys = (a, b) => {
    for (let i = 0; i < order.length; i++) {
      const x = a.k[i], y = b.k[i];
      const nx = V.isNull(x), ny = V.isNull(y);
      if (nx || ny) {
        if (nx && ny) continue;
        const nf = order[i].nulls === 'first';
        return nx ? (nf ? -1 : 1) : (nf ? 1 : -1);
      }
      const c = V.cmp(x, y);
      if (c) return order[i].desc ? -c : c;
    }
    return 0;
  };

  const project = x => {
    const o = new Array(outCols.length);
    for (let i = 0; i < outCols.length; i++) o[i] = outCols[i].f(x);
    return o;
  };

  // A finished output row (plain mode) or group row (group mode, at the end).
  function emit(o, x) {
    if (distinct) {
      let key = '';
      for (let i = 0; i < o.length; i++) key += V.keyOf(o[i]) + '\u0001';
      if (distinct.has(key)) return;
      distinct.add(key);
      addMem(2 * key.length + 64, 'for DISTINCT');
    }
    if (order.length) {
      const k = order.map(s => (s.out !== undefined ? o[s.out] : s.f(x)));
      orderBuf.push({ o, k });
      const b = rowBytes(o) + rowBytes(k);
      orderMem += b;
      addMem(b, 'to sort the result');
      if (limit !== null && orderBuf.length > 2 * (offset + limit) + 10000) {
        orderBuf.sort(cmpKeys);
        orderBuf.length = offset + limit;
        let m = 0;
        for (const e of orderBuf) m += rowBytes(e.o) + rowBytes(e.k);
        ctx.mem -= orderMem - m;
        orderMem = m;
      }
      return;
    }
    if (skipped < offset) { skipped++; return; }
    out.push(o);
    addMem(rowBytes(o), 'to hold the result');
    if (limit !== null && out.length >= limit) stop = true;
    else if (out.length >= maxOut) { truncated = true; stop = true; }
  }

  function sinkRow(row) {
    if (where) { const w = where(row); if (w !== true && V.truthy(w) !== true) return; }
    if (!grouped) { emit(project(row), row); return; }
    let key = '';
    for (let i = 0; i < nk; i++) key += V.keyOf(groupFns[i](row)) + '\u0001';
    let g = groups.get(key);
    if (!g) {
      g = { rep: row, acc: specs.map(initAcc) };
      groups.set(key, g);
      addMem(rowBytes(row) + 2 * key.length + 120 + 48 * specs.length, 'for GROUP BY (too many groups)');
    }
    for (let i = 0; i < specs.length; i++) addAcc(specs[i], g, i, row, addMem);
  }

  const maxPairs = env.maxPairs;
  function probe(row, j) {
    if (j > joins.length) { sinkRow(row); return; }
    const J = joins[j - 1];
    let cands;
    if (J.map) {
      let key = '';
      for (let k = 0; k < J.keysL.length; k++) { const v = J.keysL[k](row); if (V.isNull(v)) { key = null; break; } key += V.keyOf(v) + '\u0001'; }
      cands = key === null ? null : J.map.get(key);
    } else cands = J.rows;
    let matched = false;
    if (cands) {
      for (let i = 0; i < cands.length; i++) {
        if (++ctx.pairs > maxPairs) throw new SqlError(`This JOIN makes more than ${maxPairs.toLocaleString('en-US')} row pairs. Add an ON condition with = between the two sources, or a WHERE condition that keeps fewer rows.`, 0);
        const comb = row.concat(cands[i]);
        if (J.residual && J.residual(comb) !== true) continue;
        matched = true;
        probe(comb, j + 1);
        if (stop) return;
      }
    }
    if (!matched && J.type === 'left') probe(row.concat(J.nullRow), j + 1);
  }

  const scan = first.rel.scan(first.need, ctx);
  try {
    for await (const batch of scan) {
      for (let i = 0; i < batch.length; i++) {
        if (joins.length) probe(batch[i], 1); else sinkRow(batch[i]);
        if (stop) break;
      }
      if (stop) break;
    }
  } finally {
    if (stop && scan.return) await scan.return();
  }
  ctx.check();

  if (grouped) {
    if (!groups.size && !q.groupBy.length) groups.set('', { rep: null, acc: specs.map(initAcc) });
    for (const g of groups.values()) {
      for (let i = 0; i < specs.length; i++) g.acc[i] = doneAcc(specs[i], g.acc[i]);
      if (having) { const h = having(g); if (h !== true && V.truthy(h) !== true) continue; }
      emit(project(g), g);
      if (stop) break;
    }
  }
  let rows = out;
  if (order.length) {
    orderBuf.sort(cmpKeys);
    const end = limit === null ? orderBuf.length : Math.min(orderBuf.length, offset + limit);
    rows = [];
    for (let i = offset; i < end; i++) rows.push(orderBuf[i].o);
    orderBuf = null;
  } else if (grouped && offset) {
    // emit() already skipped the offset rows
  }
  if (rows.length > maxOut) { rows.length = maxOut; truncated = true; }
  if (first.rel.skippedGroups) ctx.notes.push(`Skipped ${first.rel.skippedGroups} of ${first.rel.rowGroups} Parquet row groups using their min/max statistics.`);
  return { columns: outCols.map(c => ({ name: c.name, type: c.type })), rows, truncated };
}

function nn(v) { return v === undefined ? null : v; }
function fail(msg) { throw new SqlError(msg, 0); }

// ---------- aggregates ----------
function initAcc(spec) {
  switch (spec.name) {
    case 'COUNT': return spec.distinct ? { n: 0, set: new Set() } : { n: 0 };
    case 'SUM': case 'AVG': return spec.distinct ? { s: 0, c: 0, n: 0, set: new Set() } : { s: 0, c: 0, n: 0 };
    case 'MIN': case 'MAX': return { v: null };
    case 'GROUP_CONCAT': case 'STRING_AGG': return spec.distinct ? { parts: [], set: new Set() } : { parts: [] };
    case 'MEDIAN': return { vals: [] };
    default: return {};
  }
}

function addAcc(spec, g, i, row, addMem) {
  const st = g.acc[i];
  if (spec.star) { st.n++; return; }
  const v = spec.arg(row);
  if (V.isNull(v)) return;
  if (st.set) {
    const k = V.keyOf(v);
    if (st.set.has(k)) return;
    st.set.add(k);
    addMem(2 * k.length + 48, 'for COUNT(DISTINCT ...)');
  }
  switch (spec.name) {
    case 'COUNT': st.n++; break;
    case 'SUM': case 'AVG': {
      const x = V.num(v);
      if (x === null) return;
      // Kahan summation: sums of many decimals stay exact to the last printed digit.
      const y = x - st.c;
      const t = st.s + y;
      st.c = (t - st.s) - y;
      st.s = t;
      st.n++;
      break;
    }
    case 'MIN': if (st.v === null || V.cmp(v, st.v) < 0) st.v = v; break;
    case 'MAX': if (st.v === null || V.cmp(v, st.v) > 0) st.v = v; break;
    case 'GROUP_CONCAT': case 'STRING_AGG': { const s = V.text(v); st.parts.push(s); addMem(2 * s.length + 16, `for ${spec.name}`); break; }
    case 'MEDIAN': { const x = V.num(v); if (x !== null) { st.vals.push(x); addMem(16, 'for MEDIAN'); } break; }
    default: break;
  }
}

function doneAcc(spec, st) {
  switch (spec.name) {
    case 'COUNT': return st.n;
    case 'SUM': return st.n ? st.s : null;
    case 'AVG': return st.n ? st.s / st.n : null;
    case 'MIN': case 'MAX': return st.v;
    case 'GROUP_CONCAT': case 'STRING_AGG': return st.parts.length ? st.parts.join(spec.sep === null ? ',' : spec.sep) : null;
    case 'MEDIAN': {
      if (!st.vals.length) return null;
      const a = st.vals.sort((x, y) => x - y);
      const m = a.length >> 1;
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }
    default: return null;
  }
}

module.exports = { runSql, createContext, execSelect, DEFAULTS, rowBytes };
