// The dash's own charge-current frames, captured off the bus on 2026-09-07. Data only —
// nothing here talks to a bus.
//
// ✅ THESE ARE REAL, byte for byte, out of `capture-20260907-182807-f349228d.log` on the Pi
// (candump, 16:28:07-19:20:06 Z, stamps below are the Pi's local CEST = UTC+2). That is what
// separates this file from scripts/freeze-frame-fixtures.ts, whose header explains at length
// why a constructed fixture cannot prove what a captured one can.
//
// They exist because the DC half of the set-current command had never been captured: the
// 0x120 commit twin's DC layout was asserted from the AC one (proven 2026-09-03, opcode 0x1A,
// ceiling 0x0F) and never seen. It is now seen, twelve times, and it matches what
// buildChargeCurrentCommand already emitted. docs/can-0x121-charge-command.md.

/** One rider dial change: the pair the dash put on the bus, and how far apart. */
export interface CapturedChargePair {
  /** Pi-local wall clock (CEST) of the 0x120 frame, for tracing back into the capture. */
  atLocal: string;
  /** What the rider dialled, in whole amps — b2 of both frames. */
  amps: number;
  /** 0x120, the commit twin: opcode 0x18 | 0x80, b3/b4/tail zero. */
  commitHex: string;
  /** 0x121, the command: b3 = 1 limit-in-force, b4 = the DC ceiling. */
  commandHex: string;
  /** Measured 0x120 → 0x121 spacing. See CAPTURED_PAIR_GAP_MS_RANGE. */
  gapMs: number;
}

/** The DC ceiling every captured 0x121 command carried in b4 — `fast_dc_limit_max_a`. */
export const CAPTURED_DC_CEILING_A = 75;

/**
 * The measured spread of the dash's own 0x120 → 0x121 spacing, milliseconds.
 *
 * ⚠️ Codified so `CURRENT_FRAME_GAP_MS` in src/vcu/write-session.ts can be checked against a
 * measurement rather than against the "~5 ms" a comment once estimated. Mean 6.685 over the
 * twelve pairs; the bound is the observed min and max, not a tolerance anyone chose.
 */
export const CAPTURED_PAIR_GAP_MS_RANGE = { min: 4.217, max: 10.122 };

/**
 * Twelve rider dial changes, 2026-09-07 19:16:44-19:34:46 CEST, inside the second-to-last DC
 * fast charge. Each is the dash's own pair, in bus order.
 *
 * That these are the RIDER and not this Pi is settled twice over: each is preceded 0-2 s by
 * physical `btn_mode_left`/`btn_mode_right` presses whose net count matches the amp delta ÷ 5
 * (clamped at the 75 A ceiling), and each produced a `dc_charge_limit_selected_a` row in the
 * ride log to the millisecond — while the three frames this Pi transmitted the same hour
 * produced none at all, because `createRawChannel` does not set CAN_RAW_RECV_OWN_MSGS.
 */
export const CAPTURED_DC_PAIRS: CapturedChargePair[] = [
  {
    atLocal: "19:16:44.138",
    amps: 35,
    commitHex: "98 FF 23 00 00 00 00 00",
    commandHex: "18 FF 23 01 4B 00 00 00",
    gapMs: 8.585,
  },
  {
    atLocal: "19:16:45.874",
    amps: 40,
    commitHex: "98 FF 28 00 00 00 00 00",
    commandHex: "18 FF 28 01 4B 00 00 00",
    gapMs: 10.122,
  },
  {
    atLocal: "19:16:53.820",
    amps: 45,
    commitHex: "98 FF 2D 00 00 00 00 00",
    commandHex: "18 FF 2D 01 4B 00 00 00",
    gapMs: 7.42,
  },
  {
    atLocal: "19:16:55.896",
    amps: 50,
    commitHex: "98 FF 32 00 00 00 00 00",
    commandHex: "18 FF 32 01 4B 00 00 00",
    gapMs: 5.898,
  },
  {
    atLocal: "19:28:16.362",
    amps: 65,
    commitHex: "98 FF 41 00 00 00 00 00",
    commandHex: "18 FF 41 01 4B 00 00 00",
    gapMs: 4.753,
  },
  {
    atLocal: "19:28:18.643",
    amps: 70,
    commitHex: "98 FF 46 00 00 00 00 00",
    commandHex: "18 FF 46 01 4B 00 00 00",
    gapMs: 8.404,
  },
  {
    atLocal: "19:28:21.350",
    amps: 75,
    commitHex: "98 FF 4B 00 00 00 00 00",
    commandHex: "18 FF 4B 01 4B 00 00 00",
    gapMs: 6.846,
  },
  {
    atLocal: "19:28:50.329",
    amps: 50,
    commitHex: "98 FF 32 00 00 00 00 00",
    commandHex: "18 FF 32 01 4B 00 00 00",
    gapMs: 4.515,
  },
  {
    atLocal: "19:31:18.100",
    amps: 55,
    commitHex: "98 FF 37 00 00 00 00 00",
    commandHex: "18 FF 37 01 4B 00 00 00",
    gapMs: 4.412,
  },
  {
    atLocal: "19:31:52.623",
    amps: 75,
    commitHex: "98 FF 4B 00 00 00 00 00",
    commandHex: "18 FF 4B 01 4B 00 00 00",
    gapMs: 4.217,
  },
  {
    atLocal: "19:34:40.987",
    amps: 70,
    commitHex: "98 FF 46 00 00 00 00 00",
    commandHex: "18 FF 46 01 4B 00 00 00",
    gapMs: 6.57,
  },
  {
    atLocal: "19:34:46.291",
    amps: 75,
    commitHex: "98 FF 4B 00 00 00 00 00",
    commandHex: "18 FF 4B 01 4B 00 00 00",
    gapMs: 8.482,
  },
];

/**
 * The three frames THIS PI transmitted during the same charge, from the pre-twin build the
 * bike was running (`93e071a`, pulled 2026-09-03 20:29 CEST; the twin fix `676d95f` landed
 * 22:34 the same day). Each is the 0x121 command ALONE — the half already proven not to
 * commit — and none of them moved the delivered current.
 *
 * ⚠️ Kept as a NEGATIVE fixture: the check asserts the builder no longer produces this shape.
 * A build that emits one frame instead of two is the regression that cost 2026-09-07.
 */
export const CAPTURED_PI_SINGLE_FRAMES = [
  { atLocal: "19:08:25.529", amps: 47, commandHex: "18 FF 2F 01 4B 00 00 00" },
  { atLocal: "19:09:26.603", amps: 75, commandHex: "18 FF 4B 01 4B 00 00 00" },
  { atLocal: "19:14:48.916", amps: 40, commandHex: "18 FF 28 01 4B 00 00 00" },
];

/**
 * Frames captured on 0x120/0x121 in the same session that are NOT current-limit commands.
 * The decode gate in src/can/charge-setpoint.ts must emit nothing for any of them — the
 * header calls that gate load-bearing, and this is what exercises it against real neighbours
 * rather than against invented ones.
 *
 * The stop pair is the rider ending the charge at 19:35:53 (`0x96`/`0x16`, b3 = 0). The
 * 0x9B/0x1B pair at 19:37:46 is the query opcode the setpoint decoder's header describes as
 * answering in b3 — here b3 = 0x1F, b2 = 0xAA = 170, well past any plausible amp figure.
 */
export const CAPTURED_NON_COMMAND_FRAMES = [
  { atLocal: "19:35:53.367", id: 0x120, hex: "96 FF 01 00 00 00 00 00", what: "the rider's Mode stop, commit twin" },
  { atLocal: "19:35:53.370", id: 0x121, hex: "16 FF 01 00 00 00 00 00", what: "the rider's Mode stop, command half" },
  { atLocal: "19:37:46.150", id: 0x120, hex: "9B FF AA 00 00 00 00 00", what: "opcode 0x1B query, commit twin" },
  { atLocal: "19:37:46.153", id: 0x121, hex: "1B FF AA 1F 00 00 00 00", what: "opcode 0x1B query, b2 = 170" },
];

/** Splits a fixture's `"18 FF 2F …"` into the bytes a decoder takes. */
export function fixtureBytes(hex: string): Buffer {
  return Buffer.from(hex.split(/\s+/).map(byte => Number.parseInt(byte, 16)));
}

/** Renders 8 bytes back to the fixture's own spelling, so a mismatch prints legibly. */
export function fixtureHex(data: Uint8Array): string {
  return [...data].map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
