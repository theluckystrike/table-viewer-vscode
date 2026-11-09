'use strict';
// Zovo Pro keys (ZOVO1., sku zovo-pro) unlock Table Viewer Pro next to the older TVPRO1 keys, offline.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const L = require('../src/license');
const P = require('../src/pro');
const config = require('../src/config');
const Z = require('../src/zovo-license');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function zkey(over = {}, key = privateKey) {
  const p = b64url(JSON.stringify({ v: 1, sku: 'zovo-pro', eh: '', sid: 'manual-paypal-7HX12345', iat: '2026-11-09', lm: true, ...over }));
  return `ZOVO1.${p}.${b64url(crypto.sign(null, Buffer.from('ZOVO1.' + p), key))}`;
}
const NOW = Date.parse('2026-11-10T12:00:00Z');
const opts = { publicKey: config.LICENSE_PUBLIC_KEY, zovoPublicKey: PUB, now: NOW };

test('a zovo-pro key (PayPal sale or Stripe) unlocks Table Viewer Pro', () => {
  const r = L.verifyLicense(zkey(), opts);
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.license, { v: 1, product: 'zovo-pro', sku: 'zovo-pro', id: 'manual-paypal-7HX12345', email: null, plan: 'lifetime', issued: '2026-11-09', expires: null, seats: 1 });
  const ent = P.entitlement({ PRO_ENABLED: true }, r);
  assert.strictEqual(ent.licensed, true);
  assert.strictEqual(ent.via, 'key');
  assert.strictEqual(ent.plan, 'lifetime');
  assert.strictEqual(P.isEnabled('save-parquet', ent), true);
});

test('team keys (zovo-pro + 5 seats, zovo-pro-team) and xlsx-pro keys unlock; other products do not', () => {
  assert.strictEqual(L.verifyLicense(zkey({ q: 5 }), opts).license.seats, 5);
  assert.strictEqual(L.verifyLicense(zkey({ sku: 'zovo-pro-team', q: 5 }), opts).valid, true);
  assert.strictEqual(L.verifyLicense(zkey({ sku: 'xlsx-pro' }), opts).valid, true);
  const hex = L.verifyLicense(zkey({ sku: 'hex-pro' }), opts);
  assert.strictEqual(hex.valid, false);
  assert.strictEqual(hex.reason, 'product');
});

test('wrapped keys, forged keys, test keys and expired yearly keys', () => {
  const k = zkey();
  assert.strictEqual(L.verifyLicense(` ${k.slice(0, 40)}\n${k.slice(40)} `, opts).valid, true);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.strictEqual(L.verifyLicense(zkey({}, other), opts).reason, 'signature');
  const [, body, sig] = k.split('.');
  const forged = b64url(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), sku: 'zovo-pro-team', q: 100 }));
  assert.strictEqual(L.verifyLicense(`ZOVO1.${forged}.${sig}`, opts).reason, 'signature');
  assert.strictEqual(L.verifyLicense('ZOVO1.abc', opts).reason, 'format');
  const t = zkey({ lm: false });
  assert.strictEqual(L.verifyLicense(t, { ...opts, zovoAllowTest: false }).reason, 'test');
  assert.strictEqual(L.verifyLicense(t, { ...opts, zovoAllowTest: true }).valid, true);
  const y = zkey({ exp: '2027-11-16' });
  assert.strictEqual(L.verifyLicense(y, { ...opts, now: Date.parse('2027-11-16T23:59:00Z') }).license.plan, 'yearly');
  const late = L.verifyLicense(y, { ...opts, now: Date.parse('2027-11-17T00:00:01Z') });
  assert.strictEqual(late.reason, 'expired');
  assert.match(late.message, /2027-11-16/);
});

test('TVPRO1 keys still work and still need the Table Viewer key', () => {
  const priv = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'fixtures', 'license-test-ed25519.pem')));
  const pub = crypto.createPublicKey(priv);
  const k = L.signLicense(L.makePayload({ email: 'buyer@example.com', issued: '2026-11-06' }), priv);
  assert.strictEqual(L.verifyLicense(k, { publicKey: pub, zovoPublicKey: PUB, now: NOW }).valid, true);
  // a ZOVO1-signing key cannot make a TVPRO1 key, and the reverse
  assert.strictEqual(L.verifyLicense(L.signLicense(L.makePayload({ email: 'x@y.z' }), privateKey), { publicKey: pub, now: NOW }).reason, 'signature');
  assert.match(L.verifyLicense('garbage', opts).message, /not a Table Viewer Pro license key\. It starts with ZOVO1 or TVPRO1/);
});

test('shipped config: the Zovo live public key, the same one zovo-license.js embeds; no private key in src', () => {
  assert.strictEqual(config.ZOVO_PUBLIC_KEY, Z.PUBLIC_KEY_SPKI_B64);
  assert.strictEqual(config.ZOVO_PUBLIC_KEY, 'MCowBQYDK2VwAyEAtXEc+9zkJ34oa1Id1oSrAifTSxqhvKtMKZOo5ieX90k=');
  // a key from another signer is refused by the shipped key (no zovoPublicKey override)
  assert.strictEqual(L.verifyLicense(zkey(), { publicKey: config.LICENSE_PUBLIC_KEY, now: NOW }).reason, 'signature');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src'))) {
    if (!f.endsWith('.js')) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), /PRIVATE KEY-----|MC4CAQAwBQYDK2Vw/, f);
  }
});

test('the Sponsors rail is the shared Zovo one: same cache key and sponsor login as every Zovo viewer', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'sponsors.js'), 'utf8');
  assert.match(s, /zovo\.pro\.sponsors\.v1/);
  assert.match(s, /theluckystrike/);
  const shared = path.join(require('os').homedir(), 'plugin-market-intel-work', 'factory', 'sprint', 'license', 'sponsors.js');
  if (fs.existsSync(shared)) assert.strictEqual(s, fs.readFileSync(shared, 'utf8'));
});

test('the Pro badge opens the live Zovo Pro page, not the old placeholder', () => {
  assert.strictEqual(config.PRO_URL, 'https://theluckystrike.github.io/zovo-plugin-factory/pro.html');
});
