import { STREAM_IDS, decodeFrame } from "../src/can/decode.ts";
import { SIGNALS } from "../src/can/registry.ts";
// The dashboard's own plausibility gate, imported rather than reimplemented — see the
// boolean-deadband check below for why asking it beats keeping a copy of its rules.
import { boundsFor } from "../public/lib/bounds.js";
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
// ## Why the RX-filter check is here at all
//
// STREAM_IDS sets the kernel's CAN_RAW filters (src/index.ts). An ID missing from it never
// reaches decodeFrame, so the decoder is dead and NOTHING SAYS SO: no error, no warning, no
// failing test — the signal is simply absent, which is indistinguishable from a bike that
// never sent it. That has already cost real time on this project once, on 0x400.
//
// So the check runs the other way round, from the decoders to the filter: probe decodeFrame
// across the whole 11-bit ID space and fail if any ID that answers is missing from STREAM_IDS.
// Adding a decoder and forgetting the filter is then a red build instead of a silent nothing.
// It is deliberately one-directional — an ID in STREAM_IDS with no decoder is fine and there
// are several (0x410's non-GPS sub-frames, frames only present while charging), so the check
// never complains about those.
//
// ## And the other two
//
// Every emitted key must have a registry entry, or it logs into the catch-all "misc" group
// with a blank unit, which switches off the dashboard's plausibility gate for it (see
// public/lib/bounds.js — a blank unit in a non-boolean group is unbounded).
//
// No signal bounds.js gates to 0/1 may carry a deadband of 1 or more. `Math.abs(1 - 0) > 1` is
// false, so such a signal logs its first sample after boot and then never logs again — a trap
// that looks exactly like a flag which never changed. Which signals those are is asked of
// bounds.js directly rather than restated here, so the two cannot disagree.

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
  [0x121, "the rider's DC charge-current limit, set on the bike's own screen"],
];
for (const [id, what] of REQUIRED_IN_FILTER) {
  if (!streamIds.has(id)) {
    failures.push(`0x${id.toString(16).toUpperCase()} (${what}) is missing from STREAM_IDS`);
  }
}

// ---------------------------------------------------------------------------------------
// 2. Registry coverage and the boolean-deadband trap.
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
const undeclared = [...emitted].filter(key => !defined.has(key)).sort();
if (undeclared.length > 0) {
  failures.push(`decoders emit keys with no registry entry (they would log as group "misc"): ${undeclared.join(", ")}`);
}
console.log(`${emitted.size} distinct keys emitted, all declared in the registry`);

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
}

const REPLAY: ReplayCase[] = [
  {
    id: 0x0a0,
    frame: "CD 00 B3 00 00 00 00 00",
    why: "18:20:40.643 — the lap's fastest frame; 0x104 read 10.5 km/h at the same instant, and the ABS warning lamp is clear because the bike is moving",
    expect: {
      wheel_speed_front_kmh: 11.53125,
      wheel_speed_rear_kmh: 10.06875,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 0,
    },
  },
  {
    id: 0x0a0,
    frame: "00 00 00 00 04 11 00 00",
    why: "18:20:13.147 — the hardest brake application in the lap, 17 bar, with 0x102 b2 = 0x22 (front brake bit set) and the bike stopped, so the ABS lamp is on",
    expect: {
      wheel_speed_front_kmh: 0,
      wheel_speed_rear_kmh: 0,
      abs_warning_lamp: 1,
      front_brake_pressure_bar: 17,
    },
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
    why: "the wheel-count sentinel, 10 frames across the two 2026-08-04 road captures. Passed through as 3686.34 km/h ON PURPOSE — bounds.js gates the wheel speeds to [0, 300] so it shows as a fault, where 0x10B's 65000 has to be dropped in the decoder because 65 kWh/100 km would pass bounds. Pinning it here so neither behaviour gets 'made consistent' with the other",
    expect: {
      wheel_speed_front_kmh: 3686.34375,
      wheel_speed_rear_kmh: 3686.34375,
      abs_warning_lamp: 0,
      front_brake_pressure_bar: 0,
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
  const label = `0x${testCase.id.toString(16).toUpperCase().padStart(3, "0")} ${testCase.frame}`;
  for (const [key, expected] of Object.entries(testCase.expect)) {
    const actual = decoded.get(key);
    if (actual === undefined) {
      failures.push(`${label}: expected ${key} = ${expected}, got nothing`);
      continue;
    }
    if (Math.abs(actual - expected) > 1e-9) {
      failures.push(`${label}: expected ${key} = ${expected}, got ${actual}`);
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
