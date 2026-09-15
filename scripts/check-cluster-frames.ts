import { decodeFrame, STREAM_IDS } from "../src/can/decode.ts";
import { CLUSTER_RANGE_CAN_ID, decodeClusterRangeFrame } from "../src/can/cluster-range.ts";
import { decodeHubOutputFrame } from "../src/can/hub-output.ts";
import { GPS_CAN_ID } from "../src/can/gps.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor, isPlausible } from "../public/lib/bounds.js";

// The two frames the instrument cluster puts on this bus that we decode: 0x412's range
// estimate and 0x410's type-3 drive triple.
//
//   node --experimental-strip-types scripts/check-cluster-frames.ts
//
// ✅ EVERY FRAME BELOW IS REAL. None is hand-written — a hand-written frame only proves
// the decoder agrees with whoever wrote the fixture. Provenance per case in FIXTURES.
//
// ⚠️ The endianness cases are the point of this file. 0x412 b2-b3 and 0x410 type 3's
// three fields are all little-endian pairs, and a big-endian mutant produces a plausible
// in-bounds number for every fixture whose high byte is zero — which is most of them. So
// each field gets a fixture whose two bytes DIFFER, where swapping them changes the value.
// Without those, the byte order is asserted by nothing. docs/can-0x410.md, docs/can-0x412.md.

let failures = 0;

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

function frameOf(hex: string): Buffer {
  const bytes = hex
    .trim()
    .split(/\s+/)
    .map(part => Number.parseInt(part, 16));
  if (bytes.length !== 8 || bytes.some(byte => !Number.isInteger(byte))) {
    throw new Error(`fixture is not 8 hex bytes: ${hex}`);
  }
  return Buffer.from(bytes);
}

function valueOf(values: { key: string; value: number }[], key: string): number | undefined {
  return values.find(entry => entry.key === key)?.value;
}

console.log("§1 0x412 — the cluster's range estimate");

// `00 00 4F 00 …` is all 180 frames of obd-garage/captures/2026-08-02_bms_90s.log, where the
// hub's own type-2 range slot reads 0x004F in the same file. `03 06 40 00 …` is the 25 s
// parked-on-AC capture of 2026-09-15 (evidence/, gitignored). The third is the 2026-08-09
// riding archive, and it is the one that pins the byte order: 0x0142 = 322 one way, 0x4201 =
// 16 897 the other, and only one of those is a range.
const RANGE_FIXTURES: [string, number, string][] = [
  ["00 00 4F 00 31 42 08 00", 79, "2026-08-02 parked, hub type-2 says 79 in the same file"],
  ["03 06 40 00 31 42 0A 00", 64, "2026-09-15 parked on AC, SOC 50 %"],
  ["00 00 42 01 31 42 04 00", 322, "2026-09-13 riding — HIGH BYTE SET, pins little-endian"],
];
for (const [hex, expected, why] of RANGE_FIXTURES) {
  const got = valueOf(decodeClusterRangeFrame(frameOf(hex)), "range_can_km");
  check(`${hex} → range_can_km ${expected} (${why})`, got === expected);
}
check("a short 0x412 frame decodes to nothing", decodeClusterRangeFrame(Buffer.alloc(4)).length === 0);
check(
  "0x412 reaches the decoder through decodeFrame, not just directly",
  valueOf(decodeFrame(CLUSTER_RANGE_CAN_ID, frameOf("00 00 4F 00 31 42 08 00")), "range_can_km") === 79
);
check("0x412 is in STREAM_IDS, or the decoder is dead and nothing says so", STREAM_IDS.includes(CLUSTER_RANGE_CAN_ID));

console.log("§2 0x410 type 3 — the drive triple");

// All four from capture-20260809-161310-edcdcf23.log (43 417 type-3 frames). The regen case
// carries b7 = 0xFF, which is what makes the torque read signed rather than assumed so.
const OUTPUT_FIXTURES: [string, number, number, string][] = [
  ["03 FF 6E 00 B0 04 10 00", 110, 1200, "cruising — rpm high byte set, pins little-endian"],
  ["03 FF 00 00 00 00 00 00", 0, 0, "stationary"],
  ["03 FF AB 00 C4 04 2C FF", 171, 1220, "REGEN — b7 = 0xFF, torque must go negative"],
];
for (const [hex, speed, rpm, why] of OUTPUT_FIXTURES) {
  const values = decodeHubOutputFrame(frameOf(hex));
  const torque = valueOf(values, "motor_torque_can_nm") ?? 0;
  const power = valueOf(values, "motor_power_can_kw") ?? 0;
  check(`${hex} → dash_speed_kmh ${speed} (${why})`, valueOf(values, "dash_speed_kmh") === speed);
  // Power is torque × rpm, so it pins the rpm field without asserting on a key we do not log.
  const expectedPower = (torque * 2 * Math.PI * rpm) / 60000;
  check(`${hex} → motor_power_can_kw from rpm ${rpm}`, Math.abs(power - expectedPower) < 1e-9);
}
check(
  "regen torque is negative, not 0xFF2C read unsigned",
  (valueOf(decodeHubOutputFrame(frameOf("03 FF AB 00 C4 04 2C FF")), "motor_torque_can_nm") ?? 0) < 0
);
check(
  "a non-type-3 0x410 frame decodes to nothing here",
  decodeHubOutputFrame(frameOf("1A 00 11 22 33 44 55 66")).length === 0
);
check(
  "sub-index other than 0xFF decodes to nothing",
  decodeHubOutputFrame(frameOf("03 00 6E 00 B0 04 10 00")).length === 0
);
check(
  "type 3 reaches the decoder through decodeFrame on 0x410",
  valueOf(decodeFrame(GPS_CAN_ID, frameOf("03 FF 6E 00 B0 04 10 00")), "dash_speed_kmh") === 110
);

// ⚠️ NOT A CAPTURED FRAME, and the only one in this file that is not. b3 is 0x00 in all
// 43 417 type-3 frames of the 2026-08-09 archive — the bike cannot go fast enough to set it —
// so no real frame can tell a u16 speed from a u8 one. The width comes from the firmware
// instead: the packer at 0x6262C/0x62638 writes b2 and b3 from the two halves of ONE source
// variable, exactly as it does for rpm. Without this case, a decoder that read b2 alone would
// pass every other assertion here; it is kept to hold that byte, not as evidence of anything.
check(
  "b3 is the speed's high byte (firmware-derived, no captured frame can show this)",
  valueOf(decodeHubOutputFrame(frameOf("03 FF 01 01 00 00 00 00")), "dash_speed_kmh") === 257
);

console.log("§3 registry and bounds — a signal the dashboard would reject is not decoded");

// ⚠️ `boundsFor` and `isPlausible` take (key, unit, group). An earlier draft of this file
// called them with one argument; `boundsFor` then returned null, `isPlausible` returned true
// for everything, and both assertions below passed against a signal with no bounds at all.
// They are only worth having with the registry's own unit and group threaded through.
for (const key of ["range_can_km", "dash_speed_kmh", "motor_torque_can_nm", "motor_power_can_kw"]) {
  const signal = SIGNALS.find(entry => entry.key === key);
  check(`${key} is in the registry`, signal !== undefined);
  if (!signal) {
    continue;
  }
  // The generator's own rule, not a stricter one: a signal may declare bounds, declare why it
  // has none, or reach a fallback rule by unit and group. What it may not do is arrive ungated.
  const reachesARule = boundsFor(signal.key, signal.unit, signal.group) !== null;
  check(`${key} reaches a bounds rule or says why not`, reachesARule || signal.unbounded !== undefined);
}

// The highest values actually measured must survive the gate, or a working bike reads as a
// broken sensor. 322 km of range and 194 km/h of dash speed are both from the archive; the
// out-of-range pair is what proves the gate is switched on for these keys at all.
const rangeSignal = SIGNALS.find(entry => entry.key === "range_can_km");
const speedSignal = SIGNALS.find(entry => entry.key === "dash_speed_kmh");
if (rangeSignal && speedSignal) {
  check("range_can_km 322 is plausible", isPlausible("range_can_km", 322, rangeSignal.unit, rangeSignal.group));
  check("dash_speed_kmh 194 is plausible", isPlausible("dash_speed_kmh", 194, speedSignal.unit, speedSignal.group));
  check(
    "range_can_km 5000 is REJECTED, so the gate is on",
    !isPlausible("range_can_km", 5000, rangeSignal.unit, rangeSignal.group)
  );
  check(
    "dash_speed_kmh 900 is REJECTED, so the gate is on",
    !isPlausible("dash_speed_kmh", 900, speedSignal.unit, speedSignal.group)
  );
}

if (failures > 0) {
  console.error(`\ncheck-cluster-frames: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-cluster-frames: all checks passed");
