import { decodeFrame } from "../src/can/decode.ts";
import { VEHICLE_STATUS_CAN_ID } from "../src/can/vehicle-status.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor, isPlausible } from "../public/lib/bounds.js";
import { parseHexBytes } from "./captured-vcu-records.ts";

// Replays real 0x101 frames through the real decoder, on a laptop, with no bike — the
// trick scripts/check-button-decode.ts plays for 0x102 and for the same reason.
//
//   node --experimental-strip-types scripts/check-vehicle-status.ts
//
// Every frame below is REAL, copied byte for byte with its timestamp out of the candump
// archive or out of evidence/captures/, except the one marked ⚠️ SYNTHETIC. A hand-written
// fixture only proves the decoder agrees with whoever wrote it, which is why that one is
// marked, counted separately in the success line, and used only where nothing real can do
// the job: `limp_module_word` is 0 in every frame on record, so no captured frame can tell
// bytes 6-7 from 4-5 or little-endian from big.
//
// This file stays narrow on purpose. scripts/check-can-decoders.ts already walks every
// registry entry, asks bounds.js which signals are 0/1 gated and fails a deadband on one,
// and names 0x101 in REQUIRED_IN_FILTER — so restating those here would be a second copy
// of a rule that has one home. What is left is what only this frame can be wrong about:
// the byte assignment, the vendor's double-assigned field, and the key collision with the
// BLE transport. Evidence for every number: docs/can-0x101.md.

interface FrameCase {
  /** What the bike was doing, and where the frame came from. */
  what: string;
  hex: string;
  /** Every key/value this frame must produce. */
  expect: Record<string, number>;
  /**
   * Hand-written rather than captured. The count goes in the success line, so it is a field
   * rather than a substring of `what`: prose is written for a person, and a case that said
   * "synthesised" would have been counted as evidence off the bike.
   */
  synthetic?: true;
}

/** The parked frame, named once: §1, §2 and §3 all read it and must read the SAME one. */
const PARKED_FRAME = "3E 3C 04 04 64 00 00 00";

const CASES: FrameCase[] = [
  {
    what: "parked — state 60 / substate 62, the pair obd-garage/CAN_MAP.md records off the BLE path. 2026-08-02 18:45:27.001407, capture-20260802-184526-1c8fc1e2.log",
    hex: PARKED_FRAME,
    expect: {
      vehicle_substate_can: 62,
      vehicle_state_can: 60,
      drive_vsm: 4,
      drive_vsm_b3: 0,
      limp_mode_status: 1,
      limp_res_valid: 0,
      vehicle_status_flags: 4,
      limp_pack_res: 100,
      limp_module_word: 0,
    },
  },
  {
    what: "the first substate of the drive-enable chain — state 40 / substate 46. 2026-08-02 21:05:00.216509, capture-20260802-210358-346ecdd5.log",
    hex: "2E 28 04 04 64 00 00 00",
    expect: { vehicle_substate_can: 46, vehicle_state_can: 40, drive_vsm: 4 },
  },
  {
    what: "⚠️ substate 150, bit 7 set — a step of the enable chain that belongs to no state band, which is why b1 latches while it is present (1 748 of 1 748 archive frames). 2026-08-02 21:05:00.316507, same capture",
    hex: "96 28 04 04 64 00 00 00",
    expect: { vehicle_substate_can: 150, vehicle_state_can: 40 },
  },
  {
    what: "state 100 / substate 101, and the UNNAMED b3 bit 4 set — flags 0x14. 2026-08-02 18:55:13.822123, capture-20260802-185513-563dd217.log",
    hex: "65 64 04 14 64 00 00 00",
    expect: {
      vehicle_substate_can: 101,
      vehicle_state_can: 100,
      vehicle_status_flags: 0x14,
      limp_mode_status: 1,
      limp_res_valid: 0,
    },
  },
  {
    what: "🚨 substate 83, the BLOCKING FAULT — 194 947 of the archive's 194 948 frames carrying 0x100's blocking-fault bit read this substate. 2026-08-07 21:18:44.322459, capture-20260807-203704-152918b6.log",
    hex: "53 50 04 14 55 00 00 00",
    expect: { vehicle_substate_can: 83, vehicle_state_can: 80, limp_pack_res: 85 },
  },
  {
    what: "state 1 / substate 3, the lowest state — 244 frames in the whole archive. 2026-08-02 20:40:17.611824, capture-20260802-203750-7ce067a7.log",
    hex: "03 01 04 14 64 00 00 00",
    expect: { vehicle_substate_can: 3, vehicle_state_can: 1 },
  },
  {
    what: "🔥 riding, drive_vsm 6 with b3's low bits CLEAR, and the UNNAMED b3 bit 6 set (flags 0x44). This frame is what proves the two V_DRIVE_VSM fields are read independently: reproduce Energica's double assignment and drive_vsm becomes 0. 2026-08-02 21:06:05.200454, capture-20260802-210358-346ecdd5.log",
    hex: "2B 28 06 44 72 00 00 00",
    expect: {
      vehicle_substate_can: 43,
      vehicle_state_can: 40,
      drive_vsm: 6,
      drive_vsm_b3: 0,
      vehicle_status_flags: 0x44,
      limp_pack_res: 114,
    },
  },
  {
    what: "b3's low bits reading 1 while b2 reads 6 — the two fields moving apart in the other direction. 2026-08-08 17:38:28.360889, capture-20260808-165920-ad7271eb.log",
    hex: "2B 28 06 05 4B 00 00 00",
    expect: { drive_vsm: 6, drive_vsm_b3: 1, limp_mode_status: 1, limp_res_valid: 0, limp_pack_res: 75 },
  },
  {
    what: "limp_res_valid SET, with b3's low bits clear — 28 134 archive frames. 2026-08-02 21:05:28.797867, capture-20260802-210358-346ecdd5.log",
    hex: "2B 28 06 0C 64 00 00 00",
    expect: { drive_vsm_b3: 0, limp_mode_status: 1, limp_res_valid: 1, vehicle_status_flags: 0x0c },
  },
  {
    what: "🔥 drive_vsm_b3 at the TOP of its two-bit range AND limp_res_valid set, in one frame — 434 frames archive-wide. Narrow the [0, 3] bound to [0, 1] or move the flag off bit 3 and this is what goes red. 2026-08-09 14:37:31.381045, capture-20260809-080235-cd40b535.log",
    hex: "2B 28 06 0F 4B 00 00 00",
    expect: { drive_vsm_b3: 3, limp_mode_status: 1, limp_res_valid: 1, vehicle_status_flags: 0x0f },
  },
  {
    what: "drive_vsm_b3 at 3 with limp_res_valid CLEAR — the asymmetric companion to the frame above, so the two cannot be swapped. 2026-08-08 17:38:31.161191, capture-20260808-165920-ad7271eb.log",
    hex: "2B 28 06 07 4B 00 00 00",
    expect: { drive_vsm_b3: 3, limp_res_valid: 0, vehicle_status_flags: 0x07 },
  },
  {
    what: "substate 52 — PARK ASSIST, plus limp_res_valid. 2026-09-13 15:28:02.199143, evidence/captures/frames-0x101-capture-20260913-150718-04632ecc.txt",
    hex: "34 28 06 0C 4B 00 00 00",
    expect: { vehicle_substate_can: 52, vehicle_state_can: 40, drive_vsm: 6, limp_res_valid: 1, limp_pack_res: 75 },
  },
  {
    what: "substate 53, the state reachable only through 52. 2026-09-13 18:05:10.261299, evidence/captures/frames-0x101-capture-20260913-180503-2b9d0f5b.txt",
    hex: "35 28 06 04 50 00 00 00",
    expect: { vehicle_substate_can: 53, vehicle_state_can: 40, drive_vsm: 6, limp_pack_res: 80 },
  },
  {
    what: "the fall minute — state 40 / substate 43, the shape 0x101 held while the bike went over. 2026-09-13 18:21:30.001529, evidence/fall-window-18-21-30_18-22-30-CEST.log",
    hex: "2B 28 04 04 62 00 00 00",
    expect: { vehicle_substate_can: 43, vehicle_state_can: 40, drive_vsm: 4, limp_pack_res: 98 },
  },
  {
    synthetic: true,
    what: "⚠️ SYNTHETIC — a frame the bus has never produced, and the only thing that can pin the two 16-bit fields. `limp_module_word` is 0 in all 15 006 844 archive frames and all 1 184 096 September ones, and `limp_pack_res`'s high byte is 0 in every one of them, so NO real frame distinguishes bytes 4-5 from 6-7, or little-endian from big. Distinct non-zero values in all four bytes do. ⚠️ It proves the decoder self-consistent and nothing whatever about the bike: b3 = 0xFF asserts every byte-3 field at once, which no frame on record carries",
    hex: "2B 28 06 FF 34 12 78 56",
    expect: {
      vehicle_substate_can: 43,
      vehicle_state_can: 40,
      drive_vsm: 6,
      drive_vsm_b3: 3,
      limp_mode_status: 1,
      limp_res_valid: 1,
      vehicle_status_flags: 0xff,
      limp_pack_res: 0x1234,
      limp_module_word: 0x5678,
    },
  },
];

/**
 * The widest values the archive has produced, so the bounds are falsifiable.
 *
 * The extremes only, the convention `ARCHIVE_PACK_RES` below already uses. 150 is the one that
 * carries this: it is a bit-7 substate, so any bound stopping at 127 drops it, and the full
 * 38-value vocabulary lives in docs/can-0x101.md rather than in a second copy here that has to
 * be kept in step with the archive.
 */
const ARCHIVE_STATES = [1, 100];
const ARCHIVE_SUBSTATES = [2, 150];
const ARCHIVE_PACK_RES = [75, 154];

const failures: string[] = [];
const defined = new Map(SIGNALS.map(signal => [signal.key, signal]));

console.log("\n──── scripts/check-vehicle-status.ts ───────────────────────────────────────");
console.log("     0x101 VCU_VEHICLE_STS, replayed from real frames");

// 1. The frames decode as recorded.
for (const testCase of CASES) {
  const decoded = decodeFrame(VEHICLE_STATUS_CAN_ID, parseFrame(testCase.hex));
  const got = new Map(decoded.map(value => [value.key, value.value]));
  for (const [key, want] of Object.entries(testCase.expect)) {
    const actual = got.get(key);
    if (actual !== want) {
      failures.push(`${testCase.hex} — ${key} decoded as ${actual ?? "(absent)"}, expected ${want}. ${testCase.what}`);
    }
    // …and every one of those values must survive the dashboard's gate. A value the decoder is
    // pinned to produce and the gate rejects would render as a dead sensor, and nothing else
    // here would notice — scripts/check-can-decoders.ts's own replay loop does the same.
    // ⚠️ The synthetic frame is exempt: it carries values the bus has never produced, so a
    // bound rejecting one says nothing about the bike.
    const signal = defined.get(key);
    if (!testCase.synthetic && signal && !isPlausible(key, want, signal.unit, signal.group)) {
      failures.push(
        `public/lib/bounds.js rejects ${key} = ${want} from a captured frame (${testCase.hex}) — the tile would show a dead sensor for a reading the bike really produces`
      );
    }
  }
}
// The prose marker and the field must agree. ⚠️ This is what makes two sources of truth safe:
// `what` is written for a person and `synthetic` is what the success line counts, and the one
// failure that matters — a hand-written frame counted as evidence off the bike — is exactly a
// disagreement between them. Asserted rather than chosen, because the marker in the prose is
// what a reader of the case sees and the field is what the number comes from.
for (const testCase of CASES) {
  const saysSynthetic = testCase.what.includes("SYNTHETIC");
  if (saysSynthetic !== (testCase.synthetic === true)) {
    failures.push(
      `${testCase.hex} — the case ${saysSynthetic ? "is marked ⚠️ SYNTHETIC in its prose but has no `synthetic: true`" : "carries `synthetic: true` but its prose does not say ⚠️ SYNTHETIC"}, so the success line would ${saysSynthetic ? "count a hand-written frame as captured" : "understate the captured frames"}`
    );
  }
}

const syntheticCases = CASES.filter(testCase => testCase.synthetic).length;
console.log(`  ${CASES.length - syntheticCases} captured frames replayed, plus ${syntheticCases} synthetic`);

// 2. A short frame yields nothing rather than throwing. This runs inside the CAN RX
//    handler, where a throw takes the bus reader down with it.
for (let length = 0; length < 8; length++) {
  const decoded = decodeFrame(VEHICLE_STATUS_CAN_ID, parseFrame(PARKED_FRAME).subarray(0, length));
  if (decoded.length > 0) {
    failures.push(
      `a ${length}-byte 0x101 frame produced ${decoded.length} values; a short frame must decode to nothing`
    );
  }
}

// 3. 🚨 The keys must not collide with the BLE transport's. src/ble/protocol.ts writes
//    `vehicle_state` and `vehicle_substate` off the Connectivity Hub; one key with two
//    writers flaps between them and interleaves in the ride log. This is the assertion that
//    stops a future tidy-up merging the two back together.
const parkedKeys = decodeFrame(VEHICLE_STATUS_CAN_ID, parseFrame(PARKED_FRAME)).map(value => value.key);
for (const [canKey, bleKey] of [
  ["vehicle_state_can", "vehicle_state"],
  ["vehicle_substate_can", "vehicle_substate"],
]) {
  if (!defined.has(bleKey)) {
    failures.push(
      `${bleKey} is gone from the registry — if the BLE key was removed, the _can suffix has lost its reason`
    );
  }
  if (parkedKeys.includes(bleKey)) {
    failures.push(`the 0x101 decoder emits ${bleKey}, which the BLE path already writes — use ${canKey}`);
  }
}

// 4. Every value the archive has produced survives the dashboard's gate. The bound is on
//    the FIELD rather than on the values seen, so this is what makes it falsifiable.
for (const [key, values] of [
  ["vehicle_state_can", ARCHIVE_STATES],
  ["vehicle_substate_can", ARCHIVE_SUBSTATES],
  ["limp_pack_res", ARCHIVE_PACK_RES],
  ["drive_vsm_b3", [0, 3]],
] as [string, number[]][]) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`${key} is decoded but not defined in src/can/registry.ts`);
    continue;
  }
  for (const value of values) {
    if (!isPlausible(key, value, signal.unit, signal.group)) {
      failures.push(
        `public/lib/bounds.js rejects ${key} = ${value}, which the bike really produces — it would render as a dead sensor`
      );
    }
  }
}
console.log("  the widest archive state, substate and pack resistance pass the bounds");

// 5. The 0/1 flags among the keys above must be gated to exactly [0, 1], not merely gated.
//    ⚠️ Only that half lives here. "Is it gated at all" is scripts/check-all-view-tiles.ts §5's
//    job — it walks EVERY registry signal and fails for any with null bounds that is not on its
//    known-ungated list, so a deleted BY_KEY line goes red there whether or not anyone remembers
//    to name the key in this file. Keeping a second copy would be the duplication this file's
//    header says it does not keep. `moving` is here rather than in check-button-decode.ts
//    because it is the key whose three ungated months prompted the ratchet.
const MUST_GATE_TO_FLAG = ["moving", "limp_mode_status", "limp_res_valid"];
for (const key of MUST_GATE_TO_FLAG) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`${key} is decoded but not defined in src/can/registry.ts`);
    continue;
  }
  const bounds = boundsFor(key, signal.unit, signal.group);
  if (!bounds || bounds[0] !== 0 || bounds[1] !== 1) {
    failures.push(
      `public/lib/bounds.js gates the 0/1 flag ${key} (group "${signal.group}", unit "${signal.unit}") to ${JSON.stringify(bounds)} rather than [0, 1]`
    );
  }
}

console.log("");
if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ ${CASES.length - syntheticCases} captured 0x101 frames decode as recorded (plus ${syntheticCases} synthetic, which pins only that the decoder is self-consistent), Energica's double-assigned V_DRIVE_VSM stays two ` +
    `fields, 0x101 is filtered in, short frames decode to nothing, the CAN keys do not collide with the BLE ` +
    `transport's, the widest archive state and substate pass the dashboard's gate, and the three 0/1 flags are gated to exactly [0, 1]`
);

/**
 * A fixture's bytes. ⚠️ `parseHexBytes` rather than a `Number.parseInt` map, which yields NaN on
 * a typo and `Buffer.from` then silently stores 0 — the fixture would assert against a frame
 * nobody captured. This one throws, naming the string. Same helper, same reason, as
 * scripts/check-attitude.ts.
 */
function parseFrame(hex: string): Buffer {
  return Buffer.from(parseHexBytes(hex));
}
