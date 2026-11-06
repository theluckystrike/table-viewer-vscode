'use strict';
// Seam for a later paid tier. Nothing is gated today: every shipped feature is free.
// Planned Pro features (not built yet) are listed so the UI and README can stay in sync.

const FREE_FEATURES = Object.freeze([
  'open-parquet', 'open-excel', 'open-csv', 'sort', 'filter', 'copy-csv', 'copy-tsv', 'copy-json', 'parquet-schema',
]);

const PLANNED_PRO_FEATURES = Object.freeze([
  { id: 'sql-query', title: 'SQL query over the file' },
  { id: 'export-parquet', title: 'Export to Parquet' },
]);

/** True when a feature may run. Free features always run; planned Pro features are not built yet. */
function isEnabled(featureId) {
  return FREE_FEATURES.includes(featureId);
}

module.exports = { FREE_FEATURES, PLANNED_PRO_FEATURES, isEnabled };
