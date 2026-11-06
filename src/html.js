'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.

const crypto = require('crypto');

/** CSP nonce from a cryptographic source: 32 base64url characters (192 bits). */
function nonce() {
  return crypto.randomBytes(24).toString('base64url');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {{cspSource:string, scriptUri:string, styleUri:string, title:string, nonce?:string}} p */
function buildHtml(p) {
  const n = p.nonce || nonce();
  const csp = [
    "default-src 'none'",
    `style-src ${p.cspSource}`,
    `script-src 'nonce-${n}'`,
    `img-src ${p.cspSource} data:`,
    `font-src ${p.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app" data-title="${escapeAttr(p.title)}"></div>
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr, nonce };
