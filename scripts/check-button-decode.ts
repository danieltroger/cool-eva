import { decodeFrame, STREAM_IDS } from "../src/can/decode.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor } from "../public/lib/bounds.js";

// Replays the handlebar-button and fast-charge-contactor frames through the real
// decoder, on a laptop, with no bike — the same trick scripts/decode-dtc-response.ts
// plays for the trouble-code path, and for the same reason: the bike is reachable for
// a few minutes at a time in a garage with no reception, and `socketcan` does not
// build on macOS anyway.
//
//   node --experimental-strip-types scripts/check-button-decode.ts
//
// Every frame below is REAL — copied byte for byte, with its timestamp, out of the
// candump captures in ~/Documents/cool-eva-archive (see CAPTURES.md there). None is
// hand-written, because a hand-written frame only proves the decoder agrees with
// whoever wrote the fixture. The two 0x400 button payloads in particular are the ONLY
// two ever recorded on this bike: across 1 099 357 frames of 0x400, byte 2 held a
// non-zero value in 362 of them and took exactly these two values.
//
// Beyond the byte-level decode this guards three things that would each turn the
// whole feature off without failing anything else:
//
//   • 0x400 must stay in STREAM_IDS. Those ids set the kernel RX filters, so dropping
//     it makes four of the eight buttons silently undecodable however right the
//     decoder is — and the symptom, a tile that reads "–" forever, looks exactly like
//     a button nobody has pressed.
//   • every key the decoder emits must be in the registry. A missing one still logs,
//     under group "misc" with no unit, where bounds.js cannot gate it and the ALL
//     view files it away from the buttons section it was added for.
//   • no button may carry a deadband. signals.ts logs when the change EXCEEDS the
//     deadband, so any deadband ≥ 1 on a 0/1 signal makes `|1 − 0| > 1` false and the
//     signal is never logged again after its first sample. Silently. Forever.

interface FrameCase {
  /** What was happening, and where the frame came from. */
  what: string;
  id: number;
  /** The frame as it appears in the candump log. */
  hex: string;
  /** Every key/value this frame must produce. Other keys may also be produced. */
  expect: Record<string, number>;
}

const BUTTON_KEYS = [
  "btn_mode_left",
  "btn_mode_right",
  "btn_mode_enter",
  "btn_indicator_cancel",
  "btn_set_back",
  "btn_cruise_enable",
  "btn_cruise_set",
  "btn_heated_grip",
];

/** Buttons at rest, for the frames where nothing is being pressed. */
const NONE_PRESSED_102 = {
  btn_mode_left: 0,
  btn_mode_right: 0,
  btn_mode_enter: 0,
  btn_indicator_cancel: 0,
};
const NONE_PRESSED_400 = {
  btn_set_back: 0,
  btn_cruise_enable: 0,
  btn_cruise_set: 0,
  btn_heated_grip: 0,
};

const CASES: FrameCase[] = [
  {
    what: "0x102 riding on low beam, nothing pressed, not charging — 2026-08-04 03:56:31.470",
    id: 0x102,
    hex: "80 10 02 44 8E FF D8 FF",
    // b0 = 0x80 (low beam switch), b2 = 0x02 (low beam lamp): the pair that shipped as
    // `charge_port_unlocked` reading 1 on a bike that was not plugged into anything.
    expect: {
      ...NONE_PRESSED_102,
      fast_dc_contactor: 0,
      cruise_active: 0,
      high_beam: 0,
      high_beam_lamp: 0,
      low_beam_lamp: 1,
    },
  },
  {
    what: "0x102 flash-to-pass, both beams lit at 18:20:42.154 — 2026-08-02 ride-1",
    id: 0x102,
    // b0 = 0xC0 (both beam switches), b2 = 0x83 (both beam lamps + moving). The single
    // frame that shows the whole argument: the bits that were called `charging` and
    // `charge_port_unlocked` both go high the instant the high beam is flashed, on a
    // bike doing 100 km/h nowhere near a charger.
    hex: "C0 3E 83 44 F4 FF 17 00",
    expect: { high_beam: 1, high_beam_lamp: 1, low_beam_lamp: 1, moving: 1, fast_dc_contactor: 0 },
  },
  {
    what: "0x102 parked with the lights off — 2026-08-04 19:58:18.703",
    id: 0x102,
    hex: "00 10 00 44 B0 FF D2 FF",
    expect: { high_beam: 0, high_beam_lamp: 0, low_beam_lamp: 0, moving: 0 },
  },
  {
    what: "0x102 MODE ◀ held, stationary at a DC charger — 2026-08-04 20:09:06.054",
    id: 0x102,
    hex: "01 12 00 45 B5 FF D2 FF",
    // Same frame carries the contactor bit, which is the point of taking it from
    // inside the charge rather than from a tidier moment: the two decode independently
    // out of bytes 0 and 3 and must not disturb each other.
    expect: { ...NONE_PRESSED_102, btn_mode_left: 1, fast_dc_contactor: 1, cruise_active: 0 },
  },
  {
    what: "0x102 MODE ▶ held at 28 km/h — 2026-08-04 18:01:23.309",
    id: 0x102,
    hex: "82 BE 82 44 0C 00 7D FF",
    expect: { ...NONE_PRESSED_102, btn_mode_right: 1, fast_dc_contactor: 0, cruise_active: 0 },
  },
  {
    what: "0x102 MODE ENTER held, stationary at a DC charger — 2026-08-04 20:00:58.307",
    id: 0x102,
    hex: "04 12 00 45 B0 FF D2 FF",
    expect: { ...NONE_PRESSED_102, btn_mode_enter: 1, fast_dc_contactor: 1 },
  },
  {
    what: "0x102 indicator-cancel pressed with the right indicator lit — 2026-08-04 18:01:22.807",
    id: 0x102,
    hex: "A0 BE 8A 44 17 00 58 FF",
    // b2 = 0x8A, so blinker_right is on in this very frame. That co-occurrence is the
    // evidence for the bit's identity (63 of 63 presses landed while an indicator was
    // flashing), so the fixture asserts both halves of it rather than the button alone.
    expect: { ...NONE_PRESSED_102, btn_indicator_cancel: 1, blinker_right: 1, blinker_left: 0 },
  },
  {
    what: "0x102 the instant the fast-charge contactor closed — 2026-08-04 19:58:45.488",
    id: 0x102,
    hex: "00 12 00 45 B5 FF D2 FF",
    expect: { ...NONE_PRESSED_102, fast_dc_contactor: 1, cruise_active: 0 },
  },
  {
    what: "0x102 cruise armed, 0.5 s after the ON/OFF press — 2026-08-04 18:04:42.795",
    id: 0x102,
    hex: "80 BE 82 46 E9 FF F4 FF",
    expect: { ...NONE_PRESSED_102, cruise_active: 1, fast_dc_contactor: 0 },
  },
  {
    what: "0x400 idle — the payload 989 707 of 1 099 357 frames carried",
    id: 0x400,
    hex: "02 01 00 00 00 00 00 00",
    expect: { ...NONE_PRESSED_400 },
  },
  {
    what: "0x400 idle with the day/night bit set (b5 0x80) — 2026-08-04 18:04:12.439",
    id: 0x400,
    // b5 is not decoded; this is here to prove that b5 moving cannot move a button.
    hex: "02 01 00 00 00 80 00 00",
    expect: { ...NONE_PRESSED_400 },
  },
  {
    what: "0x400 cruise ON/OFF held at 88 km/h — 2026-08-04 18:04:42.270",
    id: 0x400,
    hex: "02 01 02 00 00 00 00 00",
    expect: { ...NONE_PRESSED_400, btn_cruise_enable: 1 },
  },
  {
    what: "0x400 cruise SET SPEED held at 87.6 km/h — 2026-08-04 18:04:45.054",
    id: 0x400,
    hex: "02 01 04 00 00 00 00 00",
    expect: { ...NONE_PRESSED_400, btn_cruise_set: 1 },
  },
];

const failures: string[] = [];

for (const testCase of CASES) {
  const decoded = decodeFrame(testCase.id, parseFrame(testCase.hex));
  const values = new Map(decoded.map(value => [value.key, value.value]));
  const rendered = Object.entries(testCase.expect)
    .map(
      ([key, expected]) =>
        `${key}=${values.get(key) ?? "∅"}${values.get(key) === expected ? "" : ` (want ${expected})`}`
    )
    .join("  ");
  console.log(`0x${testCase.id.toString(16)}  ${testCase.hex}`);
  console.log(`      ${testCase.what}`);
  console.log(`      ${rendered}`);
  for (const [key, expected] of Object.entries(testCase.expect)) {
    const actual = values.get(key);
    if (actual !== expected) {
      failures.push(
        `${testCase.hex} (${testCase.what}): ${key} decoded as ${actual ?? "missing"}, expected ${expected}`
      );
    }
  }
}

// The two 0x102 b2 bits that shipped as `charging` and `charge_port_unlocked` are the
// beam lamps (decode.ts has the 1 103 000-frame measurement). Nothing may bring those
// names back: `charging` in particular reads 0 through every real charge and 1 when the
// high beam is flashed, so a caller trusting it gets the opposite of what it asked for,
// and src/vcu/service-gate.ts has a standing warning about exactly that.
const beamFrame = decodeFrame(0x102, parseFrame("C0 3E 83 44 F4 FF 17 00"));
for (const retired of ["charging", "charge_port_unlocked"]) {
  if (beamFrame.some(value => value.key === retired)) {
    failures.push(`0x102 still emits "${retired}" — it is a beam lamp, see the comment in src/can/decode.ts`);
  }
}
// The high-beam switch and its lamp are two different bytes and agreed in every frame
// ever captured, so a decode that lets them disagree here has moved a bit.
for (const [hex, description] of [
  ["C0 3E 83 44 F4 FF 17 00", "high beam flashed"],
  ["80 10 02 44 8E FF D8 FF", "low beam only"],
  ["00 10 00 44 B0 FF D2 FF", "lights off"],
] as const) {
  const values = new Map(decodeFrame(0x102, parseFrame(hex)).map(value => [value.key, value.value]));
  if (values.get("high_beam") !== values.get("high_beam_lamp")) {
    failures.push(
      `${description}: high_beam=${values.get("high_beam")} but high_beam_lamp=${values.get("high_beam_lamp")}`
    );
  }
}

// A frame missing from STREAM_IDS never reaches decodeFrame at all — decode.ts says so
// in its own comment — so the decoder above can be perfect and the buttons still dead.
if (!STREAM_IDS.includes(0x400)) {
  failures.push("0x400 is not in STREAM_IDS, so the kernel filters drop it and half the buttons never arrive");
}
if (!STREAM_IDS.includes(0x102)) {
  failures.push("0x102 is not in STREAM_IDS");
}

// Short frames must lose only what they actually truncate. The b0 buttons have to
// survive a 3-byte 0x102 the same way high_beam and the brake bits do, because those
// three bytes are all that has ever been logged from this frame since June.
const shortFrame = decodeFrame(0x102, parseFrame("A0 BE 8A"));
const shortKeys = new Set(shortFrame.map(value => value.key));
if (!shortKeys.has("btn_indicator_cancel")) {
  failures.push("a 3-byte 0x102 should still decode the byte-0 buttons");
}
if (shortKeys.has("fast_dc_contactor") || shortKeys.has("cruise_active")) {
  failures.push("a 3-byte 0x102 must not invent byte-3 signals");
}
if (decodeFrame(0x400, parseFrame("02 01")).length !== 0) {
  failures.push("a 0x400 shorter than 3 bytes should decode to nothing, not to a pressed button");
}

// Every key the decoder emits must be described in the registry, or it is logged into
// group "misc" where the plausibility gate and the buttons section cannot see it.
const defined = new Map(SIGNALS.map(signal => [signal.key, signal]));
for (const key of [...BUTTON_KEYS, "fast_dc_contactor", "cruise_active"]) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`${key} is decoded but not defined in src/can/registry.ts`);
    continue;
  }
  if (signal.deadband) {
    failures.push(
      `${key} has deadband ${signal.deadband}: signals.ts logs on |change| > deadband, so a 0/1 signal with any deadband stops logging after its first sample`
    );
  }
}
for (const key of BUTTON_KEYS) {
  const signal = defined.get(key);
  if (signal && signal.group !== "buttons") {
    failures.push(`${key} is in group "${signal.group}", so it will not appear in the dashboard's buttons section`);
  }
  // The dashboard's gate has to recognise the group, or a decoder that one day
  // returns the masked byte instead of the bit renders 32 as an ordinary reading.
  const bounds = signal ? boundsFor(key, signal.unit, signal.group) : null;
  if (!bounds || bounds[0] !== 0 || bounds[1] !== 1) {
    failures.push(`public/lib/bounds.js does not gate ${key} to 0…1 — got ${JSON.stringify(bounds)}`);
  }
}

// The same gate, for the 1/0 signals this frame carries that are NOT in the buttons
// group. Checked separately and by name because they get there by a different route:
// `controls` is a BOOLEAN_GROUP, while `fast_dc_contactor` sits in `charge` alongside
// real measurements and needs its own BY_KEY entry. Raised in review, where it turned
// out to be the one flag added here that had fallen through both routes and was
// rendering unbounded.
for (const key of ["fast_dc_contactor", "cruise_active", "high_beam_lamp", "low_beam_lamp"]) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`${key} is decoded but not defined in src/can/registry.ts`);
    continue;
  }
  const bounds = boundsFor(key, signal.unit, signal.group);
  if (!bounds || bounds[0] !== 0 || bounds[1] !== 1) {
    failures.push(
      `public/lib/bounds.js does not gate ${key} (group "${signal.group}", unit "${signal.unit}") to 0…1 — got ${JSON.stringify(bounds)}`
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
  `✓ ${CASES.length} captured frames decode as recorded; 0x400 is filtered in, short frames stay honest, ` +
    `the beam lamps did not revert to charging/charge_port_unlocked, ` +
    `and all ${BUTTON_KEYS.length} buttons are registered, deadband-free and gated to 0…1`
);

function parseFrame(hex: string): Buffer {
  return Buffer.from(hex.split(/\s+/).map(byte => Number.parseInt(byte, 16)));
}
