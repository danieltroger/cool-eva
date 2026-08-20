// @ts-check

import { CELL_VOLTAGE_PATTERN } from "./cells.js";

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
  // The hub's own consumption figures, both of which emit nonsense at a standstill:
  // kwh_per_100km has been seen at 650 (6500 Wh/km) and km_per_kwh at 0. Generous
  // enough to keep a genuinely awful climb, tight enough to drop the sentinels.
  "kwh_per_100km": [0, 100],
  "km_per_kwh": [0.5, 200],
  // Mode 01 PID 02's freeze-frame code — an IDENTIFIER, not a measurement, so the
  // whole 16-bit space is legitimate (P0514 is 0x0514 = 1300, and a U-code reaches
  // 0xFFFF). It needs its own entry rather than COUNTER_KEYS below, whose 0…1000
  // would reject most of the range. 0 is meaningful too: it is the bike's own way
  // of saying no freeze frame is stored.
  "freeze_frame_dtc": [0, 65_535],
  // The DC fast-charge contactor monitor: a 1/0 flag that lives in a group full of
  // real measurements. It needs this per-key entry because neither of the other two
  // routes reaches it — `charge` is not a BOOLEAN_GROUP and must not become one
  // (`mains_v` and `dc_a` live there), and its unit is "" precisely so it cannot fall
  // into BY_UNIT's numeric ranges. Without this line boundsFor() returns null and the
  // signal renders whatever arrives, which is the one outcome this file exists to
  // prevent. Same reasoning as the `buttons` group, applied one signal at a time.
  "fast_dc_contactor": [0, 1],
  // The DC charge-current limit the rider picked on the bike's own screen (0x121).
  // Named here because BY_UNIT's "A" fallback is [-1000, 1000], which would happily draw
  // a misread opcode byte as 147 A. 127 is the real hard stop, and it is not a guess: the
  // dial runs up to VCU parameter 258, a signed BYTE the manufacturer's service tool
  // writes through mask 127, so the screen cannot offer more however the bike is
  // optioned. Ours is 75.
  "dc_charge_limit_selected_a": [0, 127],
  // The charge manager's flags and raw state bytes (src/can/charge-manager.ts), added
  // 2026-08-19. Every one of them needs naming here for the same reason
  // `fast_dc_contactor` above does: a blank unit in the `charge` group — which cannot
  // become a BOOLEAN_GROUP, because `mains_v` and `dc_a` live in it — reaches no rule in
  // this file and renders whatever arrives.
  //
  // The two raw state bytes are gated to a byte rather than to the values they have been
  // seen to take. 0x610 b0 has produced seven values and b7 nine across 29 sessions, and
  // the point of logging them raw is to catch a state nobody has seen yet; a bound drawn
  // round today's set would reject exactly that.
  "dc_charging": [0, 1],
  "ac_charging": [0, 1],
  "bms_leak_detect_inhibit": [0, 1],
  // 1 = AC, 2 = DC. 0 has not been observed while a session is up, but the byte is 0
  // during the frames either side of one, so the bound starts there.
  "charge_type": [0, 2],
  "charge_manager_status": [0, 255],
  "charge_manager_state": [0, 255],
  // The charge manager's NUMERIC signals, added 2026-08-20. Same miss as
  // `dc_charge_limit_selected_a` above from the other direction: these DO reach a rule,
  // but it is BY_UNIT's "A" fallback of [-1000, 1000] and every one of them is a plain
  // u8, so no value a byte can hold was rejectable and the gate was decorative.
  //
  // ⚠️ 127 is `MAX_DC_CHG_CURRENT`'s FIELD range, NOT the 80 this project's write policy
  // stops at: a plausibility gate is about what the field can legitimately carry, and
  // bounding at 80 would draw a dealer write or a differently-optioned bike as a dead
  // SENSOR. 150 on `fast_dc_a` covers a measured 12 A step-edge skew; 80 on
  // `ac_supply_limit_a` is IEC 61851's control-pilot ceiling, not this bike's.
  //
  // These are the second line of defence — src/can/charge-manager.ts checks frame
  // invariants first — and the two layers fail differently. Each bound's derivation:
  // docs/dashboard-decisions.md §"The charge manager's numeric bounds".
  "fast_dc_a": [0, 150],
  "fast_dc_limit_a": [0, 127],
  "fast_dc_limit_max_a": [0, 127],
  "ac_supply_limit_a": [0, 80],
  // The charge manager's pack voltage, 0x615 b0 + 242.5. Its decoded range is 242.5…497.5 V and
  // the "V" fallback is [-50, 900], so an all-ones payload draws 497.5 V as a measurement. It is
  // the SAME QUANTITY as `pack_v`, which is named [0, 450] near the top of this table for
  // exactly this reason, so it gets exactly that band: a second witness must not be looser,
  // or the two disagree about what counts as a fault. The lower half is unreachable — the
  // decoder drops b0 = 0 — and is kept only so the two entries stay visibly identical.
  "charge_manager_pack_v": [0, 450],
  // 0x501, the PSU monitor. These three MUST be named here, and the first two are the
  // reason this comment exists: their unit is "mV", and BY_UNIT's mV fallback is
  // [0, 5000] because it was written for cell voltages. A healthy 12 704 mV rail would
  // fall straight through it and be drawn as a dead sensor — the exact failure this
  // whole file exists to prevent, arrived at from the opposite direction. 20 000 mV is
  // well above anything a 12 V system produces and well below the 65 535 a decode
  // failure would show.
  "psu_12v_mv": [0, 20_000],
  "psu_12v_lowpower_mv": [0, 20_000],
  // The DC-DC's own u16 tops out at 65 535 mA; this bike's converter is nowhere near
  // 60 A, so anything above that is a decode failure rather than a load.
  "psu_12v_load_ma": [0, 60_000],
  // 0x0A0 wheel speeds. Same 0…300 as speed_kmh and gps_speed_kmh. The field is a u16
  // at 0.05625 km/h per count, so a botched decode reaches 3686 km/h and is caught.
  "wheel_speed_front_kmh": [0, 300],
  "wheel_speed_rear_kmh": [0, 300],
  // 0x0A0 front brake pressure. A u8 in bar cannot be negative or exceed 255, so this
  // gate can only catch a future widening of the field — worth having anyway, because
  // 255 bar on a brake tile would be believed by anyone reading it quickly.
  "front_brake_pressure_bar": [0, 250],
  // 0x127's two throttle channels are 12-bit ADC counts, so 4095 is the ceiling by
  // construction. Their unit is blank and their group is not a boolean one, which means
  // without this they would be entirely ungated.
  "throttle_sensor_a_raw": [0, 4095],
  "throttle_sensor_b_raw": [0, 4095],
  // 0x10B, the VCU's own consumption — the same two quantities as km_per_kwh /
  // kwh_per_100km above, down a different path, and deliberately NOT given the same
  // band. The hub's pair is smoothed; this one is instantaneous at 10 Hz, and an
  // instantaneous km/kWh is unbounded above by construction — coast or regen for a
  // moment and you cover distance on no net energy at all. Replaying the 2026-08-02 lap
  // through this gate at the hub's [0.5, 200] rejected 159 of 448 readings, a third of a
  // healthy signal drawn as a dead sensor, which is this file's own failure mode.
  //
  // Those readings are real, not decode noise: the peak, 3379.3 km/kWh, pairs with
  // 0.030 kWh/100 km in the same frame, and 3379.3 × 0.0296 = 100 exactly as the
  // reciprocal requires. So the honest bound is the whole range the field can still
  // express once the decoder has dropped the ≥ 65000 saturation clamp — 6499.9 and
  // 64.999. Wide, but a narrower one here would be a guess about the bike rather than
  // about the decode, and only the decode is knowable from this side.
  "km_per_kwh_can": [0, 6500],
  "kwh_per_100km_can": [0, 65],
  // The 100 m averages are the same two quantities over a different window, read
  // unsigned and saturation-guarded exactly like the pair above, so they get the same
  // band. See src/can/consumption.ts for why unsigned, against Energica's own `short`.
  "km_per_kwh_100m_can": [0, 6500],
  "kwh_per_100km_100m_can": [0, 65],
  // ⚠️ NOT a 1/0 flag, despite living in `diag` with a blank unit. Energica's
  // `A_WARN_LAMP` is `byte 4 mask 0x0C >> 2` — TWO bits, so 0…3 — and the mask is kept
  // as the vendor wrote it rather than narrowed to the one bit this bike has been seen
  // to use. Without this entry the group-wide boolean rule would gate it to [0, 1] and
  // reject lamp states 2 and 3 as a dead sensor, precisely when the lamp has something
  // to say. BY_KEY is consulted before BOOLEAN_GROUPS, so naming it here is what wins.
  "abs_warning_lamp": [0, 3],
  // 0x125's two channels are raw counts with a blank unit in a non-boolean group, which
  // is the combination that falls through every rule in this file and ends up ungated —
  // the same miss `fast_dc_contactor` above had to be fixed for. There is no scale to
  // bound them by (see src/can/drive.ts), so the bound is derived from the one thing
  // that is known: at the measured ~109-117 counts per km/h this bike's 200 km/h top
  // speed is at most ~23 400 counts, so 40 000 cannot reject a real reading and does
  // reject the wild value a wrong offset or width would produce.
  "speed_redundant_a_raw": [0, 40_000],
  "speed_redundant_b_raw": [0, 40_000],
};

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
  const explicit = BY_KEY[key];
  if (explicit) {
    return explicit;
  }
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
  return BY_UNIT[unit] ?? null;
}
