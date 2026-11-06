'use strict';
// Runs in a worker thread so parsing, sorting and filtering never block the extension host.
const { parentPort } = require('worker_threads');
const { createSession } = require('./core/protocol');
const { loadFile } = require('./core/readers');
const { writeChunks } = require('./core/exportfile');

const session = createSession({
  post: msg => parentPort.postMessage(msg),
  loader: (source, format, options, onPreview) => loadFile(source, format, options, onPreview),
  writeFile: writeChunks,
});

parentPort.on('message', msg => {
  Promise.resolve()
    .then(() => session.handle(msg))
    .catch(e => session.fail(e));
});
