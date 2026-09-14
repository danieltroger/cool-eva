// @ts-check

import { boundsFor } from "./bounds.js";

// What range a FREEZE-FRAME field can physically be in.
//
// ⚠️ Its own file rather than more of ./bounds.js, which was already past CLAUDE.md's ~400
// lines and is about dashboard SIGNAL keys — `pack_v`, `coolant_in`, the things src/ws.ts
// broadcasts. Energica's infokey names are a second subject, and nothing here needs
// anything private: the aliases below map to signal keys and the lookup goes through
// `boundsFor`, which is exported.
//
// ⚠️ The NUMBERS are not restated here. Three of these fields are the same physical rails
// the 0x501 monitor publishes, read through KWP `0x17` instead, and a second set of limits
// for one quantity is how the two stop agreeing — so the aliases below map to signal keys
// and the lookup goes through `boundsFor`. Since #227 those numbers are declared beside
// their signals in src/can/registry.ts and generated into ./generated-bounds.js; the
// reasoning is docs/signal-bounds.md.

/**
 * Freeze-frame field name → the signal key whose bound already describes that quantity.
 *
 * ⚠️ These are the SAME PHYSICAL RAILS the 0x501 monitor publishes, read through KWP `0x17`
 * instead. Without the alias they reach BY_UNIT's `"mV"` rule — written for cell voltages,
 * [0, 5000] — and a healthy 12 V rail is drawn as a dead sensor. Measured, not feared: three
 * of the 29 captured 2026-08-08 replies carry `P_V12` at 12 720 or 12 736 mV and one carries
 * `P_12VLP` at 9 028 mV, and all four were rejected before this existed.
 * @type {Record<string, string>}
 */
const INFOKEY_ALIAS = {
  P_V12: "psu_12v_mv",
  P_12VLP: "psu_12v_lowpower_mv",
  P_I12: "psu_12v_load_ma",
};

/**
 * The 12 V accessory drivers — lights, indicators, horn, fan, water pump.
 *
 * ⚠️ Its only job is the `uint16_t` sentinel. All eight fields are u16 and `BY_UNIT["mA"]`
 * is [-100 000, 100 000], so that rule cannot reject any value the field can hold — it is a
 * field-width bound wearing a physical limit's clothes, the thing FIELD_U16 above warns
 * about by name. `0xFFFF` is 65.5 A, which no accessory on this bike draws.
 *
 * ⚠️ Deliberately NOT a tight band, and not aliased to `psu_12v_load_ma` whose reasoning is
 * about the DC-DC converter's capacity. `ai_WaterPumpCurrent_In` reading 0 mA IS `P0A07`,
 * and a short-circuit code is a genuinely high reading — so a band drawn round normal
 * current would flag the very measurements these codes exist to show.
 * @type {[number, number]}
 */
const ACCESSORY_DRIVER_MA = [0, 60_000];

const ACCESSORY_DRIVER_KEYS = new Set([
  "ai_WaterPumpCurrent_In",
  "ai_PosLightsCurrent_In",
  "ai_StopLightsCurrent_In",
  "ai_IndicatorLCurr_In",
  "ai_IndicatorRCurr_In",
  "ai_BeamCurrent_In",
  "ai_HornCurrent_In",
  "ai_FanCurrent_In",
]);

/**
 * The limits for one freeze-frame field, or null when nothing describes it.
 *
 * ⚠️ Call this with the SCALED value only. A field whose scaling this repo refuses
 * (`AvgDOD`'s malformed equation, `TotalExchangedAh`'s impossible result) is shown as a raw
 * number and says so — that is already the fault rendering, and gating a deliberately
 * unscaled number against the scaled unit's range produces a second, wrong complaint about
 * the same field. src/diagnostics/infokey-table.ts.
 *
 * ⚠️ The group is `""` on purpose: BOOLEAN_GROUPS can then never fire, so a status word with
 * a blank unit stays ungated rather than being drawn as a dead sensor for reading 3. 103 of
 * the 207 valued fields across the committed captures end up ungated, and that is right —
 * ADC counts, module status words, `rpm`, `km` and `Ah` have no bound on this dashboard
 * either.
 * @param {string} name Energica's own field name, e.g. "P_V12"
 * @param {string} unit the unit AFTER scaling
 * @returns {[number, number] | null}
 */
export function boundsForInfokey(name, unit) {
  if (ACCESSORY_DRIVER_KEYS.has(name)) {
    return ACCESSORY_DRIVER_MA;
  }
  return boundsFor(INFOKEY_ALIAS[name] ?? name, unit, "");
}

/**
 * Whether one freeze-frame field should be drawn as a fault, and why.
 *
 * ⚠️ THE RULE LIVES HERE rather than in the view that renders it, so a check can exercise
 * the shipped decision instead of a copy of it. The copy is the failure: the two halves
 * below are one sentence — "gate the SCALED value, never the raw one" — and a view holding
 * its own version of that sentence is a view that can quietly start gating `raw`.
 *
 * ⚠️ A field whose scaling this repo refuses (`AvgDOD`'s malformed equation,
 * `TotalExchangedAh`'s impossible result) is ALREADY a fault of its own kind: the number
 * shown is raw and claims no unit. Running it through a range drawn for the scaled unit
 * produces a second, wrong complaint about the same field — `AvgDOD` reads 25 658 against
 * a "%" range of 0…100 and is not out of range, it is unscaled.
 * @param {{ name: string, unit: string, value: number | null }} field
 * @returns {{ kind: "scaling-refused" } | { kind: "out-of-range", bounds: [number, number] } | null}
 */
export function infokeyFault(field) {
  if (field.value === null) {
    return { kind: "scaling-refused" };
  }
  const bounds = boundsForInfokey(field.name, field.unit);
  if (bounds !== null && (field.value < bounds[0] || field.value > bounds[1])) {
    return { kind: "out-of-range", bounds };
  }
  return null;
}
