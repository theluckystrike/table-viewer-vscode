# Table Viewer Pro

0.4.0 (2026-11-08): the SQL filter, export and column stats are free for everyone and always shown (the listing promises no paywall). Only the larger default limits remain in the Pro list, and the switch stays off. This file is not in the VSIX.

Status: the code is in place, and the switch is off. `PRO_ENABLED` is `false` in `src/config.js`, so the shipped build has no badge, no Pro buttons and no license command in the palette, and every limit works as in 0.1.0. Turn it on only after the Paddle checkout link works.

## What Pro adds

| | Free | Pro |
|---|---|---|
| Open Parquet, xlsx/xls/ods, CSV/TSV | yes | yes |
| Sort, column filters, search, schema | yes | yes |
| Copy selection as CSV/TSV/JSON | yes | yes |
| Rows loaded per file | 1,000,000 | 5,000,000 by default, any value you set |
| CSV/TSV read size | 512 MB | 2 GB by default, any value you set |
| Excel workbook size | 50 MB | 200 MB by default, any value you set |
| SQL WHERE filter (`fare > 20 AND city LIKE 'Par%'`) | | yes |
| Export the filtered, sorted rows to CSV, TSV, JSON, JSON Lines | | yes |
| Column stats: count, nulls, distinct, min, max, mean, text length, top 5 values | | yes |

The free limits equal the 0.1.0 defaults, so a free user keeps what they had out of the box. A licensed user who set a limit by hand keeps that value.

What it looks like when the switch is on:
- No license: one small "Pro" badge at the right end of the toolbar. Clicking it opens `PRO_URL`. When a file is cut at a free limit, the banner adds one sentence: "Table Viewer Pro loads larger files."
- Licensed: the badge turns green, and three buttons appear: SQL, Stats and Export.
- Commands: "Table Viewer: Enter license key" and "Table Viewer: Remove license key".

## Price

Proposal: $49 one-time (no end date), or $19 a year.

Evidence:
- SQLite Viewer PRO sells at $99 one-time or $24 a month. Its page says "Purchased 18 times recently" (vscode.sqliteviewer.app, from `run-20261106/wave6/out/I6B.md`). That extension has 3.74M installs. We are new, so we start at half its one-time price.
- The wave 6 plan (I6B, row M1) used $49 one-time: 4,320 installs a year x 0.5% paying x $49 = about $1,058 a year gross. That is an estimate, not a measurement.
- Paddle charges 5% + $0.50 per checkout (paddle.com/pricing, per I6B). Net per sale: $49 gives $46.05, $19 gives $17.55.
- The yearly price is about 40% of the one-time price, so a buyer who keeps the tool 3 years or more is better off with the one-time license. That pushes most buyers to the one-time license, which suits a small product with no server costs.

Keep the price fixed for the first 90 days, then look at the conversion. If fewer than 3 people buy in 90 days with the badge live, test $29 one-time before you add more features.

## How licenses work

- Keys are Ed25519-signed (node:crypto) and checked offline. The extension makes no network call.
- Key format: `TVPRO1.<payload>.<signature>`. The payload holds the license id, email, plan (`lifetime` or `yearly`), issue date and end date (yearly only).
- The public key is in `src/config.js` (`LICENSE_PUBLIC_KEY`).
- The private key is at `~/.config/zovo-licenses/table-viewer-pro-ed25519.pem` (mode 0600, outside the repo). Back it up to the password manager now. If you lose it, you can no longer make keys that this build accepts, and you must ship a new public key and send every buyer a new key.
- The key the user enters is kept in VS Code SecretStorage (the OS keychain), not in settings.
- A yearly key stops working the day after its end date, and the Pro buttons disappear. Free features keep working.
- The test keypair in `test/fixtures/license-test-ed25519.pem` is for tests only. The shipped public key rejects keys it signs, and a test checks that.

Limit to know about: the extension is MIT and its source is public, so someone could patch out the check. This is normal for VS Code extensions, and the check only needs to stop casual sharing. Do not spend time on obfuscation.

Make a key:

```sh
cd ~/plugin-market-intel-work/factory/products/table-viewer-vscode
export TV_LICENSE_PRIVATE_KEY=~/.config/zovo-licenses/table-viewer-pro-ed25519.pem
node scripts/make-license.mjs --email buyer@example.com --plan lifetime --id <paddle transaction id>
node scripts/make-license.mjs --email buyer@example.com --plan yearly --id <paddle transaction id>   # ends in 365 days
```

The script checks the new key against the matching public key before it prints it. If you need a new signing keypair (for example, if the old one leaked), run `node scripts/make-license.mjs --gen-keypair <dir>`. Then put the printed public key in `src/config.js` and ship a new version.

## Paddle setup (owner)

1. Sign up for Paddle Billing at paddle.com as the seller. Paddle is the merchant of record, so it collects and pays VAT and sales tax. It checks your business and your website before it allows live payments. The website needs a pricing page, terms, a privacy policy and a refund policy (14 days is common), and each page must name the product.
2. In the sandbox first (sandbox-vendors.paddle.com), create a product "Table Viewer Pro" with two prices:
   - "Lifetime": $49.00, one-time.
   - "Yearly": $19.00, recurring every 1 year.
3. Make the checkout: under Checkout, set a default payment link (your pricing page with Paddle.js, or a hosted checkout). Buy both prices with a sandbox test card and check that you get the emails.
4. Fulfillment, the first months, by hand: Paddle emails you on each sale. Run `make-license.mjs` with the buyer's email and the Paddle transaction id, and email the key to the buyer. At the expected volume (a few sales a month) this takes under 2 minutes per sale. For yearly plans, make a new yearly key on each renewal email.
5. Later, if sales pass about 20 a month, automate step 4 with a Paddle webhook on `transaction.completed`. A small Worker can sign the key and email it. That puts the private key in a cloud secret, so decide that on purpose. Follow the cloud cost rules (no KV write per request, no frequent cron).
6. Repeat steps 2 and 3 in the live account after Paddle approves it.
7. Turn Pro on in the extension:
   - `src/config.js`: `PRO_ENABLED: true`, and `PRO_URL` = the live pricing or checkout page.
   - README: add a short "Free and Pro" section with the table above. Say that the core stays free and MIT.
   - `package.json`: add `"pricing": "Trial"`. The Marketplace shows that label for extensions with paid features.
   - Bump the version, add a CHANGELOG entry, then run `npm test` and `npm run package`.
   - Make a key with the live private key, install the VSIX, enter the key, and check that the badge turns green and SQL, Stats and Export work. Then publish.

## Files

- `src/config.js`: the Pro switch, the badge URL and the public key.
- `src/license.js`: makes and checks keys.
- `src/pro.js`: tiers, feature checks, limits.
- `src/core/query.js`: SQL WHERE parser and evaluator (no dependencies, no eval).
- `src/core/stats.js`: column stats.
- `src/core/exportfile.js` and `Table.prototype.exportChunks`: streamed export.
- `scripts/make-license.mjs`: key tool.
- Tests: `test/license.test.js`, `test/pro.test.js`, `test/query.test.js`, `test/stats-export.test.js`, `test/pro-protocol.test.js`, `test/pro-extension.test.js`, `test/pro-webview.test.js`.

Not built yet: comparing two sheets or files side by side. It is the next Pro feature to consider if buyers ask for it.
