'use strict';
// Runs in a worker thread so parsing, sorting and filtering never block the extension host.
const { parentPort } = require('worker_threads');
const { createSession } = require('./core/protocol');
const { loadFile } = require('./core/readers');
const { writeChunks } = require('./core/exportfile');
const { tableToText } = require('./core/totext');

const session = createSession({
  post: msg => parentPort.postMessage(msg),
  loader: (source, format, options, onPreview) => loadFile(source, format, options, onPreview),
  writeFile: writeChunks,
});

parentPort.on('message', msg => {
  if (msg && msg.type === 'toText') {
    // One-shot worker for the compare commands: the file as CSV text.
    tableToText(msg.source, msg.format, msg.options, msg.maxRows)
      .then(r => parentPort.postMessage({ type: 'textResult', ok: true, ...r }))
      .catch(e => parentPort.postMessage({ type: 'textResult', ok: false, error: e && e.message ? e.message : String(e) }));
    return;
  }
  Promise.resolve()
    .then(() => session.handle(msg))
    .catch(e => session.fail(e));
});
