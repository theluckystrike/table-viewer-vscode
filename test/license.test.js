'use strict';
// Offline license keys: Ed25519 sign and verify, with a test keypair that never ships.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const L = require('../src/license');
const config = require('../src/config');

const TEST_KEY_FILE = path.join(__dirname, 'fixtures', 'license-test-ed25519.pem');
const priv = crypto.createPrivateKey(fs.readFileSync(TEST_KEY_FILE));
const pub = crypto.createPublicKey(priv);
const NOW = Date.parse('2026-11-06T12:00:00Z');
const opts = { publicKey: pub, now: NOW };

function key(p) { return L.signLicense(L.makePayload({ email: 'buyer@example.com', issued: '2026-11-06', ...p }), priv); }

test('a lifetime key signed with the private key verifies offline', () => {
  const k = key({ plan: 'lifetime', id: 'ord_1' });
  assert.match(k, /^TVPRO1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const r = L.verifyLicense(k, opts);
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.license, { v: 1, product: 'table-viewer-pro', id: 'ord_1', email: 'buyer@example.com', plan: 'lifetime', issued: '2026-11-06', expires: null });
});

test('a key wrapped by a mail client, with spaces and line breaks, still verifies', () => {
  const k = key({});
  const wrapped = '  ' + k.slice(0, 40) + '\n' + k.slice(40, 90) + ' \r\n' + k.slice(90) + '\n';
  assert.strictEqual(L.verifyLicense(wrapped, opts).valid, true);
});

test('yearly keys work until the end date and stop the day after', () => {
  const k = key({ plan: 'yearly' });
  const lic = L.verifyLicense(k, opts).license;
  assert.strictEqual(lic.expires, '2027-11-06');
  assert.strictEqual(L.verifyLicense(k, { publicKey: pub, now: Date.parse('2027-11-06T23:59:00Z') }).valid, true);
  const late = L.verifyLicense(k, { publicKey: pub, now: Date.parse('2027-11-07T00:00:01Z') });
  assert.strictEqual(late.valid, false);
  assert.strictEqual(late.reason, 'expired');
  assert.match(late.message, /2027-11-06/);
  assert.strictEqual(L.verifyLicense(key({ plan: 'yearly', days: 30 }), opts).license.expires, '2026-12-06');
});

test('a changed payload, a changed signature or a foreign key is rejected', () => {
  const k = key({});
  const [pre, body, sig] = k.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
  forged.plan = 'yearly'; forged.email = 'thief@example.com';
  const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
  assert.strictEqual(L.verifyLicense(`${pre}.${forgedBody}.${sig}`, opts).reason, 'signature');
  const badSig = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
  assert.strictEqual(L.verifyLicense(`${pre}.${body}.${badSig}`, opts).reason, 'signature');
  // Signed by someone else's key.
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.strictEqual(L.verifyLicense(L.signLicense(L.makePayload({ email: 'x@y.z' }), other), opts).reason, 'signature');
  // Short or empty signature.
  assert.strictEqual(L.verifyLicense(`${pre}.${body}.AAAA`, opts).reason, 'signature');
});

test('keys for another product or format version are rejected even when the signature is good', () => {
  const p = L.makePayload({ email: 'a@b.c' });
  assert.strictEqual(L.verifyLicense(L.signLicense({ ...p, product: 'pdf-viewer-pro' }, priv), opts).reason, 'product');
  assert.strictEqual(L.verifyLicense(L.signLicense({ ...p, v: 2 }, priv), opts).reason, 'version');
  assert.strictEqual(L.verifyLicense(L.signLicense({ ...p, plan: 'forever' }, priv), opts).reason, 'format');
  assert.strictEqual(L.verifyLicense(L.signLicense({ ...p, expires: 'soon' }, priv), opts).reason, 'format');
});

test('garbage input gives a plain message, never a throw', () => {
  for (const raw of ['', '   ', null, undefined, 'hello', 'TVPRO1..', 'TVPRO1.a.b.c', 'XX1.abc.def', 'TVPRO1.ab$.cd', 'x'.repeat(10000), 'TVPRO1.' + 'A'.repeat(50) + '.' + 'A'.repeat(86)]) {
    const r = L.verifyLicense(raw, opts);
    assert.strictEqual(r.valid, false, String(raw).slice(0, 30));
    assert.ok(r.message.length > 5);
  }
  assert.strictEqual(L.verifyLicense('', opts).reason, 'empty');
  assert.strictEqual(L.verifyLicense('abc', { publicKey: 'not a pem', now: NOW }).valid, false);
});

test('makePayload checks its input', () => {
  assert.throws(() => L.makePayload({ email: 'a@b.c', plan: 'monthly' }), /plan/);
  assert.throws(() => L.makePayload({ plan: 'lifetime' }), /email/);
  assert.throws(() => L.makePayload({ email: 'a@b.c', issued: '06/11/2026' }), /issued/);
  assert.match(L.makePayload({ email: 'a@b.c' }).id, /^lic_[0-9a-f]{16}$/);
});

test('the shipped public key is Ed25519, is not the test key, and the shipped build has Pro off', () => {
  const shipped = crypto.createPublicKey(config.LICENSE_PUBLIC_KEY);
  assert.strictEqual(shipped.asymmetricKeyType, 'ed25519');
  assert.notStrictEqual(shipped.export({ format: 'der', type: 'spki' }).toString('hex'), pub.export({ format: 'der', type: 'spki' }).toString('hex'));
  assert.strictEqual(L.verifyLicense(key({}), { publicKey: config.LICENSE_PUBLIC_KEY, now: NOW }).reason, 'signature');
  assert.strictEqual(config.PRO_ENABLED, false);
  assert.match(config.PRO_URL, /^https:\/\//);
});

test('no private key is in src/ or in the files that ship', () => {
  const root = path.join(__dirname, '..');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(root, 'src'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /PRIVATE KEY/, f);
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^test\/\*\*$/m, 'test/ (with the test key) must stay out of the VSIX');
  assert.match(ignore, /^scripts\/\*\*$/m);
});

test('scripts/make-license.mjs signs with the key from the environment and self-checks', () => {
  const script = path.join(__dirname, '..', 'scripts', 'make-license.mjs');
  const out = execFileSync(process.execPath, [script, '--email', 'buyer@example.com', '--plan', 'yearly', '--issued', '2026-11-06', '--id', 'ord_42'], {
    env: { ...process.env, TV_LICENSE_PRIVATE_KEY: TEST_KEY_FILE }, encoding: 'utf8',
  }).trim();
  const r = L.verifyLicense(out, opts);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.license.id, 'ord_42');
  assert.strictEqual(r.license.expires, '2027-11-06');
  const env = { ...process.env };
  delete env.TV_LICENSE_PRIVATE_KEY;
  const missing = spawnSync(process.execPath, [script, '--email', 'a@b.c'], { env, encoding: 'utf8' });
  assert.strictEqual(missing.status, 2);
  assert.match(missing.stderr, /TV_LICENSE_PRIVATE_KEY/);
  const noEmail = spawnSync(process.execPath, [script], { env: { ...process.env, TV_LICENSE_PRIVATE_KEY: TEST_KEY_FILE }, encoding: 'utf8' });
  assert.strictEqual(noEmail.status, 2);
});
