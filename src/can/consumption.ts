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
// why it can be shipped from a capture taken two weeks ago. The two instantaneous fields are
// exact algebraic reciprocals of each other: 34.5 km/kWh IS 2.899 kWh/100 km. Under the scalings
// above that means `b0-1 × b2-3 ≈ 1 000 000`, and over the 2026-08-02 garage lap it holds on
// ALL 448 frames where neither field is saturated — 448 ok, 0 bad — once the 0.1 km/kWh
// quantisation of the first field is allowed for. Median product 1 000 051.
//
//   b0-1  ⇒ km/kWh   100 ÷ that   b2-3 observed
//    345      34.5      2.899          2900
//    230      23.0      4.348          4350
//    690      69.0      1.449          1450
//   2529     252.9      0.3954          395
//   3448     344.8      0.2900          290
//   4023     402.3      0.2486          249
//
// ⚠️ CORRECTION, 2026-08-16. The consolidated analysis on issue #21 states this relation in
// prose as `b2-3 == 100000 / (b0-1)`. That is off by a factor of ten and matches ZERO of the
// 448 frames; the constant is 1 000 000, which is what the ×0.1 and ×0.001 scalings force
// (100 ÷ (0.1 × 0.001) = 10^6). The table in that same comment is right — only the formula
// beside it is wrong. Written down here because it is exactly the kind of thing that gets
// copied into a check and then "fixed" by loosening the check.
//
// ✅ Which field is which is pinned by the saturated states, not by the reciprocal — the
// reciprocal test is symmetric under swapping the two scalings and cannot tell them apart.
// The capture can:
//   (0, 65000) occurs in 3603 frames, and the bike is at EXACTLY 0 km/h in all 3603 of them.
//   (65000, 0) occurs in 36 frames, all of them moving, mean 7.3 km/h — coasting.
//   Everything in between occurs only while moving: 0 of 449 at a standstill.
// Standing still means zero distance per kWh and infinite kWh per km, so b0-1 must be the
// km/kWh one. Read the other way round it would claim the parked bike is using no energy per
// km and returning 6500 km/kWh, which is backwards.
//
// 🟡 The 100 m averages carry the same scalings by position, and get the same saturation guard,
// for the same reason: they are the same two quantities over a different window, so the state
// where consumption is undefined has to exist for them too. This lap never showed it — but a
// clamped 65000 arriving unguarded is worse here than in the instantaneous pair, because it is
// small enough to look like an ordinary reading rather than an obvious sentinel.
//
// ⚠️ They are read UNSIGNED, and this is the one place this file disagrees with Energica, which
// declares them `short` where the instantaneous pair is `ushort`. A signed read is tempting —
// it is the call src/can/decode.ts already makes for 0x020's temperatures, where the argument is
// that signed "cannot regress anything" because no real temperature reaches 3276.7 °C. That
// argument does NOT carry over: km/kWh × 10 demonstrably does exceed 32767, because the
// instantaneous field on this very frame reached 33793 (3379.3 km/kWh) during the garage lap,
// paired with 0.030 kWh/100 km exactly as the reciprocal requires. So a signed read here would
// turn a real high-coasting average into a large negative — a plausible-looking regen figure —
// which is precisely the failure the unsigned read cannot produce.
//
// The residual announces itself instead of hiding, which is why unsigned is the safe direction:
// if these fields really are signed and a 100 m window of net regen ever occurs, it shows up as
// a value near 6553.5 km/kWh. That is impossible rather than plausible, and it is the signal to
// revisit this. A quietly negative number would not be.
//
// The other reason to keep them 🟡: this lap only ever produced TWO values, 1392/741 held for
// 3833 frames and 133/7500 for 255, one change in seven minutes. 133/7500 is
// reciprocal-consistent under these scalings and 1392/741 is not — which is what two
// independently averaged quantities do, and also what a wrong scale would do. Two samples is
// not a confirmation. They are logged (at one row per capture they cost nothing) so a real ride
// settles them; do not build anything on them yet.
