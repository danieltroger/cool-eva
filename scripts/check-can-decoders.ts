import { STREAM_IDS, decodeFrame } from "../src/can/decode.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { CHARGE_MANAGER_CAN_IDS } from "../src/can/charge-manager.ts";
// The dashboard's own plausibility gate, imported rather than reimplemented — see the
// boolean-deadband check below for why asking it beats keeping a copy of its rules.
import { boundsFor, isPlausible } from "../public/lib/bounds.js";
import { resetAttitudeDecoder } from "../src/can/attitude.ts";
import { resetGpsCanDecoder } from "../src/can/gps.ts";
import type { DecodedValue } from "../src/can/frame.ts";

// Replays real frames through the real broadcast decoders, on a laptop, with no bike — and
// then checks three structural things about the decoder set as a whole that no amount of
// replaying can catch.
//
//   node --experimental-strip-types scripts/check-can-decoders.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// The three structural checks, and why each exists: docs/diagnostics-and-checks.md §11.4.
//   1. every ID that decodes must be in STREAM_IDS — an ID missing from the kernel RX
//      filter never reaches decodeFrame, and NOTHING SAYS SO. One-directional by design.
//   2. every emitted key must have a registry entry, or it lands in "misc" with a blank
//      unit, where the dashboard's plausibility gate cannot reach it.
//   3. no signal bounds.js gates to 0/1 may carry a deadband ≥ 1: `Math.abs(1 - 0) > 1`
//      is false, so it logs once after boot and never again. Which signals those are is
//      asked of bounds.js directly, so the two cannot disagree.
//
// ⚠️ WHAT §2 DOES NOT COVER, STATED RATHER THAN LEFT IMPLICIT — it is a check whose
// silence has already been mistaken for coverage once:
//   • An id NOT in `REQUIRED_IN_FILTER` is invisible to all three guards at once. It
//     answers no probe so it never enters `answeringIds`, the STREAM_IDS check never
//     fires for a silent id, and the section-4 assertion only walks that list. A gated
//     decoder wired into STREAM_IDS but not into that list is exactly as unprotected as
//     0x625 was. What closes it is more modules exporting their own id list the way
//     `CHARGE_MANAGER_CAN_IDS` does, and less prose here.
//   • A NEW KEY added to an already-gated decoder whose existing replay cases do not
//     happen to produce it is still invisible. Closing that properly means a full
//     expected key set per gated id, which is more machinery than this file has earned.
//     Until then, a key added to 0x610, 0x615, 0x620, 0x625 or 0x121 needs a replay case
//     that emits it, and that is a rule a person has to follow.

const failures: string[] = [];

// ---------------------------------------------------------------------------------------
// 1. Every ID that decodes must be in STREAM_IDS, and no decoder may throw.
// ---------------------------------------------------------------------------------------

// Four payloads, at every length a CAN frame can have. All-zero and all-ones are the two
// shapes a dead or disconnected sender produces; 0x1A 0x00 is the Connectivity Hub's GPS
// sub-frame header, which is the only way to make 0x410 answer; the alternating pattern
// catches a decoder keyed on a specific byte. Short frames matter as much as full ones: a
// decoder that indexes past the end of a truncated frame must return nothing, not throw —
// this runs inside the CAN RX handler, and a throw there takes the bus reader down.
const PROBE_PAYLOADS = [
  Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]),
  Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  Uint8Array.from([0x1a, 0x00, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]),
  Uint8Array.from([0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa]),
];

const streamIds = new Set(STREAM_IDS);
const answeringIds = new Set<number>();
let probes = 0;

for (let id = 0; id <= 0x7ff; id++) {
  for (const payload of PROBE_PAYLOADS) {
    for (let length = 0; length <= payload.length; length++) {
      probes += 1;
      let decoded: DecodedValue[];
      try {
        decoded = decodeFrame(id, Buffer.from(payload.subarray(0, length)));
      } catch (err) {
        failures.push(
          `decodeFrame(0x${id.toString(16)}, ${length} bytes of ${hex(payload)}) threw: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      if (decoded.length > 0) {
        answeringIds.add(id);
      }
      for (const { key, value } of decoded) {
        if (!Number.isFinite(value)) {
          failures.push(`decodeFrame(0x${id.toString(16)}, ${length} bytes) produced a non-finite ${key}`);
        }
      }
    }
  }
}

const unfiltered = [...answeringIds].filter(id => !streamIds.has(id)).sort((a, b) => a - b);
console.log(`probed ${probes} frames across the 11-bit id space; ${answeringIds.size} ids decode to something`);
if (unfiltered.length > 0) {
  failures.push(
    `these ids have a decoder but are NOT in STREAM_IDS, so the kernel filter drops them: ${unfiltered.map(id => `0x${id.toString(16).toUpperCase().padStart(3, "0")}`).join(", ")}`
  );
}

// Named explicitly as well as probed. The probe can only see an id whose decoder answers one
// of the payloads above, so a future decoder that needs a particular byte pattern would slip
// through it; the ids below (most added on 2026-08-16, 0x121 on 2026-08-19) are each checked
// by name so that removing one from the filter fails here even if its decoder goes quiet.
const REQUIRED_IN_FILTER: [number, string][] = [
  [0x0a0, "ABS wheel speeds / brake pressure"],
  [0x02c, "drive torque command and feedback"],
  [0x100, "VCU error/status flags, incl. the charge manager's error summary bit"],
  [0x10b, "VCU consumption"],
  [0x125, "redundant road speed"],
  [0x127, "dual throttle position sensor"],
  [0x501, "PSU monitor"],
  // 0x121 cannot be caught by the probe above at all: its decoder answers only for a DLC-8
  // frame with opcode 0x18, b1 = 0xFF, b3 = 1, a zero tail and 1 ≤ b2 ≤ b4, and none of the
  // four probe payloads is that shape. It is exactly the "future decoder that needs a
  // particular byte pattern" this list exists for — without this line, dropping it from the
  // filter would go unnoticed.
  //
  // ⚠️ As of 2026-08-20 that is no longer the exceptional case: 0x610, 0x615 and 0x625 all gate
  // on their own frame invariants too, so four of the ids in this list are now invisible to the
  // probe and this is the ONLY thing checking their filter entry. Anything added below that
  // gates on a byte pattern must be named here; the probe will not do it for you.
  [0x121, "the rider's DC charge-current limit, set on the bike's own screen"],
  // The charge manager, 2026-08-19. Four of these five matter more than most: they are silent
  // on a parked bike, so dropping one from the filter cannot be noticed until the next charge —
  // and then looks exactly like an ECU that did not wake up. (0x625 is the exception; it
  // broadcasts whenever the bike is awake, which is the only reason it was ever noticed.)
  [0x605, "charge manager → BMS: charge type and leak-detect inhibit"],
  [0x610, "charge manager state machine"],
  [0x615, "charge manager telemetry: voltage, DC current, SOC"],
  [0x620, "charge manager AC/DC current ceilings"],
  [0x625, "charge manager configured max DC current and charge-active flags"],
];
for (const [id, what] of REQUIRED_IN_FILTER) {
  if (!streamIds.has(id)) {
    failures.push(`0x${id.toString(16).toUpperCase()} (${what}) is missing from STREAM_IDS`);
  }
}

// The list above is hand-maintained, which is the wrong property for ids the probe can no longer
// see. This half of it does not have to be: `CHARGE_MANAGER_CAN_IDS` is exported, so a sixth
// charge-manager frame cannot arrive with a byte-gated decoder and no filter check.
const namedInFilter = new Set(REQUIRED_IN_FILTER.map(([id]) => id));
for (const id of CHARGE_MANAGER_CAN_IDS) {
  if (!namedInFilter.has(id)) {
    failures.push(
      `0x${id.toString(16).toUpperCase()} is a charge-manager id but is not named in REQUIRED_IN_FILTER — the probe cannot see a byte-gated decoder, so nothing else would notice it leaving the filter`
    );
  }
}

// ---------------------------------------------------------------------------------------
// 2. Collecting the emitted keys, and the boolean-deadband trap.
//    The registry-coverage check itself is section 4, after the replay cases have contributed
//    their keys — see the top of this file for why it cannot run here.
// ---------------------------------------------------------------------------------------

const defined = new Map(SIGNALS.map(signal => [signal.key, signal]));
resetGpsCanDecoder();
resetAttitudeDecoder();

const emitted = new Set<string>();
for (const id of answeringIds) {
  for (const payload of PROBE_PAYLOADS) {
    for (const { key } of decodeFrame(id, Buffer.from(payload))) {
      emitted.add(key);
    }
  }
}
const probedKeyCount = emitted.size;
console.log(`${probedKeyCount} distinct keys emitted for the probe payloads`);

// Which signals are 1/0 flags is bounds.js's decision, not this file's — it depends on a group
// set (`BOOLEAN_GROUPS`) and a per-key table that both grow, and "buttons" joined that set on
// 2026-08-16 without this check noticing. So ask bounds.js instead of keeping a second copy of
// its rule: a signal it gates to exactly [0, 1] is a flag by definition, whatever route inside
// that file arrived at the answer. The two cannot drift, because there is only one of them.
//
// A deadband of 1 or more on such a signal is a trap in two directions. `Math.abs(1 - 0) > 1`
// is false, so a true 0/1 flag logs its first sample after boot and then never logs again —
// silently, forever, looking exactly like a flag that never changed. And on a field that is
// gated to 0/1 but can actually carry more (abs_warning_lamp is a two-bit field, which is why
// it is named at [0, 3] in bounds.js rather than left to the group rule) it would be worse than
// silent: |2 − 0| passes where |1 − 0| does not, so some transitions log and some vanish.
let booleanSignalCount = 0;
for (const signal of SIGNALS) {
  const range = boundsFor(signal.key, signal.unit, signal.group);
  if (!range || range[0] !== 0 || range[1] !== 1) {
    continue;
  }
  booleanSignalCount += 1;
  const deadband = signal.deadband ?? 0;
  if (deadband >= 1) {
    failures.push(
      `${signal.key} is gated to 0/1 by bounds.js (group "${signal.group}", unit "${signal.unit}") but carries deadband ${deadband} — |1 − 0| > ${deadband} is false, so it would log once after boot and then never again`
    );
  }
}
console.log(`${booleanSignalCount} signals bounds.js gates to 0/1, all checked for a swallowing deadband`);

// ---------------------------------------------------------------------------------------
// 3. Replay of real frames, copied byte for byte out of the 2026-08-02 garage lap
//    (~/Documents/cool-eva-archive/ride-2026-08-02.log, 545 882 frames). The capture itself
//    is gitignored — one bike's ride history — so the frames that pin each decode live here.
// ---------------------------------------------------------------------------------------

interface ReplayCase {
  id: number;
  frame: string;
  /** What the capture showed at that moment, and why this frame was chosen. */
  why: string;
  expect: Record<string, number>;
  /** Keys this frame must NOT produce. */
  absent?: string[];
  /**
   * Keys whose expected value bounds.js is SUPPOSED to reject — sentinels replayed on purpose,
   * like 0x0A0's 0xFFFF wheel counts. Everything else in `expect` is a value the decoder is
   * pinned to produce, so a bound that rejects one is a bug in bounds.js.
   *
   * Checked in BOTH directions: naming a key here suppresses the too-tight failure, and it also
   * asserts that bounds.js really does still reject it. Widen the bound past the sentinel and
   * this fails rather than going quiet. A key named here that `expect` does not contain fails too.
   */
  outsideBounds?: string[];
}

const REPLAY: ReplayCase[] = [
  {
    id: 0x0a0,
    frame: "CD 00 B3 00 00 00 00 00",
    why: "18:20:40.643 — the lap's fastest frame; 0x104 read 10.5 km/h at the same instant, and the ABS warning lamp is clear because the bike is moving. Also the all-quiet case for the six flags, which is what 565 214 of the 565 376 captured frames of this ID look like",
    expect: {
      wheel_speed_front_kmh: 11.53125,
      wheel_speed_rear_kmh: 10.06875,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 0,
      abs_front_sensor_fault: 0,
      abs_rear_sensor_fault: 0,
      abs_event: 0,
      abs_front_pressure_validity: 0,
      abs_front_control_active: 0,
      abs_rear_control_active: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "00 00 00 00 04 11 00 00",
    why: "18:20:13.147 — the hardest brake application in the lap, 17 bar, with 0x102 b2 = 0x22 (front brake bit set) and the bike stopped, so the ABS lamp is on. A_F_PRESSURE_VALIDITY is 0 here, WITH a pressure being reported, which is the frame that stops anyone gating the pressure on that bit",
    expect: {
      wheel_speed_front_kmh: 0,
      wheel_speed_rear_kmh: 0,
      abs_warning_lamp: 1,
      front_brake_pressure_bar: 17,
      abs_front_pressure_validity: 0,
      abs_front_control_active: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "92 02 41 02 80 00 04 00",
    why: "2026-08-04 18:01:34.478 in capture-20260804-035631-c8fe853f.log — a real REAR-channel ABS intervention with no brake applied. A_EVENT (b4 0x80) and A_R_CTRL_ACTIVE (b6 0x04) together, which is the commonest shape: 135 of the archive's 162 event frames are exactly this pair. The rear wheel is 4.56 km/h below the front; b5 is 0, so no front brake was applied; and b4 is 0x80 not 0x84, so an intervention does not light the warning lamp. ⚠️ Do not read a cause into the missing brake — the throttle was 16.7 % open and the motor delivering +19.7 Nm at this instant, and src/can/abs.ts records why that does not make it traction control either",
    expect: {
      wheel_speed_front_kmh: 37.0125,
      wheel_speed_rear_kmh: 32.45625,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 0,
      abs_event: 1,
      abs_rear_control_active: 1,
      abs_front_control_active: 0,
      abs_front_sensor_fault: 0,
      abs_rear_sensor_fault: 0,
      abs_front_pressure_validity: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "6D 00 64 01 80 02 02 00",
    why: "2026-08-09 16:53:18.129 in capture-20260809-161310-edcdcf23.log — ✅ the FRONT channel alone, A_F_CTRL_ACTIVE (b6 0x02) with A_R_CTRL_ACTIVE clear. This bit was recorded as never observed until the whole archive was rescanned on 2026-08-20; it fires in 27 frames across three captures, 14 of them front-only like this one. A hard braking event: throttle shut, regen −26 Nm, front brake on at 2 bar, and the front wheel reading 6.13 km/h against the rear's 20.03 — a locked front wheel, caught in one 10 Hz sample and back to 20.48 in the next. ⚠️ A one-sample excursion is read as real HERE while src/can/abs.ts discounts the throttle-open ones for being one-sample; the asymmetry is physical and that file now states it — under brake both the drop and the recovery have forces that can produce them, under +19.7 Nm of drive torque the drop does not. ❓ The 2 bar is genuinely unexplained and is not being explained away: it is very little line pressure to lock a front wheel at 20 km/h, and the obvious rescue (that the pressure is post-modulation, the ABS having already dumped it) does NOT hold up pooled — over all 27 front-channel frames the pressure at the frame is below the preceding 0.6 s in 14, against a 37 % background. It falls that way in THIS burst, 5-6 bar down to 1-2 across the six active frames, but one burst is not the effect. This case is why the b6 bit1 position no longer rests on the vendor's word alone",
    expect: {
      wheel_speed_front_kmh: 6.13125,
      wheel_speed_rear_kmh: 20.025,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 2,
      abs_event: 1,
      abs_front_control_active: 1,
      abs_rear_control_active: 0,
      abs_front_pressure_validity: 0,
      abs_front_sensor_fault: 0,
      abs_rear_sensor_fault: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "76 04 5D 03 80 08 06 00",
    why: "2026-08-09 18:55:56.849 in capture-20260809-181842-5f095c14.log — BOTH channels at once (b6 = 0x06), and the largest wheel divergence in the entire archive: rear 48.43 km/h against front 64.24, i.e. the rear 15.81 km/h down. The clearest real ABS event on record for this bike — entered at 77 km/h with the throttle shut and regen at −41.7 Nm, rear locking. ⚠️ The pressure figure is the one number here that is NOT the whole story: b5 = 0x08 is 8 bar AT THIS FRAME, mid-release, and the stop peaks at 21 bar a second later — every other value quoted is the instantaneous one. It pins that bits 1 and 2 of b6 are read independently rather than as one field, which no frame setting only one of them can do",
    expect: {
      wheel_speed_front_kmh: 64.2375,
      wheel_speed_rear_kmh: 48.43125,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 8,
      abs_event: 1,
      abs_front_control_active: 1,
      abs_rear_control_active: 1,
      abs_front_pressure_validity: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "00 00 00 00 BC 05 07 00",
    why: "⚠️ SYNTHETIC — every flag at once, which the bus has never produced. Three of the six (both *SENS_FAIL and A_F_PRESSURE_VALIDITY) are 0 in all 565 376 captured frames, so nothing off the bike can pin their positions; this at least pins that they do not collide. b4 = 0xBC is A_WARN_LAMP at its full two-bit range of 3 alongside all three of its flags, so a lamp read that leaked into 0x10/0x20/0x80 — or a flag read that leaked into the lamp — fails here. It also pins that the flags come out as 1 rather than as the vendor's mask (16, 32, 128), which bounds.js would reject as a dead sensor",
    expect: {
      abs_warning_lamp: 3,
      abs_front_sensor_fault: 1,
      abs_rear_sensor_fault: 1,
      abs_event: 1,
      front_brake_pressure_bar: 5,
      abs_front_pressure_validity: 1,
      abs_front_control_active: 1,
      abs_rear_control_active: 1,
    },
  },
  {
    id: 0x0a0,
    frame: "00 00 00 00 10 00 02 00",
    why: "⚠️ SYNTHETIC — the asymmetric companion to the all-flags frame above, and it catches a failure that one structurally cannot: with every other synthetic case setting either all of these bits or none, A_FSENS_FAIL (b4 bit4) and A_RSENS_FAIL (bit5) could be SWAPPED and the suite would still pass. b4 = 0x10 sets exactly one of that pair. Its other original job — separating A_F_PRESSURE_VALIDITY (b6 bit0) from A_F_CTRL_ACTIVE (bit1) — is now done by a REAL frame, the 16:53:18 front-channel case above, so this one is kept for the *SENS_FAIL pair alone. It is deliberately not deleted: those two bits still have no measured frame anywhere in the archive",
    expect: {
      abs_front_sensor_fault: 1,
      abs_rear_sensor_fault: 0,
      abs_event: 0,
      abs_warning_lamp: 0,
      abs_front_pressure_validity: 0,
      abs_front_control_active: 1,
      abs_rear_control_active: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "CD 00 B3 00 00 00",
    why: "⚠️ SYNTHETIC — the lap's fastest frame truncated to 6 bytes. Every real frame of this ID is DLC 8, but b6 carries its own guard so that a short frame cannot silence the four signals logged since 2026-08-16 on account of the three added later. What must NOT happen is the b6 trio being decoded out of CAN padding: 'pressure invalid, neither channel active' reads as a healthy answer, not as a missing byte",
    expect: { wheel_speed_front_kmh: 11.53125, abs_warning_lamp: 0, abs_event: 0, front_brake_pressure_bar: 0 },
    absent: ["abs_front_pressure_validity", "abs_front_control_active", "abs_rear_control_active"],
  },
  {
    id: 0x0a0,
    frame: "6E 00 63 00 00 00 00 00",
    why: "18:20:25.255 — rolling with the lamp clear; front 110 counts against rear 99, which is the garage lap's front/rear spread. NOT a channel disagreement: it is steering geometry at walking pace, and on the road the same ratio is 0.995 (see src/can/abs.ts)",
    expect: { wheel_speed_front_kmh: 6.1875, wheel_speed_rear_kmh: 5.56875, abs_warning_lamp: 0 },
  },
  {
    id: 0x0a0,
    frame: "A1 06 B7 06 00 00 00 00",
    why: "2026-08-04 18:08:10.545 in capture-20260804-035631-c8fe853f.log — 97 km/h on the motorway, the only replay case where the wheel-speed HIGH bytes are non-zero, so it is what actually exercises the LE u16 read (the garage lap never passed 255 counts). GPS read 97 km/h with a fix and 9 satellites 0.19 s earlier and 0.37 s later, against 95.46/96.69 km/h here and 100.9 from 0x104 — the whole calibration story in one frame",
    expect: {
      wheel_speed_front_kmh: 95.45625,
      wheel_speed_rear_kmh: 96.69375,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "FF FF FF FF 00 00 00 00",
    why: "the wheel-count sentinel, 10 frames across the two 2026-08-04 road captures and 120 across the whole archive. Passed through as 3686.34 km/h ON PURPOSE — bounds.js gates the wheel speeds to [0, 300] so it shows as a fault, where 0x10B's 65000 has to be dropped in the decoder because 65 kWh/100 km would pass bounds. Pinning it here so neither behaviour gets 'made consistent' with the other",
    expect: {
      wheel_speed_front_kmh: 3686.34375,
      wheel_speed_rear_kmh: 3686.34375,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 0,
    },
    // The only case in the file where a replayed real reading is MEANT to fail bounds.js, which
    // is the whole point of it — so the intent is declared rather than left to the `why` line.
    outsideBounds: ["wheel_speed_front_kmh", "wheel_speed_rear_kmh"],
  },
  {
    id: 0x109,
    frame: "00 00 64 00 B0 04 02 06",
    why: "2026-08-04 03:56:31.471 — the bike parked and awake, and the first replay coverage this frame has ever had. Throttle 0, the inverter permitting 10.0 A out and 120.0 A of regen, and b6 = 0x02 with both event bits clear. The b6/b7 pair is the one this repo used to log as `current_other_a` = 153.8 A; under Energica's own layout it is ride map 1, regen map 3, no events — which is what a parked bike should say and 153.8 A is not",
    expect: {
      throttle_pct: 0,
      current_max_out_a: 10,
      current_max_regen_a: 120,
      eabs_event: 0,
      tc_event: 0,
    },
    absent: ["current_other_a"],
  },
  {
    id: 0x109,
    frame: "E8 03 A0 0F 39 04 82 06",
    why: "2026-08-08 11:40:25.459 in capture-20260807-213359-7c639361.log — ✅ `V_TC_EVENT` (b6 0x80) firing at FULL throttle. 100.0 % throttle with the inverter allowing 400.0 A: this is the frame that says the bit is traction control rather than a byte of some current. Across 438 228 frames sampled alongside the ABS broadcast it is set in 1326, median throttle 77.2 % and median torque +137.6 Nm against 15.6 % and +11.9 Nm when clear. ⚠️ It is NOT the same event as `abs_rear_control_active` — of the archive's 162 ABS interventions this bit is set at 4",
    expect: {
      throttle_pct: 100,
      current_max_out_a: 400,
      current_max_regen_a: 108.1,
      eabs_event: 0,
      tc_event: 1,
    },
  },
  {
    id: 0x109,
    frame: "57 01 A0 0F B0 04 42 06",
    why: "2026-08-04 03:58:34.541 — `V_eABS_EVENT` (b6 0x40) with `V_TC_EVENT` clear, the asymmetric partner to the frame above. Without it the two bits could be swapped and every other case would still pass, since no frame here sets both. Only 26 frames in the sampled set carry this bit, but 10 of them land on an ABS A_EVENT against a 0.004 % background — the association is real even though the sample is far too small to build on",
    expect: {
      throttle_pct: 34.3,
      current_max_out_a: 400,
      current_max_regen_a: 120,
      eabs_event: 1,
      tc_event: 0,
    },
  },
  {
    id: 0x127,
    frame: "DE 00 6D 01 01 33 00 00",
    why: "the widest split the two throttle channels ever reached, −143 counts — the far end of the tolerance P0120/P0121 police",
    expect: { throttle_sensor_a_raw: 222, throttle_sensor_b_raw: 365 },
  },
  {
    id: 0x127,
    frame: "B7 0F CE 0F 00 33 00 00",
    why: "the lap's widest-open throttle; both channels near the 12-bit ceiling and within 23 counts of each other",
    expect: { throttle_sensor_a_raw: 4023, throttle_sensor_b_raw: 4046 },
  },
  {
    id: 0x02c,
    frame: "E3 01 DF 01 00 00 00 00",
    why: "peak drive torque of the lap — 48.3 Nm asked for, 47.9 delivered. At the ×1 scale this would be 483 Nm, more than twice the motor's rated peak",
    expect: { drive_torque_cmd_nm: 48.3, drive_torque_feedback_nm: 47.9 },
  },
  {
    id: 0x02c,
    frame: "59 FF 59 FF 00 00 00 00",
    why: "deepest regen of the lap; both fields negative, which is what makes the s16 read (rather than u16) load-bearing",
    expect: { drive_torque_cmd_nm: -16.7, drive_torque_feedback_nm: -16.7 },
  },
  {
    id: 0x501,
    frame: "A4 31 3A 23 40 29 6E 0F",
    why: "18:20:42.273 — the lap's highest 12 V load, 10.56 A, with 0x102 b0 = 0xC0 so the high beam was on",
    expect: { psu_12v_mv: 12708, psu_12v_lowpower_mv: 9018, psu_12v_load_ma: 10560 },
  },
  {
    id: 0x501,
    frame: "A0 31 48 23 DF 13 82 0F",
    why: "the quietest 12 V load, 5.087 A, and the 12704 mV that was validated against the engineering menu's 12.78 V",
    expect: { psu_12v_mv: 12704, psu_12v_lowpower_mv: 9032, psu_12v_load_ma: 5087 },
  },
  {
    id: 0x10b,
    frame: "59 01 54 0B 70 05 E5 02",
    why: "345 × 2900 = 1 000 500 ≈ 10^6: 34.5 km/kWh IS 2.900 kWh/100 km, which is what pins both scalings with no bike involved",
    expect: {
      km_per_kwh_can: 34.5,
      kwh_per_100km_can: 2.9,
      km_per_kwh_100m_can: 139.2,
      kwh_per_100km_100m_can: 0.741,
    },
  },
  {
    id: 0x10b,
    frame: "E6 00 FE 10 70 05 E5 02",
    why: "the same reciprocal an order of magnitude down the range — 23.0 km/kWh against 4.350 kWh/100 km",
    expect: { km_per_kwh_can: 23, kwh_per_100km_can: 4.35 },
  },
  {
    id: 0x10b,
    frame: "00 00 E8 FD 70 05 E5 02",
    why: "the standstill pair, (0, 65000). Present in 3603 frames and the bike was at exactly 0 km/h in every one — no distance, so no consumption. Passing it through would draw 65 kWh/100 km, which bounds.js would accept",
    expect: { km_per_kwh_100m_can: 139.2, kwh_per_100km_100m_can: 0.741 },
    absent: ["km_per_kwh_can", "kwh_per_100km_can"],
  },
  {
    id: 0x10b,
    frame: "E8 FD 00 00 70 05 E5 02",
    why: "the other saturated pair, (65000, 0), seen 36 times and always while moving — coasting, so no energy per km. Dropped from the same end",
    expect: { km_per_kwh_100m_can: 139.2, kwh_per_100km_100m_can: 0.741 },
    absent: ["km_per_kwh_can", "kwh_per_100km_can"],
  },
  {
    id: 0x10b,
    frame: "59 01 57 0B 85 00 4C 1D",
    why: "the only other 100 m average the lap ever produced, 13.3 km/kWh against 7.500 kWh/100 km — which IS reciprocal, unlike the 139.2/0.741 pair it replaced",
    expect: { km_per_kwh_100m_can: 13.3, kwh_per_100km_100m_can: 7.5 },
  },
  {
    id: 0x10b,
    frame: "59 01 54 0B 00 00 E8 FD",
    why: "⚠️ SYNTHETIC — the 100 m pair saturated while the instantaneous pair is live. Never seen in the capture, but the two pairs are the same quantity over different windows, so the state must exist for both; unguarded and read signed, 65000 would arrive as −53.6 km/kWh, small enough to pass any sane bound and read as regen",
    expect: { km_per_kwh_can: 34.5, kwh_per_100km_can: 2.9 },
    absent: ["km_per_kwh_100m_can", "kwh_per_100km_100m_can"],
  },
  {
    id: 0x100,
    frame: "00 00 80 00 00 00 00 01",
    why: "0x100's commonest payload — 50 441 frames of the 2026-08-04 session and every frame of the garage lap. ERR_CheckModules set (it matches the six open-circuit body-module codes in the stored list) and V_PGood12V set",
    expect: {
      vcu_flags_low: 0x00800000,
      vcu_flags_high: 0x01000000,
      vcu_err_check_modules: 1,
      vcu_12v_power_good: 1,
      vcu_err_charge_manager: 0,
      vcu_check_modules_status: 0,
      vcu_warn_soc_misaligned: 0,
      vcu_err_leak_detect: 0,
      vcu_err_battery_ot: 0,
    },
  },
  {
    id: 0x100,
    frame: "00 00 00 00 08 00 00 01",
    why: "20:16:05.508 on 2026-08-04 — set for 2.5 s at exactly the second the DC session was unplugged, a time established from a completely different frame. The VCU re-running its module check as the session tears down, and the strongest single confirmation of these bit positions",
    expect: { vcu_flags_low: 0, vcu_flags_high: 0x01000008, vcu_check_modules_status: 1, vcu_err_check_modules: 0 },
  },
  {
    id: 0x100,
    frame: "00 00 80 00 00 00 10 01",
    why: "from 20:25:49 on 2026-08-04 onward — WARN_SocMisaligned appearing nine minutes after a DC session ended at 57 % SOC, which is when a coulomb-counted estimate gets flagged after a partial fast charge",
    expect: { vcu_flags_high: 0x01100000, vcu_warn_soc_misaligned: 1, vcu_err_check_modules: 1 },
  },
  {
    id: 0x100,
    frame: "00 00 80 00 00 00 00 03",
    why: "⚠️ SYNTHETIC — the only frame here that is not off the bus. ERR_ChargeCM_Out reads 0 in all 105 736 captured frames of 0x100, including a complete DC fast charge, so the set case has never been seen. This pins the bit position against the byte the 2026-08-09 12:38:35 fault window should show: byte 7 stepping 0x01 → 0x03",
    expect: { vcu_err_charge_manager: 1, vcu_12v_power_good: 1, vcu_flags_high: 0x03000000 },
  },
  // 0x121 — the rider's charge-current dial. Every frame below is off the bus. The three
  // positive cases are the ones that carry the argument: the current settled on the
  // commanded value exactly in each, which is what makes b2 the SETTING rather than one
  // more advertisement of the 75 A ceiling.
  {
    id: 0x121,
    frame: "18 FF 05 01 4B 00 00 00",
    why: "2026-08-09 17:56:05.346 — the owner's remembered '5 A to slow it down at high SOC', found in the data. 0x615 b2 went 1 → 5 A in 0.32 s and held exactly 5 for the next 835 samples. The ceiling beside it is unmoved at 75",
    expect: { dc_charge_limit_selected_a: 5 },
  },
  {
    id: 0x121,
    frame: "18 FF 3C 01 4B 00 00 00",
    why: "2026-08-04 20:09:09.038 — 60 A commanded while 66.2 A was flowing, and the current went to 60.8 A. The event five seconds later commanded 75 and got 66.2 A, which is the whole reason the ceiling and the setting had to be told apart",
    expect: { dc_charge_limit_selected_a: 60 },
  },
  {
    id: 0x121,
    frame: "18 FF 4B 01 4B 00 00 00",
    why: "the dial at its maximum, 2026-08-08 13:33:30 and four other times — setting EQUALS ceiling, the case that has to survive the b2 ≤ b4 guard rather than be rejected by it",
    expect: { dc_charge_limit_selected_a: 75 },
  },
  {
    id: 0x121,
    frame: "1A FF 09 01 0F 00 00 00",
    why: "2026-08-08 23:49:59.196 — the AC twin, opcode 0x1A with the 15 A AC ceiling. Deliberately silent: charge_limit_a already carries AC off 0x10A b7, which moved to 63 (÷7 = 9.00 A) 0.09 s after this frame and so confirms both decodes at once",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  {
    id: 0x121,
    frame: "1D FF 93 00 00 00 00 00",
    why: "the commonest opcode on this id — 204 of the 298 captured 0x121 frames, against 18 for the one we want — and the reason the opcode gate is load-bearing rather than tidy. b2 = 0x93 = 147 would read as 147 A if the frame were decoded on id alone",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  {
    id: 0x121,
    frame: "1B FF AA 5C 00 00 00 00",
    why: "2026-08-04 18:04:42 — a query whose answer is in b3, fired WHILE RIDING with nothing plugged in. b2 is the sentinel 0xAA and b3 = 92; b3 = 1 is what keeps it out",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  {
    id: 0x121,
    frame: "16 FF 01 00 00 00 00 00",
    why: "the charge-stop event, byte-identical on AC and DC. b2 = 1 looks exactly like a 1 A limit and is not one — b3 = 0 says no limit is in force",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  {
    id: 0x121,
    frame: "14 FF 71 00 91 11 1A 00",
    why: "2026-08-08 19:03:25 — the reply to this project's own RTC sync write on 0x120. b4 = 0x91 = 145 would be a nonsense ceiling, and b2 = 113 a nonsense setting; a decoder keyed on id alone would emit both",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  {
    id: 0x121,
    frame: "2C FF 4B 00 00 00 00 00",
    why: "the sharpest negative in the set, and it is real — from the 2026-06-14 capture, which predates every other file here and is in a different format. b2 is literally 0x4B = 75, so a decoder that read b2 as amps on id alone would report a 75 A limit that was never set. Only b3 = 0 and the opcode separate it from the genuine article three cases above",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  {
    id: 0x121,
    frame: "18 FF 4B 01",
    why: "⚠️ SYNTHETIC — a 4-byte truncation of the real 75 A frame. Never seen (all 596 captured frames are DLC 8), but b4 is the ceiling and a setting arriving with nothing to size it against is worse than no setting, so a short frame must drop rather than read past the end",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  {
    id: 0x121,
    frame: "18 FF 4B 01 4B 00 00 01",
    why: "⚠️ SYNTHETIC — the real 75 A frame with one bit set in the tail. b5-7 are zero in every captured frame of both ids except opcode 0x14, so a 0x18 that starts using them is a 0x18 that means something else; the decoder would rather go silent than report a number from a layout it does not recognise",
    expect: {},
    absent: ["dc_charge_limit_selected_a"],
  },
  // The charge manager, added 2026-08-19. Every frame below is copied byte for byte out of
  // ~/Documents/cool-eva-archive, and each pair (one AC, one DC) is taken at the SAME instant
  // in the same session as its siblings, so the five ids can be read together as one state.
  // The `why` lines carry the corroborating 0x200 reading from that instant — that is what
  // makes these regression tests rather than a copy of the decoder's own arithmetic.
  {
    id: 0x615,
    frame: "3A 01 3F 28 00 00 00 00",
    why: "2026-08-04 20:05:20, mid-plateau of the 2026-08-04 DC session. 0x200 read 300.5 V / 63.2 A / 40 % at that instant: b0 58 + 242.5 = 300.5 V EXACTLY, b2 = 63 A against 63.2, b3 = 40 % against 40",
    expect: { charge_manager_pack_v: 300.5, fast_dc_a: 63, charge_manager_soc: 40 },
  },
  {
    id: 0x615,
    frame: "2D 01 49 11 00 00 00 00",
    why: "2026-08-08 17:49:24 — the highest DC current in the whole corpus, 73 A, at a low 17 % SOC. 0x200 read 288.0 V / 73.0 A / 17 %. This is the case that would break if b2 were ever read as anything but plain amps",
    expect: { charge_manager_pack_v: 287.5, fast_dc_a: 73, charge_manager_soc: 17 },
  },
  {
    id: 0x615,
    frame: "5D 01 07 63 00 00 00 00",
    why: "2026-08-09 18:15:22 — the far end of a DC taper, 99 % SOC and only 7 A left. 0x200 read 335.5 V / 6.7 A / 99 %, so b0 93 + 242.5 = 335.5 V exactly at the top of the pack's range as well as the middle",
    expect: { charge_manager_pack_v: 335.5, fast_dc_a: 7, charge_manager_soc: 99 },
  },
  {
    id: 0x615,
    frame: "2C 01 00 1F 00 00 00 00",
    why: "2026-08-03 22:31:22, five hours into the 6.8 h overnight AC charge at 1 A. b2 = 0 while 1.0 A of AC charge current flows — the property that makes fast_dc_a DC-specific rather than a general charge current",
    expect: { charge_manager_pack_v: 286.5, fast_dc_a: 0, charge_manager_soc: 31 },
  },
  {
    id: 0x610,
    frame: "5E 00 00 00 F1 05 01 23",
    why: "the DC state, at the same instant as the 63 A frame above. b7 = 0x23 and b0 bit 1 set; b0 bit 0 (AC) clear",
    expect: { charge_manager_status: 0x5e, charge_manager_state: 0x23 },
  },
  {
    id: 0x610,
    frame: "19 00 00 00 F1 05 01 02",
    why: "the AC state, from the overnight session. b7 = 0x02 and b0 bit 0 set — b7 never once reads 0x23 on AC or 0x02 on DC across 44 444 frames",
    expect: { charge_manager_status: 0x19, charge_manager_state: 0x02 },
  },
  {
    id: 0x620,
    frame: "4B 00 00 16 00 00 00 00",
    why: "DC, same instant as the 63 A frame: the vehicle advertising its full 75 A while the station delivers 63. b1 (the AC ceiling) is 0, which is what it reads in 100 % of DC frames",
    expect: { fast_dc_limit_a: 75, ac_supply_limit_a: 0 },
  },
  {
    id: 0x620,
    frame: "2C 00 00 51 00 00 00 00",
    why: "DC late in a taper (2026-08-09 18:15:22) — the advertised ceiling has itself fallen to 44 A. It follows the station rather than commanding it, so this byte is not the rider's setting. This is also the frame that caught the b3 error: b3 = 0x51 = 81, outside the 9…64 the file claimed for DC until 2026-08-20, and 81 with 7 A flowing against 22 with 63 A flowing in the case above is the opposite sign to the r = +0.72 it claimed as well. Both are retracted in charge-manager.ts",
    expect: { fast_dc_limit_a: 44, ac_supply_limit_a: 0 },
  },
  {
    id: 0x620,
    frame: "00 0D 01 FF 00 00 00 00",
    why: "AC overnight: b1 = 13 A while 0x10A b7 = 0x07 asks for 1.0 A, so the ceiling is nowhere near the setpoint and cannot be a readback of it. b0 (the DC ceiling) is 0",
    expect: { fast_dc_limit_a: 0, ac_supply_limit_a: 13 },
  },
  {
    id: 0x620,
    frame: "00 08 01 FF 00 00 00 00",
    why: "2026-08-08 18:55:57 — the lowest AC ceiling in the corpus. 0x10A b7 = 0x34 asks for 7.43 A at that instant, just under the 8 here, which is the pair that shows b1 bounding the setpoint",
    expect: { fast_dc_limit_a: 0, ac_supply_limit_a: 8 },
  },
  {
    id: 0x625,
    frame: "6B 01 4B FF 12 00 00 00",
    why: "DC, same instant as the 63 A frame. b2 = 0x4B = 75 is MAX_DC_CHG_CURRENT read back from the VCU; b4 = 0x12 has bit 5 clear (DC flowing) and bit 2 clear (no AC)",
    expect: { fast_dc_limit_max_a: 75, dc_charging: 1, ac_charging: 0 },
  },
  {
    id: 0x625,
    frame: "6B 01 4B FF 2C 00 00 00",
    why: "AC overnight: b4 = 0x2C, bit 2 set and bit 5 set. Same b2 = 75 — it is static across DC, AC and parked alike, which is why it is a configuration constant and not a negotiated value",
    expect: { fast_dc_limit_max_a: 75, dc_charging: 0, ac_charging: 1 },
  },
  {
    id: 0x625,
    frame: "6B 01 4B FF 32 00 00 00",
    why: "2026-08-09 14:43:32 — the ABORTED DC attempt: 0x605 and 0x610 both say a DC session is established but not one amp ever flows, and b4 sits at the idle 0x32. The case that separates 'a session exists' from 'current is flowing'",
    expect: { fast_dc_limit_max_a: 75, dc_charging: 0, ac_charging: 0 },
  },
  {
    id: 0x625,
    frame: "00 00 00 00 00 00 00 00",
    why: "⚠️ SYNTHETIC, and the reason 0x625 checks its own invariants. b4's DC bit is read INVERTED, so an all-zero payload has bit 5 clear and would decode to dc_charging = 1 — a false charge claim that bounds.js cannot reject, because 1 is a legitimate value for a flag. b1 = 0x01 and b3 = 0xFF in 100.000 % of 1 571 617 real frames, so requiring them turns this shape back into no reading",
    expect: {},
    absent: ["fast_dc_limit_max_a", "dc_charging", "ac_charging"],
  },
  {
    id: 0x625,
    frame: "FF FF FF FF FF FF FF FF",
    why: "⚠️ SYNTHETIC — the mirror image, and the other shape a dead or disconnected sender produces. Here bit 2 is set, so without the invariant check it would decode to ac_charging = 1. b1 = 0xFF fails the gate",
    expect: {},
    absent: ["fast_dc_limit_max_a", "dc_charging", "ac_charging"],
  },
  {
    id: 0x615,
    frame: "00 01 00 1F 00 00 00 00",
    why: "⚠️ SYNTHETIC — b0 = 0 would decode to 242.5 V, which is inside this pack's real range and inside bounds.js's V band, so it would look like a measurement rather than a fault. b0 spans 28…94 over all 941 765 captured frames and is never 0, so this should be unreachable; the guard is what makes that a fact rather than a hope. The other two fields still decode",
    expect: { fast_dc_a: 0, charge_manager_soc: 31 },
    absent: ["charge_manager_pack_v"],
  },
  {
    id: 0x620,
    frame: "00 00 00 00 00 00 00 00",
    why: "⚠️ SYNTHETIC — the shape this frame's gate exists for, and the hardest dead sender in the group to spot. Ungated it decodes to fast_dc_limit_a = 0 and ac_supply_limit_a = 0, and BOTH are legitimate values that bounds.js must accept: every DC frame reads b1 = 0, every AC frame reads b0 = 0, and 31 529 real frames read both as 0 between sessions. So it reads as 'plugged in, both ceilings at zero' rather than as a sender that has stopped talking. b3 is what separates it — 0xFF or 9…82 across all 968 618 frames, never 0",
    expect: {},
    absent: ["fast_dc_limit_a", "ac_supply_limit_a"],
  },
  {
    id: 0x620,
    frame: "FF FF FF FF FF FF FF FF",
    why: "⚠️ SYNTHETIC — the other dead-sender shape, caught by b4-7 = 00 (100.000 % of 968 618 frames) rather than by b3, which is 0xFF here and legitimately so on every AC frame. Ungated it would decode to a 255 A DC ceiling and a 255 A AC supply, and the bounds added in this PR would reject both — this case is what makes the decoder refuse them a layer earlier",
    expect: {},
    absent: ["fast_dc_limit_a", "ac_supply_limit_a"],
  },
  {
    id: 0x615,
    frame: "FF FF FF FF FF FF FF FF",
    why: "⚠️ SYNTHETIC — the all-ones dead-sender shape, and the worst-exposed frame in this group, because two of its three keys are measurements rather than flags. Ungated it decodes to charge_manager_pack_v = 255 + 242.5 = 497.5 V and fast_dc_a = 255 A; bounds.js passed BOTH until the entries added alongside this case (its V band is [-50, 900] and the A fallback [-1000, 1000]), and only charge_manager_soc = 255 was ever caught, by the % band. 255 A on the only DC charge current on this bus is a number that reaches a chart's autoscale and then a conclusion. b1 = 0x01 with b4-7 = 00 in 100.000 % of 941 765 real frames is what turns it back into no reading",
    expect: {},
    absent: ["charge_manager_pack_v", "fast_dc_a", "charge_manager_soc"],
  },
  {
    id: 0x615,
    frame: "00 00 00 00 00 00 00 00",
    why: "⚠️ SYNTHETIC — the other dead-sender shape. The b0 = 0 guard alone would already drop the voltage, but not fast_dc_a = 0 and charge_manager_soc = 0, and those two are worse than a silly number: they read as a healthy 'plugged in, nothing flowing, empty pack'. b1 = 0x00 fails the invariant",
    expect: {},
    absent: ["charge_manager_pack_v", "fast_dc_a", "charge_manager_soc"],
  },
  {
    id: 0x610,
    frame: "00 00 00 00 00 00 00 00",
    why: "⚠️ SYNTHETIC — all-zero, and the frame with the least defence of the three: both its keys are logged raw and are bounded to [0, 255] in bounds.js ON PURPOSE, so that a state nobody has seen yet is not rejected. That means bounds.js cannot reject anything at all for them and this invariant is the only check there is. b4-6 = F1 05 01 in 100.000 % of 968 629 real frames, and 0x00 0x00 0x00 is not it",
    expect: {},
    absent: ["charge_manager_status", "charge_manager_state"],
  },
  {
    id: 0x610,
    frame: "FF FF FF FF FF FF FF FF",
    why: "⚠️ SYNTHETIC — all-ones, which ungated decodes to charge_manager_status = 255 and charge_manager_state = 255, both inside the deliberate [0, 255] band. Note what is NOT gated: b1-3, which read 07 55 03 through the aborted DC attempt of 2026-08-09 14:42 and are 00 everywhere else. Gating on them would have thrown away the most interesting DC data in the archive",
    expect: {},
    absent: ["charge_manager_status", "charge_manager_state"],
  },
  {
    id: 0x605,
    frame: "11 00 02 02 00 00 00 01",
    why: "DC, same instant as the 63 A frame: b2 = 2 (DC) and b7 = 1, the BMS's isolation monitor switched off for the duration — 1 on DC and 0 on AC in 100.000 % of 43 994 frames",
    expect: { charge_type: 2, bms_leak_detect_inhibit: 1 },
  },
  {
    id: 0x605,
    frame: "0F 00 01 01 00 00 00 00",
    why: "AC overnight: b2 = 1 (AC) and leak detection left running. b3 duplicates b2 in every frame of the corpus, which is why only b2 is emitted",
    expect: { charge_type: 1, bms_leak_detect_inhibit: 0 },
  },
  {
    id: 0x125,
    frame: "DE 04 75 03 E8 14 82 63",
    why: "the fastest 0x125 frame; the two channels are byte-identical in 19 823 of 22 480 frames but split during transients like this one, which is the divergence worth logging both for",
    expect: { speed_redundant_a_raw: 1246, speed_redundant_b_raw: 885 },
  },
];

for (const testCase of REPLAY) {
  const data = Buffer.from(testCase.frame.split(" ").map(byte => Number.parseInt(byte, 16)));
  const decoded = new Map(decodeFrame(testCase.id, data).map(value => [value.key, value.value]));
  // These are the only keys a byte-gated decoder ever produces here, so section 4 needs them —
  // and this is now also the only path that exercises those decoders at all, since they answer
  // none of the probe payloads. Section 1's non-finite check therefore no longer covers them, so
  // it is repeated here rather than left to a payload that never reaches them.
  for (const [key, value] of decoded) {
    emitted.add(key);
    if (!Number.isFinite(value)) {
      failures.push(`0x${testCase.id.toString(16).toUpperCase()} ${testCase.frame} produced a non-finite ${key}`);
    }
  }
  const label = `0x${testCase.id.toString(16).toUpperCase().padStart(3, "0")} ${testCase.frame}`;
  const declaredOutside = new Set(testCase.outsideBounds ?? []);
  for (const [key, expected] of Object.entries(testCase.expect)) {
    const actual = decoded.get(key);
    if (actual === undefined) {
      failures.push(`${label}: expected ${key} = ${expected}, got nothing`);
      continue;
    }
    if (Math.abs(actual - expected) > 1e-9) {
      failures.push(`${label}: expected ${key} = ${expected}, got ${actual}`);
    }
    // ⚠️ The one place that can catch a bound drawn TOO TIGHT. Every value in `expect` is one
    // this decoder is PINNED to produce, so a bounds.js that rejects one is a contradiction
    // either way — and it is not hypothetical: `fast_dc_limit_max_a` was once bounded at 80
    // because a write policy was read as a field range, and only this bike happening to hold 75
    // kept a real reading from being rejected. `psu_12v_mv` is the same mistake from the other end.
    //
    // `expected` is deliberately what is tested, not `actual`: the question is whether the gate
    // accepts the reading the bike is KNOWN to produce, and on a decode mismatch `actual` is by
    // definition not that. ⚠️ `outsideBounds` may only SUPPRESS the first failure, never stand in
    // for the second — an annotation that merely silences is indistinguishable from one that has
    // gone stale.
    //
    // The predicate is `isPlausible` rather than a comparison written here, so "showing as a
    // fault" stays decided in exactly one place; `boundsFor` is called only to name the band.
    const signal = defined.get(key);
    const range = signal ? boundsFor(signal.key, signal.unit, signal.group) : null;
    const accepted = signal ? isPlausible(signal.key, expected, signal.unit, signal.group) : true;
    if (range && !accepted && !declaredOutside.has(key)) {
      failures.push(
        `${label}: ${key} = ${expected} is a value this decoder is pinned to produce, but bounds.js gates it to [${range[0]}, ${range[1]}] — either the bound is too tight, or this case belongs in outsideBounds`
      );
    }
    if (accepted && declaredOutside.has(key)) {
      // Three different situations, and they send the reader to three different files. `range`
      // being null does NOT on its own mean bounds.js is unbounded for this key — it also happens
      // when the key has no registry entry and boundsFor was never asked.
      if (!signal) {
        failures.push(
          `${label}: ${key} is declared in outsideBounds but has no registry entry, so nothing here can say whether bounds.js would reject it — the missing line is in the registry, not in bounds.js`
        );
      } else if (range) {
        failures.push(
          `${label}: ${key} = ${expected} is declared in outsideBounds, but bounds.js now accepts it within [${range[0]}, ${range[1]}] — the sentinel has stopped showing as a fault, or the annotation is stale`
        );
      } else {
        failures.push(
          `${label}: ${key} is declared in outsideBounds, but bounds.js does not bound it at all — nothing can reject it, so "supposed to be rejected" is false`
        );
      }
    }
  }
  // A key named in outsideBounds that this case does not expect asserts nothing and hides the
  // fact — a rename or a deleted expectation would leave it behind looking like protection.
  for (const key of declaredOutside) {
    if (!(key in testCase.expect)) {
      failures.push(
        `${label}: outsideBounds names ${key}, which this case does not expect — a stale annotation asserts nothing`
      );
    }
  }
  for (const key of testCase.absent ?? []) {
    if (decoded.has(key)) {
      failures.push(`${label}: ${key} should not be emitted, got ${decoded.get(key)}`);
    }
  }
  console.log(`  ${label}  →  ${[...decoded].map(([key, value]) => `${key}=${value}`).join(" ")}`);
  console.log(`      ${testCase.why}`);
}

// The 0x10B reciprocal, checked as an invariant rather than sample by sample. This is the
// property that pins BOTH scalings without a bike, so it is worth failing on directly: the
// consolidated analysis on issue #21 states it in prose as 100000 / (b0-1), which is off by a
// factor of ten and matches none of the 448 unsaturated frames in the capture. 10^6 is what
// (×0.1 km/kWh) × (×0.001 kWh/100 km) = 100 forces, and it holds on all of them.
const RECIPROCAL_PAIRS: [number, number][] = [
  [345, 2900],
  [230, 4350],
  [690, 1450],
  [2529, 395],
  [3448, 290],
  [4023, 249],
];
for (const [kmPerKwhRaw, kwhPer100KmRaw] of RECIPROCAL_PAIRS) {
  // b0-1 is quantised to 0.1 km/kWh, so the reciprocal is a band, not a point.
  const lowest = (100 / ((kmPerKwhRaw + 0.5) * 0.1)) * 1000;
  const highest = (100 / ((kmPerKwhRaw - 0.5) * 0.1)) * 1000;
  if (kwhPer100KmRaw < Math.floor(lowest) - 1 || kwhPer100KmRaw > Math.ceil(highest) + 1) {
    failures.push(
      `0x10B reciprocal broken: ${kmPerKwhRaw} (${kmPerKwhRaw / 10} km/kWh) should pair with ${lowest.toFixed(0)}…${highest.toFixed(0)}, capture says ${kwhPer100KmRaw}`
    );
  }
}
console.log(`\n0x10B: ${RECIPROCAL_PAIRS.length} captured pairs all satisfy b0-1 × b2-3 ≈ 10^6`);

// ---------------------------------------------------------------------------------------
// 4. Registry coverage. Last on purpose: `emitted` is only complete once the replay cases
//    above have run, because a decoder that gates on a frame invariant answers none of the
//    probe payloads. See "And the other two" at the top of this file.
// ---------------------------------------------------------------------------------------

const undeclared = [...emitted].filter(key => !defined.has(key)).sort();
if (undeclared.length > 0) {
  failures.push(`decoders emit keys with no registry entry (they would log as group "misc"): ${undeclared.join(", ")}`);
}
// The convention the header describes, made into a check rather than left as a habit. An id that
// answers no probe payload contributes nothing to `emitted` by itself, so its keys reach this
// section only through the replay cases — and if it has none it is silently unprotected, exactly
// as 0x625 was between #77 and this change. Asserting it means the next byte-gated decoder cannot
// repeat that quietly.
const replayedIds = new Set(REPLAY.map(testCase => testCase.id));
for (const [id, what] of REQUIRED_IN_FILTER) {
  if (!answeringIds.has(id) && !replayedIds.has(id)) {
    failures.push(
      `0x${id.toString(16).toUpperCase()} (${what}) answers none of the probe payloads and has no replay case either, so none of its keys are checked for a registry entry`
    );
  }
}

// The claim is conditional on purpose. Printing "all declared" unconditionally would state the
// reassuring thing two lines above the FAILED: block that contradicts it — which is the same
// shape of one-directional silence described at the top of this file.
console.log(
  `${emitted.size} distinct keys emitted, ${undeclared.length === 0 ? "all declared in the registry" : `${undeclared.length} NOT declared in the registry`} — ${probedKeyCount} of them reachable from the probe payloads and ${emitted.size - probedKeyCount} only through the replay cases`
);

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `\n✓ ${REPLAY.length} captured frames decode as measured; every decoding id is in the RX filter; every emitted key is declared`
);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
