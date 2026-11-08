'use strict';
// Free and Pro features, and the limits each tier gets. Pure functions so tests can run them
// with the Pro switch on or off.

// Since 0.4 the SQL filter, export and column stats are free for everyone: the listing promises
// "no paywall", and the users who leave paywalled rivals are the ones we want.
const FREE_FEATURES = Object.freeze([
  'open-parquet', 'open-excel', 'open-csv', 'sort', 'filter', 'copy-csv', 'copy-tsv', 'copy-json', 'copy-md', 'parquet-schema',
  'sql-filter', 'export', 'column-stats', 'formulas',
]);

const PRO_FEATURES = Object.freeze([
  { id: 'large-files', title: 'Files past the free limits (more rows, bigger CSV and Excel files)' },
]);

// Free tier caps, used only when Pro is switched on. They equal the 0.1 defaults, so a free user
// keeps what they had out of the box.
const FREE_LIMITS = Object.freeze({ maxRows: 1000000, maxFileSizeMB: 512, maxExcelSizeMB: 50 });
// Pro defaults, used for a setting the user has not set. A value the user set always wins.
const PRO_DEFAULTS = Object.freeze({ maxRows: 5000000, maxFileSizeMB: 2048, maxExcelSizeMB: 200 });

/**
 * What this install may use.
 * @param {{PRO_ENABLED:boolean}} config
 * @param {{valid:boolean, license?:object}|null} licenseCheck result of verifyLicense, or null
 */
function entitlement(config, licenseCheck) {
  const enabled = !!(config && config.PRO_ENABLED);
  const licensed = enabled && !!(licenseCheck && licenseCheck.valid);
  return {
    enabled,
    licensed,
    plan: licensed ? licenseCheck.license.plan : null,
    expires: licensed ? licenseCheck.license.expires : null,
    email: licensed ? licenseCheck.license.email : null,
  };
}

/** True when a feature may run. With Pro switched off, Pro features stay hidden and off. */
function isEnabled(featureId, ent) {
  if (FREE_FEATURES.includes(featureId)) return true;
  if (!PRO_FEATURES.some(f => f.id === featureId)) return false;
  return !!(ent && ent.enabled && ent.licensed);
}

/**
 * Reader limits for this tier.
 * - Pro switched off: the settings as they are (0.1 behavior).
 * - Pro on, no license: settings capped at FREE_LIMITS.
 * - Licensed: settings the user set win; the rest use PRO_DEFAULTS.
 * @param {object} settings current values (defaults included)
 * @param {object} ent entitlement()
 * @param {string[]} [userSet] names of the settings the user set explicitly
 * @returns limits plus capped: names of the settings that the free tier lowered
 */
function effectiveLimits(settings, ent, userSet = []) {
  const out = { ...settings, capped: [] };
  if (!ent || !ent.enabled) return out;
  for (const k of Object.keys(FREE_LIMITS)) {
    if (ent.licensed) {
      if (!userSet.includes(k)) out[k] = PRO_DEFAULTS[k];
    } else if (Number(out[k]) > FREE_LIMITS[k]) {
      out[k] = FREE_LIMITS[k];
      out.capped.push(k);
    }
  }
  return out;
}

module.exports = { FREE_FEATURES, PRO_FEATURES, FREE_LIMITS, PRO_DEFAULTS, entitlement, isEnabled, effectiveLimits };
