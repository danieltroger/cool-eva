// @ts-check

import { CELL_VOLTAGE_PATTERN } from "./cells.js";
import { SIGNAL_BOUNDS } from "./generated-bounds.js";

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
 * Signals that are 1/0 flags, where anything else is a bad read.
 *
 * `buttons` joined on 2026-08-16 with the handlebar buttons. Today their decoder can
 * only emit 0 or 1 (it returns `bit()`), so the gate rejects nothing — it is here for
 * the same reason `controls` is, which is that `high_beam` once read 193. A decoder
 * that later returns the masked byte instead of the bit (`handlebar & 0x20` is 32, not
 * 1) would otherwise paint a pressed button as an ordinary number, and a button tile
 * that lights on 32 but not on 1 is exactly the kind of quiet wrong answer this file
 * exists to stop.
 */
const BOOLEAN_GROUPS = new Set(["controls", "diag", "buttons"]);

/**
 * …except these, which share the `diag` group with the 154 generated `dtc_*`
 * flags but are counts, not flags. `dtc_count` is 0…127 (PID 01) and
 * `warmups_since_clear` 0…255 (PID 30), so the group-wide 1/0 rule would reject
 * every value above 1 as a sensor fault — gating out exactly the stored-code
 * count that the sheet's OBD cross-check exists to show, precisely when there is
 * something to cross-check.
 */
const COUNTER_KEYS = new Set([
  "dtc_count",
  "warmups_since_clear",
  "dtc_list_count",
  "dtc_unrecognised_count",
  // The OBD-II list lengths. dtc_stored_count reads 39 on this bike today, so
  // without these three the gate rejects the very number the Faults tab exists to
  // show — and rejects it precisely when there is something to show.
  "dtc_stored_count",
  "dtc_pending_count",
  "dtc_permanent_count",
]);

/**
 * Fallbacks by unit, for the ~140 signals not worth naming individually.
 * @type {Record<string, [number, number]>}
 */
const BY_UNIT = {
  "°C": [-40, 200],
  "%": [0, 100],
  // Written for cell voltages, which is why psu_12v_mv and psu_12v_lowpower_mv are
  // named individually above instead of falling through to it.
  "mV": [0, 5000],
  "V": [-50, 900],
  "A": [-1000, 1000],
  "kW": [-300, 300],
  // Added 2026-08-16 with the frames that introduced these units. Nm covers the
  // inverter's torque pair from 0x02C and, from the same change, motor_torque_nm off
  // the Connectivity Hub, which had been ungated: this platform's peak is ~215 Nm, so
  // ±400 cannot reject a real reading and does reject a wrong-endian or wrong-scale one.
  "Nm": [-400, 400],
  "bar": [0, 250],
  "mA": [-100_000, 100_000],
};

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
  // SIGNAL_BOUNDS is null-prototyped, so a key naming an Object.prototype member misses
  // here instead of resolving through the chain — see fallbackBoundsFor for what that
  // used to do.
  const declared = SIGNAL_BOUNDS[key];
  if (declared) {
    return declared;
  }
  return fallbackBoundsFor(key, unit, group);
}

/**
 * Everything boundsFor() consults EXCEPT the per-signal table — the rules that answer for
 * a whole shape rather than a named signal.
 *
 * Exported for one caller: scripts/generate-signal-bounds.ts asks it "does this signal
 * reach a rule without a declaration of its own?", which is the question its build-failing
 * ratchet is made of, and it cannot ask boundsFor() because that reads the table it is
 * generating.
 * @param {string} key
 * @param {string} unit
 * @param {string} group
 * @returns {[number, number] | null}
 */
export function fallbackBoundsFor(key, unit, group) {
  if (CELL_VOLTAGE_PATTERN.test(key)) {
    // The same band the decoder uses (MIN/MAX_PLAUSIBLE_CELL_MV in
    // src/can/decode-bms.ts), and deliberately not tighter.
    //
    // A tighter client gate is actively harmful here. The decoder's band is wide on
    // purpose — "far wider than this pack's own configured limits, so no real cell,
    // even a badly damaged one, can fall outside it" — and anything this rejects
    // does not reach signalState, so CellStrip goes on drawing the last good bar.
    // A cell collapsing to 1400 mV would then be invisible on the one screen whose
    // premise is that a single cell out of 81 ends the ride. The server has already
    // dropped the 0xFFFF sentinel and the 8192 mV pad; this is defence in depth, so
    // it should agree rather than second-guess.
    return [1000, 5000];
  }
  if (COUNTER_KEYS.has(key)) {
    return [0, 1000];
  }
  // Flags are checked before units because their unit is "" — which would
  // otherwise fall through to unbounded and let high_beam=193 render as "on".
  if (BOOLEAN_GROUPS.has(group) && unit === "") {
    return [0, 1];
  }
  // Object.hasOwn, not a bare read: BY_UNIT is a plain object literal, so a unit naming an
  // Object.prototype member would otherwise return a function and be treated as a range.
  return Object.hasOwn(BY_UNIT, unit) ? BY_UNIT[unit] : null;
}
