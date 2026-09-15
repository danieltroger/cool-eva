import { decodeFrame, STREAM_IDS } from "../src/can/decode.ts";
import { CLUSTER_RANGE_CAN_ID, decodeClusterRangeFrame } from "../src/can/cluster-range.ts";
import { decodeHubOutputFrame } from "../src/can/hub-output.ts";
import { GPS_CAN_ID } from "../src/can/gps.ts";
import { BleTelemetryDecoder } from "../src/ble/protocol.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { parseHexBytes } from "./captured-vcu-records.ts";
import { boundsFor, isPlausible } from "../public/lib/bounds.js";

// The two frames the instrument cluster puts on this bus that we decode: 0x412's range
// estimate and 0x410's type-3 drive triple.
//
//   node --experimental-strip-types scripts/check-cluster-frames.ts
//
// ✅ EVERY FRAME BELOW IS REAL except ONE, which says so on its own line. A hand-written
// frame only proves the decoder agrees with whoever wrote it. ⚠️ An earlier version of this
// header claimed all of them were captured while three were composed from a per-byte census
// — real bytes, never that arrangement (it was two of them, not three). Provenance is on
// each case; grep the named file.
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

// ⚠️ parseHexBytes, not a Number.parseInt map. `parseInt` stops at the first invalid
// character and returns a VALID integer for a partial parse — parseInt("4Z", 16) is 4, and
// "100" is 256, which Buffer.from truncates to 0. Both would pass an isInteger guard and
// produce a fixture nobody captured, in a file whose header says every frame is real.
function frameOf(hex: string): Buffer {
  const bytes = parseHexBytes(hex);
  if (bytes.length !== 8) {
    throw new Error(`fixture is not 8 bytes: ${hex}`);
  }
  return Buffer.from(bytes);
}

/** Throws rather than skipping: a missing entry must fail, not quietly shrink the run. */
function signalFor(key: string) {
  const signal = SIGNALS.find(entry => entry.key === key);
  if (!signal) {
    throw new Error(`${key} is not in the registry`);
  }
  return signal;
}

function decodedValue(values: { key: string; value: number }[], key: string): number | undefined {
  return values.find(entry => entry.key === key)?.value;
}

console.log("§1 0x412 — the cluster's range estimate");

// `00 00 4F 00 …` is all 180 frames of obd-garage/captures/2026-08-02_bms_90s.log, where the
// hub's own type-2 range slot reads 0x004F in the same file. `03 06 40 00 …` is the 25 s
// parked-on-AC capture of 2026-09-15 (evidence/, gitignored).
//
// ⚠️ The third is NOT in ~/Documents/cool-eva-archive, which stops at 2026-08-09. It is
// `dedupe-capture-20260913-103237-4a07e1c7.txt` (160 occurrences), a per-boot extract in
// another session's scratchpad — `COUNT (timestamp) ID payload` rows, not candump lines, and
// no raw 2026-09-13 capture exists under ~/Documents at all. It is the one that pins the byte
// order: 0x0142 = 322 one way, 0x4201 = 16 897 the other, and only one of those is a range.
const RANGE_FIXTURES: [string, number, string][] = [
  ["00 00 4F 00 31 42 08 00", 79, "2026-08-02 parked, hub type-2 says 79 in the same file"],
  ["03 06 40 00 31 42 0A 00", 64, "2026-09-15 parked on AC, SOC 50 %"],
  ["00 00 42 01 31 42 04 00", 322, "dedupe-capture-20260913-103237, 160 frames, the per-boot maximum — HIGH BYTE SET"],
];
for (const [hex, expected, why] of RANGE_FIXTURES) {
  const got = decodedValue(decodeClusterRangeFrame(frameOf(hex)), "range_can_km");
  check(`${hex} → range_can_km ${expected} (${why})`, got === expected);
}
check("a short 0x412 frame decodes to nothing", decodeClusterRangeFrame(Buffer.alloc(4)).length === 0);
check(
  "0x412 reaches the decoder through decodeFrame, not just directly",
  decodedValue(decodeFrame(CLUSTER_RANGE_CAN_ID, frameOf("00 00 4F 00 31 42 08 00")), "range_can_km") === 79
);
check("0x412 is in STREAM_IDS, or the decoder is dead and nothing says so", STREAM_IDS.includes(CLUSTER_RANGE_CAN_ID));

console.log("§2 0x410 type 3 — the drive triple");

// All four verbatim from capture-20260809-161310-edcdcf23.log (43 417 type-3 frames);
// `grep -F` any of them in that file. Torque is asserted against a LITERAL, not recomputed
// from the decoded value: an earlier version checked power against `torque x rpm` using the
// torque it had just decoded, so any scale error cancelled and the assertion could not fail.
const OUTPUT_FIXTURES: [string, number, number, number, string][] = [
  ["03 FF 3E 00 C4 09 0F 00", 62, 2500, 15, "cruising — rpm high byte 0x09 set, pins little-endian"],
  ["03 FF 36 00 66 08 FE FF", 54, 2150, -2, "REGEN — b7 = 0xFF, torque must go negative"],
  ["03 FF 00 00 00 00 00 00", 0, 0, 0, "stationary"],
  ["03 FF AA 00 86 1A 40 00", 170, 6790, 64, "among the fastest in the capture — 170 km/h at 6 790 rpm"],
];
for (const [hex, speed, rpm, torque, why] of OUTPUT_FIXTURES) {
  const values = decodeHubOutputFrame(frameOf(hex));
  check(`${hex} → dash_speed_kmh ${speed} (${why})`, decodedValue(values, "dash_speed_kmh") === speed);
  check(`${hex} → motor_torque_can_nm ${torque}`, decodedValue(values, "motor_torque_can_nm") === torque);
  // Power is the only place rpm is observable, so it is asserted from the LITERAL rpm above.
  const expected = (torque * 2 * Math.PI * rpm) / 60000;
  check(
    `${hex} → motor_power_can_kw from rpm ${rpm}`,
    Math.abs((decodedValue(values, "motor_power_can_kw") ?? NaN) - expected) < 1e-9
  );
}

// ⚠️ THE TYPE BYTE NEEDS ITS OWN CASE. `1A 00 …` is rejected by the sub-index test alone, so
// with only that fixture a decoder that stopped checking byte 0 would pass. This is the real
// seed frame from 2026-08-02: b1 IS 0xFF, so ONLY the type test can reject it — and read as a
// drive triple it yields 49 850 km/h.
check(
  "the seed frame is rejected by the TYPE byte, not the sub-index",
  decodeHubOutputFrame(frameOf("00 FF BA C2 D8 3B 00 00")).length === 0
);
check(
  "sub-index other than 0xFF decodes to nothing",
  decodeHubOutputFrame(frameOf("03 00 3E 00 C4 09 0F 00")).length === 0
);
// ⚠️ The short frame must be a TYPE-3 one. `Buffer.alloc(4)` is all zeros, so the type test
// rejects it and the length guard is never reached — with only that case, deleting the length
// guard passes. A truncated `03 FF 3E` reads frame[4..7] off the end and yields NaN.
check("a short TYPE-3 frame decodes to nothing", decodeHubOutputFrame(Buffer.from([0x03, 0xff, 0x3e])).length === 0);
check(
  "type 3 reaches the decoder through decodeFrame on 0x410",
  decodedValue(decodeFrame(GPS_CAN_ID, frameOf("03 FF 3E 00 C4 09 0F 00")), "dash_speed_kmh") === 62
);
// 0x410 has three readers and decodeFrame spreads two of them. Without this, dropping the GPS
// half of that spread is invisible here — and `npm test` as a whole does not catch it either.
check(
  "the GPS reader SURVIVES on 0x410 — this id has more than one decoder",
  decodeFrame(GPS_CAN_ID, frameOf("1A 01 00 00 00 00 00 00")).some(entry => entry.key === "gps_fix")
);

// ⚠️ NOT A CAPTURED FRAME, and the only one in this file that is not. b3 is 0x00 in all 43 417
// type-3 frames of the 2026-08-09 archive — the bike cannot go fast enough to set it — so no
// real frame can tell a u16 speed from a u8 one. The width comes from the firmware instead:
// the packer at 0x6262C/0x62638 writes b2 and b3 from the two halves of ONE source variable,
// exactly as it does for rpm. Kept to hold that byte, not as evidence of anything.
check(
  "b3 is the speed's high byte (firmware-derived, no captured frame can show this)",
  decodedValue(decodeHubOutputFrame(frameOf("03 FF 01 01 00 00 00 00")), "dash_speed_kmh") === 257
);

console.log("§3 both transports, one unpacking — the claim that justifies sharing it");

// src/hub/output.ts exists so the CAN reader and the BLE reader cannot drift apart. Nothing
// enforced that until this section: `npm test` exercises no BLE path at all, so the shared
// module could have been rewired wrongly on the Bluetooth side and every other check here
// would still pass. One real frame, both decoders, same numbers.
{
  const frame = frameOf("03 FF 36 00 66 08 FE FF");
  const fromCan = decodeHubOutputFrame(frame);
  const fromBle = new BleTelemetryDecoder().decode(frame);
  check(
    "BLE and CAN agree on torque from one frame",
    decodedValue(fromBle, "motor_torque_nm") === decodedValue(fromCan, "motor_torque_can_nm")
  );
  check(
    "BLE and CAN agree on power from one frame",
    decodedValue(fromBle, "motor_power_kw") === decodedValue(fromCan, "motor_power_can_kw")
  );
  check("the BLE path still emits its own two keys", fromBle.length === 2);

  // ⚠️ The only coverage of BLE type 2 anywhere in the suite. `signed16` was deleted here in
  // favour of frame.ts's `i16le`, and these two keys were its last callers — they had no
  // assertion at all. `02 01 20 03 00 00 E8 FD` is from the 2026-08-02 capture; -5.36 is the
  // sentinel the hub emits at a standstill, and rides.db logged exactly that value that day.
  const standstill = new BleTelemetryDecoder().decode(frameOf("02 01 20 03 00 00 E8 FD"));
  check("BLE avg_consumption_wh_km reads 0 at a standstill", decodedValue(standstill, "avg_consumption_wh_km") === 0);
  check(
    "BLE km_per_kwh reads the -5.36 sentinel, so the sign survived",
    decodedValue(standstill, "km_per_kwh") === -5.36
  );
}

console.log("§4 registry and bounds — a signal the dashboard would reject is not decoded");

// ⚠️ `boundsFor` and `isPlausible` take (key, unit, group). An earlier draft of this file
// called them with one argument; `boundsFor` then returned null, `isPlausible` returned true
// for everything, and both assertions below passed against a signal with no bounds at all.
// They are only worth having with the registry's own unit and group threaded through.
for (const key of ["range_can_km", "dash_speed_kmh", "motor_torque_can_nm", "motor_power_can_kw"]) {
  // Only that the key EXISTS. Whether it is gated is the generator's repo-wide ratchet
  // (scripts/generate-signal-bounds.ts, "all 522 signals reach a rule or say why not"), and
  // restating it for four of them here was duplication. What the ratchet cannot see is a
  // decoder emitting a key the registry has never heard of — it iterates SIGNALS, not output.
  check(
    `${key} is in the registry`,
    SIGNALS.some(entry => entry.key === key)
  );
}

// The highest values actually measured must survive the gate, or a working bike reads as a
// broken sensor. 194 km/h of dash speed is from ~/Documents/cool-eva-archive; 322 km of range
// is from the 2026-09-13 per-boot extract named in §1, NOT from that archive. The
// out-of-range pair is what proves the gate is switched on for these keys at all.
const rangeSignal = signalFor("range_can_km");
const speedSignal = signalFor("dash_speed_kmh");
check("range_can_km 322 is plausible", isPlausible("range_can_km", 322, rangeSignal.unit, rangeSignal.group));
check("dash_speed_kmh 194 is plausible", isPlausible("dash_speed_kmh", 194, speedSignal.unit, speedSignal.group));
// ⚠️ READ the sibling's ceiling, do not restate it. Hard-coding 400 here passed while
// `speed_can_kmh` was mutated to [0, 500] — the assertion named a relationship and checked
// a constant.
const sibling = signalFor("speed_can_kmh");
const siblingCeiling = boundsFor(sibling.key, sibling.unit, sibling.group)?.[1];
check(
  "dash_speed_kmh is bounded no tighter than speed_can_kmh, which reads LOWER than it",
  siblingCeiling !== undefined && isPlausible("dash_speed_kmh", siblingCeiling, speedSignal.unit, speedSignal.group)
);
check(
  "range_can_km 5000 is REJECTED, so the gate is on",
  !isPlausible("range_can_km", 5000, rangeSignal.unit, rangeSignal.group)
);
check(
  "dash_speed_kmh 900 is REJECTED, so the gate is on",
  !isPlausible("dash_speed_kmh", 900, speedSignal.unit, speedSignal.group)
);

if (failures > 0) {
  console.error(`\ncheck-cluster-frames: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-cluster-frames: all checks passed");
