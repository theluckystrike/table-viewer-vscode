'use strict';
// Everything the worker session needs to run queries and save Parquet. Handed to createSession by worker.js, so the
// extension host bundle (which also loads protocol.js for message validation) does not carry the readers.
const { runSql, createContext, DEFAULTS } = require('./exec');
const { createResolver, resultTable } = require('./index');
const { writeParquet } = require('../parquetout');

module.exports = { runSql, createContext, DEFAULTS, createResolver, resultTable, writeParquet };
