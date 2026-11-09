'use strict';
// Tiers: what the free tier gets, what Pro adds, and that the Pro switch off changes nothing.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/pro');

const lic = { valid: true, license: { plan: 'lifetime', expires: null, email: 'a@b.c' } };
const settings = { maxRows: 1000000, maxFileSizeMB: 512, maxExcelSizeMB: 50, maxCopyRows: 100000 };

test('entitlement: Pro switched off means no Pro, even with a valid key', () => {
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: false }, lic), { enabled: false, licensed: false, via: null, plan: null, expires: null, email: null });
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: true }, null), { enabled: true, licensed: false, via: null, plan: null, expires: null, email: null });
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: true }, { valid: false, reason: 'expired' }).licensed, false);
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: true }, lic), { enabled: true, licensed: true, via: 'key', plan: 'lifetime', expires: null, email: 'a@b.c' });
  // 0.5: a GitHub Sponsors unlock (Zovo Pro) counts only when the Pro switch is on.
  assert.strictEqual(P.entitlement({ PRO_ENABLED: false }, null, true).licensed, false);
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: true }, null, true), { enabled: true, licensed: true, via: 'github-sponsors', plan: 'zovo-pro', expires: null, email: null });
});

test('canUse: with the Pro switch off every feature is free; on, Pro features need a license', () => {
  const off = P.entitlement({ PRO_ENABLED: false }, null);
  const free = P.entitlement({ PRO_ENABLED: true }, null);
  const pro = P.entitlement({ PRO_ENABLED: true }, lic);
  const spon = P.entitlement({ PRO_ENABLED: true }, null, true);
  for (const f of P.FREE_FEATURES) for (const e of [off, free, pro, spon, null]) assert.strictEqual(P.canUse(f, e), true, f);
  for (const { id } of P.PRO_FEATURES) {
    assert.strictEqual(P.canUse(id, off), true, id);
    assert.strictEqual(P.canUse(id, null), true, id);
    assert.strictEqual(P.canUse(id, free), false, id);
    assert.strictEqual(P.canUse(id, pro), true, id);
    assert.strictEqual(P.canUse(id, spon), true, id);
  }
  assert.strictEqual(P.canUse('no-such-feature', pro), false);
  // Single-file SELECT, GROUP BY, sheet joins and history stay free for good.
  for (const f of ['sql-query', 'query-history', 'join-sheets']) assert.ok(P.FREE_FEATURES.includes(f), f);
});

test('isEnabled: free features always run, Pro features only with a license', () => {
  const off = P.entitlement({ PRO_ENABLED: false }, lic);
  const free = P.entitlement({ PRO_ENABLED: true }, null);
  const pro = P.entitlement({ PRO_ENABLED: true }, lic);
  for (const f of P.FREE_FEATURES) for (const e of [off, free, pro, null]) assert.strictEqual(P.isEnabled(f, e), true, f);
  for (const { id } of P.PRO_FEATURES) {
    assert.strictEqual(P.isEnabled(id, off), false, id);
    assert.strictEqual(P.isEnabled(id, free), false, id);
    assert.strictEqual(P.isEnabled(id, pro), true, id);
  }
  assert.strictEqual(P.isEnabled('no-such-feature', pro), false);
  // 0.4: the SQL filter, export and column stats moved to the free list (no paywall).
  // 0.5: two paid candidates for the Query panel (switched off at ship: config.PRO_ENABLED false).
  assert.deepStrictEqual(P.PRO_FEATURES.map(f => f.id), ['large-files', 'query-join-files', 'save-parquet']);
  for (const f of ['sql-filter', 'export', 'column-stats', 'copy-md', 'formulas']) assert.ok(P.FREE_FEATURES.includes(f), f);
});

test('limits: switch off keeps 0.1 behavior, free tier caps, Pro lifts the caps', () => {
  const big = { ...settings, maxRows: 5000000, maxFileSizeMB: 4000 };
  // Pro switched off: exactly the settings, so the shipped build behaves as 0.1.
  assert.deepStrictEqual(P.effectiveLimits(big, P.entitlement({ PRO_ENABLED: false }, null)), { ...big, capped: [] });
  // Pro on, no license: capped at the free limits, which equal the 0.1 defaults.
  const free = P.effectiveLimits(big, P.entitlement({ PRO_ENABLED: true }, null));
  assert.strictEqual(free.maxRows, 1000000);
  assert.strictEqual(free.maxFileSizeMB, 512);
  assert.deepStrictEqual(free.capped, ['maxRows', 'maxFileSizeMB']);
  assert.deepStrictEqual(P.effectiveLimits(settings, P.entitlement({ PRO_ENABLED: true }, null)).capped, []);
  assert.strictEqual(P.effectiveLimits({ ...settings, maxRows: 2000 }, P.entitlement({ PRO_ENABLED: true }, null)).maxRows, 2000);
  // Licensed: defaults rise to the Pro defaults; a value the user set wins (up or down).
  const pro = P.entitlement({ PRO_ENABLED: true }, lic);
  const lifted = P.effectiveLimits(settings, pro, []);
  assert.strictEqual(lifted.maxRows, P.PRO_DEFAULTS.maxRows);
  assert.strictEqual(lifted.maxFileSizeMB, P.PRO_DEFAULTS.maxFileSizeMB);
  assert.strictEqual(lifted.maxExcelSizeMB, P.PRO_DEFAULTS.maxExcelSizeMB);
  assert.strictEqual(lifted.maxCopyRows, 100000);
  const mine = P.effectiveLimits({ ...settings, maxRows: 9000000, maxFileSizeMB: 100 }, pro, ['maxRows', 'maxFileSizeMB']);
  assert.strictEqual(mine.maxRows, 9000000);
  assert.strictEqual(mine.maxFileSizeMB, 100);
  assert.ok(P.PRO_DEFAULTS.maxRows > P.FREE_LIMITS.maxRows && P.PRO_DEFAULTS.maxFileSizeMB > P.FREE_LIMITS.maxFileSizeMB);
});
