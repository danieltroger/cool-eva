// The VCU's own consumption figures, CAN 0x10B `VCU_VEHICLE_CONSUMPTION` at 10 Hz.
//
// Layout is Energica's, from `FramesDB.ParseVCU_VEHICLE_CONSUMPTION`
// (the 2024 service-tool analysis in obd-garage/, §`0x10B`):
//
//   b0-1 LE u16  V_INST_KM_KWH        instantaneous, km/kWh
//   b2-3 LE u16  V_INST_KWH_100KM     instantaneous, kWh/100 km
//   b4-5 LE s16  V_AVG100M_KM_KWH     averaged over the last 100 m
//   b6-7 LE s16  V_AVG100M_KWH_100KM  averaged over the last 100 m
//
// Worth knowing against #39, which measures consumption by integrating pack power: the bike
// broadcasts its own answer at 10 Hz and has done all along.

import { type DecodedValue, u16le } from "./frame.ts";

export const CONSUMPTION_CAN_ID = 0x10b;

/**
 * Decodes one 0x10B frame. Pure: bytes in, values out.
 *
 * The instantaneous pair is emitted only when it is a measurement. When consumption is
 * undefined the VCU sends the pair saturated instead — see SATURATED below — and there is
 * no honest number to log, so nothing is: the series is sparse by design, the same shape
 * `batt_temp_lo`/`batt_temp_hi` already have. Clamping or passing the sentinel through would
 * put 65 kWh/100 km on the chart every time the bike stands still, and bounds.js would accept
 * it, because 65 kWh/100 km is not an impossible number — just a false one.
 */
export function decodeConsumptionFrame(data: Buffer): DecodedValue[] {
  if (data.length < 8) return [];
  const values: DecodedValue[] = [];
  const instantKmPerKwh = u16le(data[0], data[1]);
  const instantKwhPer100Km = u16le(data[2], data[3]);
  if (!isSaturated(instantKmPerKwh) && !isSaturated(instantKwhPer100Km)) {
    values.push(
      { key: "km_per_kwh_can", value: instantKmPerKwh / 10 },
      { key: "kwh_per_100km_can", value: instantKwhPer100Km / 1000 }
    );
  }
  const average100mKmPerKwh = u16le(data[4], data[5]);
  const average100mKwhPer100Km = u16le(data[6], data[7]);
  if (!isSaturated(average100mKmPerKwh) && !isSaturated(average100mKwhPer100Km)) {
    values.push(
      { key: "km_per_kwh_100m_can", value: average100mKmPerKwh / 10 },
      { key: "kwh_per_100km_100m_can", value: average100mKwhPer100Km / 1000 }
    );
  }
  return values;
}

// Both ends of the saturated pair. The VCU clamps at 65000 rather than using 0xFFFF, so the
// two states it can be in are (0, 65000) and (65000, 0); either field hitting either end means
// the whole pair is undefined, because the two fields are reciprocals of one quantity.
const SATURATED_HIGH = 65000;
const isSaturated = (raw: number): boolean => raw === 0 || raw >= SATURATED_HIGH;

// ✅ This frame proves its own layout AND both of its scalings with no bike involved, which is
// why it could ship from a two-week-old capture: the two instantaneous fields are exact
// algebraic reciprocals, so `b0-1 × b2-3 ≈ 1 000 000`, and that holds on ALL 448 unsaturated
// frames of the garage lap — 448 ok, 0 bad, median product 1 000 051.
//
// ⚠️ Issue #21's prose states the relation as `b2-3 == 100000 / (b0-1)`. That is off by a
// factor of ten and matches ZERO of the 448 frames. Recorded because it is exactly the kind of
// thing that gets copied into a check and then "fixed" by loosening the check.
//
// ✅ Which field is which is pinned by the SATURATED states, not by the reciprocal, which is
// symmetric under swapping the scalings: (0, 65000) occurs in 3603 frames and the bike is at
// exactly 0 km/h in all 3603, so b0-1 must be the km/kWh one.

// 🟡 The 100 m averages are read UNSIGNED — the one place this file disagrees with Energica,
// which declares them `short`. The "signed cannot regress anything" argument that 0x020's
// temperatures use does NOT carry over: this frame has already been seen at 33793 (3379.3
// km/kWh), so a signed read would turn a real high-coasting average into a plausible-looking
// negative. Unsigned fails loudly instead, at ~6553.5 km/kWh. Two samples in one lap is not a
// confirmation; they are logged so a real ride settles them, but do not build on them yet.
//
// Reciprocal table, saturation census and the full unsigned argument:
// docs/can-decode-findings.md § "0x10B — VCU_VEHICLE_CONSUMPTION".
