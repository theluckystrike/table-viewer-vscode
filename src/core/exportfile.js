'use strict';
// Streams export chunks to a file without holding the whole export in memory.
const fs = require('fs');

/**
 * @param {string} file path to write (replaced if it exists)
 * @param {Iterable<string>} chunks
 * @returns {Promise<number>} bytes written
 */
async function writeChunks(file, chunks) {
  const out = fs.createWriteStream(file);
  let failed = null;
  out.on('error', e => { failed = failed || e; });
  let bytes = 0;
  try {
    for (const chunk of chunks) {
      if (failed) throw failed;
      bytes += Buffer.byteLength(chunk);
      if (!out.write(chunk)) {
        await new Promise(resolve => { out.once('drain', resolve); out.once('error', resolve); });
      }
    }
    if (failed) throw failed;
  } finally {
    await new Promise(resolve => { if (out.destroyed) resolve(); else out.end(resolve); });
  }
  if (failed) throw failed;
  return bytes;
}

module.exports = { writeChunks };
