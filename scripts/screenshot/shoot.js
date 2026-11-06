// Captures screenshots of harness.html through CDP on an agent-chrome instance.
const fs = require('fs');
const port = process.argv[2], out = process.argv[3];
const url = 'file://' + __dirname + '/harness.html';
(async () => {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const waits = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result.value;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(1500);
  const pos = async (r, c) => JSON.parse(await evalJs(`(() => { const b = document.querySelectorAll('.body .row')[${r}].children[${c}].getBoundingClientRect(); return JSON.stringify({x: b.x + 10, y: b.y + 8}); })()`));
  const click = async (p, mod = 0) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mod });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: mod });
  };
  await click(await pos(2, 3));
  await click(await pos(6, 6), 8);
  await sleep(300);
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/${name}`, Buffer.from(r.result.data, 'base64')); };
  await shot('screenshot.png');
  await evalJs(`document.querySelector('.btn[title^="Show columns"]').click()`);
  await sleep(300);
  await shot('schema.png');
  await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
  ws.close();
  console.log('ok', await Promise.resolve(fs.readdirSync(out)));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
