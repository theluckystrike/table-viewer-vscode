'use strict';
// Build-time switches for the paid tier. Plain constants so esbuild inlines them.

module.exports = Object.freeze({
  // false: the shipped build shows no Pro badge, no Pro buttons and no license command in the palette,
  // and every limit works as in the free 0.1 release. Set to true once the payment link is live.
  PRO_ENABLED: false,
  // Where the Pro badge links to: the Zovo Pro page (price, what Pro adds, GitHub Sponsors, PayPal, team licence).
  PRO_URL: 'https://theluckystrike.github.io/zovo-plugin-factory/pro.html',
  // Ed25519 public key for license keys. The private key lives outside the repo
  // (~/.config/zovo-licenses/table-viewer-pro-ed25519.pem on the owner's Mac).
  LICENSE_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArjPHdD5Deq9D3RvYAStGThVduTVRrjY0hxY7i0MuQSI=
-----END PUBLIC KEY-----
`,
  // Zovo Pro keys (ZOVO1., sku zovo-pro): the Zovo live public key, the same one src/zovo-license.js embeds
  // (factory/sprint/pay/public-key.txt). Its private half is in the owner's keychain (ZOVO_LICENSE_PRIVKEY).
  ZOVO_PUBLIC_KEY: 'MCowBQYDK2VwAyEAtXEc+9zkJ34oa1Id1oSrAifTSxqhvKtMKZOo5ieX90k=',
  // SecretStorage key for the license text.
  LICENSE_SECRET: 'tableViewer.licenseKey',
});
