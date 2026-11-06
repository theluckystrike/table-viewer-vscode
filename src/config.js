'use strict';
// Build-time switches for the paid tier. Plain constants so esbuild inlines them.

module.exports = Object.freeze({
  // false: the shipped build shows no Pro badge, no Pro buttons and no license command in the palette,
  // and every limit works as in the free 0.1 release. Set to true once the payment link is live.
  PRO_ENABLED: false,
  // Where the Pro badge links to. Placeholder until the Paddle checkout page exists.
  PRO_URL: 'https://zovo.one/table-viewer/pro',
  // Ed25519 public key for license keys. The private key lives outside the repo
  // (~/.config/zovo-licenses/table-viewer-pro-ed25519.pem on the owner's Mac).
  LICENSE_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArjPHdD5Deq9D3RvYAStGThVduTVRrjY0hxY7i0MuQSI=
-----END PUBLIC KEY-----
`,
  // SecretStorage key for the license text.
  LICENSE_SECRET: 'tableViewer.licenseKey',
});
