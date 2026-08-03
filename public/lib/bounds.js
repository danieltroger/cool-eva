// @ts-check

// Plausibility gate: what range a signal can physically be in.
//
// This exists because the real data is not clean. Across 7.6 M logged readings
// (Apr–Aug 2026) the bike has produced `coolant_in` at −242 °C in 59 450 rows and
// `coolant_out` at 988 °C in 40 351 rows — an open/flaky PT100, not noise — plus
// rarer 0xFFFF sentinels on the cell voltages, −32767 on GPS altitude, and
// `high_beam` briefly reading 193. Rendering those raw is how you end up watching
// "−242 °C" on a coolant tile at 90 km/h, and a single one of them destroys a
// sparkline's autoscale for as long as it stays in the window.
//
// The gate rejects rather than clamps. Clamping invents a plausible number and
// hides a real fault; dropping the sample keeps the last good value on screen and
// lets the tile say "fault" — which is the actionable thing, because on this bike
// an out-of-range coolant probe is a wire to go and wiggle.

/**
 * Physical limits per signal, widest that is still definitely wrong outside.
 * These are deliberately generous: the job is catching decode sentinels and dead
 * sensors, not second-guessing the bike.
 * @type {Record<string, [number, number]>}
 */
const BY_KEY = {
  // Custom watercooling loop. Glycol boils well under 988 and the pack is never
  // anywhere near −40; both observed faults land far outside this.
  "coolant_in": [-20, 120],
  "coolant_out": [-20, 120],
  // BMS pack temperatures. The −50 and 120 seen twice each are sentinels.
  "batt_temp_lo": [-30, 90],
  "batt_temp_hi": [-30, 90],
  "pack_temp_avg": [-30, 90],
  "cell_min_mv": [1500, 4500],
  "cell_max_mv": [1500, 4500],
  "cell_avg_mv": [1500, 4500],
  // A spread of 65535 is 0xFFFF arriving as "no data"; a negative one is that
  // subtracted from something. Two rows of each, but each one is a wrecked chart.
  "cell_spread_mv": [0, 2000],
  "pack_v": [0, 450],
  "pack_a": [-600, 600],
  "pack_kw": [-200, 200],
  "pack_resistance_mohm": [0, 5000],
  "residual_energy_wh": [0, 30_000],
  "gps_altitude_m": [-500, 9000],
  "gps_speed_kmh": [0, 300],
  "speed_kmh": [0, 300],
  "motor_rpm": [-12_000, 12_000],
  "aux_12v": [0, 20],
  "range_km": [0, 500],
};

/** Signals that are 1/0 flags, where anything else is a bad read. */
const BOOLEAN_GROUPS = new Set(["controls", "diag"]);

/**
 * …except these, which share the `diag` group with the 148 generated `dtc_*`
 * flags but are counts, not flags. `dtc_count` is 0…127 (PID 01) and
 * `warmups_since_clear` 0…255 (PID 30), so the group-wide 1/0 rule would reject
 * every value above 1 as a sensor fault — gating out exactly the stored-code
 * count that the sheet's OBD cross-check exists to show, precisely when there is
 * something to cross-check.
 */
const COUNTER_KEYS = new Set(["dtc_count", "warmups_since_clear", "dtc_list_count", "dtc_unrecognised_count"]);

/**
 * Fallbacks by unit, for the ~140 signals not worth naming individually.
 * @type {Record<string, [number, number]>}
 */
const BY_UNIT = {
  "°C": [-40, 200],
  "%": [0, 100],
  "mV": [0, 5000],
  "V": [-50, 900],
  "A": [-1000, 1000],
  "kW": [-300, 300],
};

/** Per-cell voltages are generated keys (`cell_v_lmu3_c5`), so match by prefix. */
const CELL_VOLTAGE_PREFIX = "cell_v_";

/**
 * True if `value` is a believable reading of `key`.
 * @param {string} key
 * @param {number} value
 * @param {string} unit
 * @param {string} group
 * @returns {boolean}
 */
export function isPlausible(key, value, unit, group) {
  if (!Number.isFinite(value)) {
    return false;
  }
  const range = boundsFor(key, unit, group);
  if (!range) {
    return true;
  }
  return value >= range[0] && value <= range[1];
}

/**
 * The limits applied to a signal, or null if it is unbounded.
 * @param {string} key
 * @param {string} unit
 * @param {string} group
 * @returns {[number, number] | null}
 */
export function boundsFor(key, unit, group) {
  const explicit = BY_KEY[key];
  if (explicit) {
    return explicit;
  }
  if (key.startsWith(CELL_VOLTAGE_PREFIX)) {
    return [1500, 4500];
  }
  if (COUNTER_KEYS.has(key)) {
    return [0, 1000];
  }
  // Flags are checked before units because their unit is "" — which would
  // otherwise fall through to unbounded and let high_beam=193 render as "on".
  if (BOOLEAN_GROUPS.has(group) && unit === "") {
    return [0, 1];
  }
  return BY_UNIT[unit] ?? null;
}
