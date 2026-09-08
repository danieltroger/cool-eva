import { ExtendedIsoTpReassembler } from "../src/diagnostics/extended-iso-tp.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";

// The 2026-09-08 freeze-frame reads — the FIRST ones taken by this project rather
// than recorded off Energica's tool, four weeks after the stored codes were cleared
// on 2026-08-09. ./captured-freeze-frames.ts holds the same components read BEFORE
// that clear, and the pair of dates is what this file exists for: two readings of
// the same lifetime counters 967.6 km apart.
//
// ⚠️ TWO SHAPES IN ONE FILE, BECAUSE TWO PROVENANCES. Components 53, 60 and 54 are
// whole exchanges off the wire, timestamps included. Components 51 and 52 — the two
// this feature is about — are REASSEMBLED PAYLOADS ONLY, byte-exact from the
// script's own stdout, because their frames were never recorded: read-freeze-frame.ts
// bounces can0, which kills candump, and the capture unit's Restart=on-failure /
// RestartSec=5 opens a NEW file five seconds later. 51 and 52 fell in that hole.
// Issue #160. The shapes are kept apart rather than smoothed together so nobody
// reads a payload-level fixture as a shortcut somebody took.

/** One frame as candump wrote it. The verbatim line is the fixture; everything else is parsed from it. */
export interface CapturedCanFrame {
  /** `(timestamp) iface id [len] bytes` exactly as logged, local time. */
  readonly line: string;
  /** What it is, for a reader of the check output. Not parsed from anything. */
  readonly role: string;
}

/** A whole request/response exchange, in the order the frames appeared on the bus. */
export interface CapturedExchange {
  readonly component: number;
  readonly frames: readonly CapturedCanFrame[];
}

/**
 * A reply whose frames were lost, kept as the payload the script printed.
 *
 * `payloadHex` is what the ISO-TP reassembler WOULD have produced: PCI bytes gone,
 * header through trailing byte inclusive.
 */
export interface CapturedPayload {
  readonly component: number;
  readonly payloadHex: string;
}

/**
 * Components 51 and 52 on 2026-09-08, from `read-freeze-frame.ts --component 51|52`.
 *
 * Both succeeded on the first attempt, with `truncated: false` and the trailing byte
 * present. The odometer in 51 (18 440.5 km) is what dates them against the bike's own
 * broadcast: docs/lifetime-battery-statistics.md.
 */
export const LIFETIME_READ_PAYLOADS: readonly CapturedPayload[] = [
  {
    component: 51,
    payloadHex: "57 01 00 33 05 7C 63 63 64 10 82 04 39 0D 1B FF FE 10 8F 10 7B 00 02 D0 55 05",
  },
  {
    component: 52,
    payloadHex: "57 01 00 34 05 00 0A 0A C0 03 FA 03 C9 00 11 01 26 64 3A 05",
  },
];

/**
 * Component 53's complete exchange, from `capture-20260908-131849-db6cbfba.log`.
 *
 * ⚠️ THE TIMING FIXTURE. 51 and 52 are the same transport — same micro, same `0x17`,
 * same ids, same extended-addressed ISO-TP — so this is what the flow-control budget
 * is measured from. What it measures is what a DEDICATED SINGLE-TESTER SCRIPT
 * achieved (3.153 ms), not the micro's deadline: nothing here has ever missed the
 * window, so there is no failure to bound the tolerance with. The informative half is
 * the other direction — the micro then waited 26.868 ms before sending, so this
 * channel's whole timescale is tens of milliseconds.
 */
export const CAPTURED_EXCHANGE_53: CapturedExchange = {
  component: 53,
  frames: [
    { line: "(2026-09-08 13:18:50.640832)  can0  7C0  [8]  A8 02 10 81 00 00 00 00", role: "session request" },
    { line: "(2026-09-08 13:18:50.661659)  can0  7E0  [8]  F1 02 50 81 00 00 00 00", role: "session ack" },
    { line: "(2026-09-08 13:18:50.722034)  can0  7C0  [8]  A8 03 17 00 35 00 00 00", role: "0x17 request" },
    { line: "(2026-09-08 13:18:50.746669)  can0  7E0  [8]  F1 10 0A 57 01 00 35 45", role: "First Frame" },
    { line: "(2026-09-08 13:18:50.749822)  can0  7C0  [8]  A8 30 FF 00 00 00 00 00", role: "our flow control" },
    { line: "(2026-09-08 13:18:50.776690)  can0  7E0  [8]  F1 20 10 00 00 00 01 00", role: "Consecutive Frame" },
  ],
};

/**
 * Component 60 — `P1052 BATTERY STATISTICS INFO3`, the third of the trio #56 names.
 *
 * A Single Frame with no flow control at all, because its shortlist is empty in
 * Energica's own data (src/diagnostics/fault-infokeys.ts) and the bike agrees: header,
 * trailing byte, nothing between them. INFO3 has nothing to display, and that is a
 * decode result rather than a gap.
 */
export const CAPTURED_EXCHANGE_60: CapturedExchange = {
  component: 60,
  frames: [
    { line: "(2026-09-08 13:18:53.102951)  can0  7C0  [8]  A8 03 17 00 3C 00 00 00", role: "0x17 request" },
    { line: "(2026-09-08 13:18:53.126996)  can0  7E0  [8]  F1 06 57 01 00 3C 05 05", role: "Single Frame reply" },
  ],
};

/**
 * Component 54's two-byte reply, `57 00`: **no stored record for that component**.
 *
 * Not a refusal and not a third outcome — the micro answering that it has nothing on
 * file. A real one, where scripts/freeze-frame-fixtures.ts only had a constructed one.
 *
 * ⚠️ src/diagnostics/freeze-frame.ts files it under `unrecognised` (it is shorter than
 * the 5-byte header), which keeps the bytes but does not name what they mean. Left
 * alone deliberately: naming it is a change to the decoder's outcome union and belongs
 * with the freeze-frame channel, not with this feature. docs/lifetime-battery-statistics.md.
 *
 * ⚠️ Timestamped 13:16, two minutes BEFORE the capture file named above opened. The
 * reading that fits: 54 is not in that batch (`for c in 51 52 53 60`), so this came
 * from the capture that was still running before read-freeze-frame.ts bounced the
 * interface — i.e. from the file #160 is about losing. Stated as an inference,
 * because the reporting session named a file for 53 and 60 and not for this one.
 */
export const CAPTURED_EXCHANGE_54: CapturedExchange = {
  component: 54,
  frames: [
    { line: "(2026-09-08 13:16:52.974657)  can0  7C0  [8]  A8 03 17 00 36 00 00 00", role: "0x17 request" },
    { line: "(2026-09-08 13:16:53.000204)  can0  7E0  [8]  F1 02 57 00 00 00 00 00", role: "two-byte reply" },
  ],
};

/** The payload for one of the two lost-frame components. Throws on a component this file does not hold. */
export function lifetimeReadPayload(component: number): Uint8Array {
  const entry = LIFETIME_READ_PAYLOADS.find(candidate => candidate.component === component);
  if (!entry) {
    throw new Error(`captured-lifetime-reads: no 2026-09-08 payload for component ${component}`);
  }
  return Uint8Array.from(entry.payloadHex.split(" ").map(byte => Number.parseInt(byte, 16)));
}

/**
 * Reassembles an exchange's reply through the PRODUCTION reassembler.
 *
 * Deliberately not a local concatenation, for the reason ./captured-freeze-frames.ts
 * gives: a hand-rolled one ignores sequence numbers and the address byte, and would
 * pass the renumbering mutation PR #98 was about.
 */
export function capturedExchangePayload(exchange: CapturedExchange): Uint8Array {
  const reassembler = new ExtendedIsoTpReassembler();
  let result;
  for (const frame of exchange.frames) {
    const parsed = parseCandumpLine(frame.line);
    // Replies only: our own request and flow-control frames are on the other id and
    // are not part of what the micro said.
    if (parsed.canId !== VCU_RESPONSE_CAN_ID) {
      continue;
    }
    result = reassembler.push(parsed.data);
  }
  if (!result || result.status !== "complete") {
    throw new Error(
      `captured-lifetime-reads: component ${exchange.component} did not reassemble (${result?.status ?? "no reply frames"})`
    );
  }
  return result.payload;
}

/** Milliseconds from one frame of an exchange to another, by index. Local timestamps, so a delta is safe. */
export function frameIntervalMs(exchange: CapturedExchange, fromIndex: number, toIndex: number): number {
  return parseCandumpLine(exchange.frames[toIndex].line).atMs - parseCandumpLine(exchange.frames[fromIndex].line).atMs;
}

/** Where the VCU answers. The requests in these captures are on 0x7C0. */
const VCU_RESPONSE_CAN_ID = 0x7e0;

const CANDUMP_LINE =
  /^\(\d{4}-\d{2}-\d{2} (\d{2}):(\d{2}):(\d{2})\.(\d{6})\)\s+\S+\s+([0-9A-F]{3})\s+\[\d\]\s+([0-9A-F ]+)$/;

/** One candump line into an id, its bytes and its time in ms. Throws rather than guessing. */
export function parseCandumpLine(line: string): { atMs: number; canId: number; data: Uint8Array } {
  const match = CANDUMP_LINE.exec(line);
  if (!match) {
    throw new Error(`captured-lifetime-reads: not a candump line: ${JSON.stringify(line)}`);
  }
  const [, hours, minutes, seconds, microseconds, canId, bytes] = match;
  const atMs = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(microseconds) / 1000;
  return { atMs, canId: Number.parseInt(canId, 16), data: parseHexFrame(bytes.trim()) };
}
