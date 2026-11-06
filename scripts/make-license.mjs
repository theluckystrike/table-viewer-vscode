#!/usr/bin/env node
// Make a Table Viewer Pro license key, or a new signing keypair. Offline, no network.
//
//   TV_LICENSE_PRIVATE_KEY=~/.config/zovo-licenses/table-viewer-pro-ed25519.pem \
//     node scripts/make-license.mjs --email buyer@example.com --plan lifetime
//   node scripts/make-license.mjs --email buyer@example.com --plan yearly [--days 365] [--issued 2026-11-06] [--id ord_123] [--json]
//   node scripts/make-license.mjs --gen-keypair <dir>     writes <dir>/table-viewer-pro-ed25519.pem (0600) and prints the public key
//
// The private key path comes only from the environment. Never commit the private key.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { makePayload, signLicense, verifyLicense, generateKeyPair } = require(path.join(here, '..', 'src', 'license.js'));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[k] = true;
    else { out[k] = next; i++; }
  }
  return out;
}

function die(msg) { process.stderr.write(msg + '\n'); process.exit(2); }
function expand(p) { return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }

const a = args(process.argv.slice(2));

if (a['gen-keypair']) {
  if (a['gen-keypair'] === true) die('--gen-keypair needs a directory');
  const dir = expand(a['gen-keypair']);
  const file = path.join(dir, 'table-viewer-pro-ed25519.pem');
  if (fs.existsSync(file)) die(`${file} exists. Refusing to overwrite a signing key.`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kp = generateKeyPair();
  fs.writeFileSync(file, kp.privateKey, { mode: 0o600 });
  process.stdout.write(`Private key: ${file}\nPut this public key in src/config.js (LICENSE_PUBLIC_KEY):\n${kp.publicKey}`);
  process.exit(0);
}

const keyPath = process.env.TV_LICENSE_PRIVATE_KEY;
if (!keyPath) die('Set TV_LICENSE_PRIVATE_KEY to the path of the Ed25519 private key (PEM).');
if (!a.email || a.email === true) die('--email is required');
let privateKey;
try {
  privateKey = crypto.createPrivateKey(fs.readFileSync(expand(keyPath)));
} catch (e) {
  die(`Cannot read the private key: ${e.message}`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') die('The private key is not Ed25519.');

const payload = makePayload({
  email: a.email,
  plan: a.plan === true ? undefined : a.plan,
  id: typeof a.id === 'string' ? a.id : undefined,
  issued: typeof a.issued === 'string' ? a.issued : undefined,
  days: a.days ? Number(a.days) : undefined,
});
const key = signLicense(payload, privateKey);
// Self-check with the matching public key so a wrong key file is caught before a buyer sees it.
const check = verifyLicense(key, { publicKey: crypto.createPublicKey(privateKey) });
if (!check.valid) die(`Self-check failed: ${check.message}`);
process.stdout.write(a.json ? JSON.stringify({ key, payload }, null, 2) + '\n' : key + '\n');
