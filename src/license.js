'use strict';
// Offline license keys for Table Viewer Pro. No network calls.
//
// Key format: TVPRO1.<payload>.<signature>
//   payload   = base64url(JSON {v, product, id, email, plan, issued, expires})
//   signature = base64url(Ed25519 signature over the ASCII text "TVPRO1.<payload>")
// The private key never ships. The extension holds only the public key (src/config.js).
//
// Zovo Pro keys (ZOVO1.<payload>.<sig>, sku zovo-pro, the shared key for every Zovo viewer) are accepted too. They are
// checked by src/zovo-license.js (a copy of factory/sprint/license/license.js) against the Zovo public key.

const crypto = require('crypto');

const PREFIX = 'TVPRO1';
const PRODUCT = 'table-viewer-pro';
const MAX_KEY_LEN = 4096;
const PLANS = new Set(['lifetime', 'yearly']);
const DAY_MS = 24 * 60 * 60 * 1000;
const ZOVO_PREFIX = 'ZOVO1.';
const ZOVO_SKU = 'xlsx-pro'; // a zovo-pro (or zovo-pro-team) bundle key grants it, as does a key made for xlsx-pro

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

/** Remove spaces and line breaks that mail clients add when a long key wraps. */
function normalizeKey(raw) {
  return String(raw || '').replace(/\s+/g, '');
}

function isDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')); }

/** Today as YYYY-MM-DD (UTC). */
function today(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

function addDays(day, days) { return today(Date.parse(day + 'T00:00:00Z') + days * DAY_MS); }

/**
 * Build the payload for a new license. plan 'yearly' expires after `days` (default 365).
 * @param {{email:string, plan?:string, id?:string, issued?:string, days?:number}} p
 */
function makePayload(p) {
  const plan = p.plan || 'lifetime';
  if (!PLANS.has(plan)) throw new Error(`plan must be lifetime or yearly, got ${plan}`);
  if (!p.email || typeof p.email !== 'string') throw new Error('email is required');
  const issued = p.issued || today();
  if (!isDay(issued)) throw new Error('issued must be YYYY-MM-DD');
  return {
    v: 1,
    product: PRODUCT,
    id: p.id || 'lic_' + crypto.randomBytes(8).toString('hex'),
    email: p.email.trim(),
    plan,
    issued,
    expires: plan === 'yearly' ? addDays(issued, Number.isFinite(p.days) ? p.days : 365) : null,
  };
}

/** Sign a payload with an Ed25519 private key (KeyObject or PEM). Returns the license key text. */
function signLicense(payload, privateKey) {
  const body = `${PREFIX}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign(null, Buffer.from(body, 'ascii'), privateKey);
  return `${body}.${b64url(sig)}`;
}

/**
 * A Zovo Pro key (ZOVO1.), checked offline with src/zovo-license.js. Same result shape as a TVPRO1 key.
 * opts.zovoPublicKey (base64 SPKI) defaults to the Zovo live key embedded in zovo-license.js; opts.zovoAllowTest
 * accepts test-mode keys (tests and gate builds only).
 */
function verifyZovoKey(key, opts) {
  const fail = (reason, message, license) => ({ valid: false, reason, message, ...(license ? { license } : {}) });
  const Z = require('./zovo-license');
  const r = Z.checkKey(key, ZOVO_SKU, { publicKey: opts.zovoPublicKey || undefined, allowTest: opts.zovoAllowTest, now: opts.now });
  const l = r.license;
  const lic = l ? {
    v: 1, product: 'zovo-pro', sku: l.sku, id: l.sessionId, email: null,
    plan: l.expires ? 'yearly' : 'lifetime', issued: l.issued, expires: l.expires, seats: l.seats,
  } : undefined;
  if (r.ok) return { valid: true, license: lic };
  switch (r.reason) {
    case 'signature': return fail('signature', 'This Zovo Pro key is not valid. Copy it again from the email, the whole line.');
    case 'version': return fail('version', 'This Zovo Pro key is for a newer version of Table Viewer. Update the extension.');
    case 'test': return fail('test', 'This is a test key. It does not unlock a released build.');
    case 'expired': return fail('expired', `This yearly license ended on ${l.expires}. Renew it to keep the Pro features.`, lic);
    case 'sku': return fail('product', 'This Zovo key is for another product. A Zovo Pro key unlocks the table viewer.');
    default: return fail('format', 'This Zovo Pro key is damaged. Copy it again from the email, the whole line.');
  }
}

/**
 * Check a license key offline.
 * @param {string} raw key text as pasted
 * @param {{publicKey: string|crypto.KeyObject, now?: number}} opts
 * @returns {{valid: true, license: object} | {valid: false, reason: string, message: string, license?: object}}
 */
function verifyLicense(raw, opts) {
  const fail = (reason, message, license) => ({ valid: false, reason, message, ...(license ? { license } : {}) });
  const key = normalizeKey(raw);
  if (!key) return fail('empty', 'Paste a license key.');
  if (key.length > MAX_KEY_LEN) return fail('format', 'This is not a Table Viewer Pro license key.');
  if (key.startsWith(ZOVO_PREFIX)) return verifyZovoKey(key, opts || {});
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return fail('format', 'This is not a Table Viewer Pro license key. It starts with ZOVO1 or TVPRO1.');
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return fail('format', 'The key has characters that do not belong in it. Copy it again from the email.');
  const sig = Buffer.from(parts[2], 'base64url');
  let ok = false;
  try {
    ok = sig.length === 64 && crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), opts.publicKey, sig);
  } catch {
    ok = false;
  }
  if (!ok) return fail('signature', 'This license key is not valid. Copy it again from the email, the whole line.');
  let lic;
  try {
    lic = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return fail('format', 'This license key is damaged.');
  }
  if (!lic || typeof lic !== 'object' || lic.v !== 1) return fail('version', 'This license key is for a newer version of Table Viewer. Update the extension.');
  if (lic.product !== PRODUCT) return fail('product', 'This license key is for another product.');
  if (!PLANS.has(lic.plan)) return fail('format', 'This license key has an unknown plan.');
  if (lic.expires !== null && !isDay(lic.expires)) return fail('format', 'This license key has a bad expiry date.');
  if (lic.expires && today(opts.now) > lic.expires) {
    return fail('expired', `This yearly license ended on ${lic.expires}. Renew it to keep the Pro features.`, lic);
  }
  return { valid: true, license: lic };
}

/** Generate a new Ed25519 keypair as PEM strings. */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

module.exports = { PREFIX, PRODUCT, ZOVO_PREFIX, ZOVO_SKU, verifyZovoKey, makePayload, signLicense, verifyLicense, normalizeKey, generateKeyPair, today, addDays };
