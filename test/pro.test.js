'use strict';
// Tiers: what the free tier gets, what Pro adds, and that the Pro switch off changes nothing.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/pro');

const lic = { valid: true, license: { plan: 'lifetime', expires: null, email: 'a@b.c' } };
const settings = { maxRows: 1000000, maxFileSizeMB: 512, maxExcelSizeMB: 50, maxCopyRows: 100000 };

test('entitlement: Pro switched off means no Pro, even with a valid key', () => {
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: false }, lic), { enabled: false, licensed: false, plan: null, expires: null, email: null });
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: true }, null), { enabled: true, licensed: false, plan: null, expires: null, email: null });
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: true }, { valid: false, reason: 'expired' }).licensed, false);
  assert.deepStrictEqual(P.entitlement({ PRO_ENABLED: true }, lic), { enabled: true, licensed: true, plan: 'lifetime', expires: null, email: 'a@b.c' });
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
  assert.deepStrictEqual(P.PRO_FEATURES.map(f => f.id), ['large-files']);
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
