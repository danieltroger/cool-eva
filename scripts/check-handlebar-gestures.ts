import { SIGNALS } from "../src/can/registry.ts";
import {
  DOUBLE_CLICK_WINDOW_MS,
  DoubleClickDetector,
  IMPLAUSIBLE_HOLD_MS,
  LONG_PRESS_MS,
  LongPressDetector,
  NEXT_TAB_BUTTON,
  WAYPOINT_BUTTON,
} from "../public/lib/gestures.js";

// Replays button press sequences through the real gesture recognisers, on a laptop,
// with no bike.
//
//   node --experimental-strip-types scripts/check-handlebar-gestures.ts
//
// These are the same objects public/lib/gestures.js hands the phone. They are pure —
// every clock they reason about is passed in — which is the whole reason a press
// sequence can be replayed here at all, and why the thresholds can be argued about
// against measured durations rather than against a feel.
//
// ⚠️ A "sample" here is one WebSocket message, carrying the SERVER's timestamp, not the
// phone's — so every `at` below is the Pi's clock. That is the whole point of the design
// (see the top of public/lib/gestures.js) and it is what makes a stalled link
// representable: a stall is simply a gap with no samples in it.
//
// ⚠️ WHAT THIS IS REALLY GUARDING is not "does a double click work". Both gestures sit
// on buttons with primary vehicle functions — `btn_cruise_set` sets the cruise speed,
// `btn_indicator_cancel` cancels the turn signal — so the failure that matters is a
// gesture firing on an ORDINARY press. Most cases below are therefore real durations
// measured off this bike's own bus that must NOT be recognised: 140 ms (the corpus
// median press), 120–260 ms (the MODE buttons, instructed presses, 8/8), 920 ms (the
// longest ordinary press ever recorded — the long-press threshold has to clear it or a
// rider leaning on a button saves a waypoint) and 1794 ms (the only `btn_cruise_set`
// press in the corpus, which must never pair into a double click).
// docs/diagnostics-and-checks.md §11.3 has where each number comes from.
//
// ⚠️ The bindings are checked too, because the names are a trap: `btn_cruise_enable`
// sits next to `btn_cruise_set` and BOTH of its recorded presses armed cruise control
// 0.53 s later. A UI gesture on that bit puts a tab switch on a control that changes
// how the bike is moving.

const failures: string[] = [];

/** One WebSocket message: the button's value, at the SERVER's timestamp in ms. */
interface Sample {
  at: number;
  /** The button bit, or null for "this signal has never arrived". */
  value: number | null;
}

/**
 * Filler messages carrying an unchanged button value while the server clock advances.
 *
 * This is what the link actually delivers during a hold: patches carry only what
 * CHANGED, so the button's own signal sits still while everything else on the bus keeps
 * moving. 200 ms apart because that is the measured rate — replaying the 90 s parked
 * capture in obd-garage/captures through the real decoders and the registry's real
 * deadbands gives 5.3 Hz, median gap 136 ms.
 */
function traffic(from: number, to: number, value: number | null, everyMs = 200): Sample[] {
  const out: Sample[] = [];
  for (let at = from; at <= to; at += everyMs) {
    out.push({ at, value });
  }
  return out;
}

// ── 1. Long press: btn_indicator_cancel → save a waypoint ────────────────────────

interface LongPressCase {
  what: string;
  samples: Sample[];
  /** Server timestamps at which the gesture must fire — usually none. */
  firesAt: number[];
  /** Whether the button was still down at each fire. Only checked when it fires. */
  stillHeldAtFire?: boolean;
}

const LONG_PRESS_CASES: LongPressCase[] = [
  {
    what: "the median 140 ms cancel tap — the single most common press on this bike",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, { at: 1140, value: 0 }, ...traffic(1200, 5000, 0)],
    firesAt: [],
  },
  {
    what: "a 30 ms tap, the shortest press in the corpus",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, { at: 1030, value: 0 }, ...traffic(1200, 3000, 0)],
    firesAt: [],
  },
  {
    what: "260 ms — the longest MODE-button pulse confirmed by instructed press, 2026-08-19",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, { at: 1260, value: 0 }, ...traffic(1400, 3000, 0)],
    firesAt: [],
  },
  {
    what: "920 ms — the longest ordinary press recorded on any handlebar button",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, ...traffic(1200, 1800, 1), { at: 1920, value: 0 }],
    firesAt: [],
  },
  {
    what: "1199 ms, one millisecond short of the threshold",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, ...traffic(1200, 2000, 1), { at: 2199, value: 0 }],
    firesAt: [],
  },
  {
    what: "a deliberate hold — fires at the threshold, with the thumb still down",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, ...traffic(1200, 2400, 1), { at: 2500, value: 0 }],
    firesAt: [1000 + LONG_PRESS_MS],
    stillHeldAtFire: true,
  },
  {
    what: "a 3 s hold — one waypoint, not one per message",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, ...traffic(1200, 4000, 1), { at: 4000, value: 0 }],
    firesAt: [1000 + LONG_PRESS_MS],
    stillHeldAtFire: true,
  },
  {
    what: "two separate holds — one waypoint each",
    samples: [
      ...traffic(0, 800, 0),
      { at: 1000, value: 1 },
      ...traffic(1200, 2400, 1),
      { at: 2500, value: 0 },
      ...traffic(2600, 3800, 0),
      { at: 4000, value: 1 },
      ...traffic(4200, 5400, 1),
      { at: 5500, value: 0 },
    ],
    firesAt: [1000 + LONG_PRESS_MS, 4000 + LONG_PRESS_MS],
    stillHeldAtFire: true,
  },
  {
    what: "the page loading mid-press — a hold we never saw begin is not a gesture",
    samples: [{ at: 1000, value: 1 }, ...traffic(1200, 5000, 1), { at: 5200, value: 0 }],
    firesAt: [],
  },
  {
    what: "a signal that has never arrived, then a real hold once it does",
    samples: [
      ...traffic(0, 800, null),
      { at: 1000, value: 0 },
      { at: 1100, value: 1 },
      ...traffic(1300, 2500, 1),
      { at: 2600, value: 0 },
    ],
    firesAt: [1100 + LONG_PRESS_MS],
    stillHeldAtFire: true,
  },
  {
    // ⚠️ THE REGRESSION THIS DESIGN EXISTS FOR. Raised in review of #74: a 140 ms tap
    // whose release patch is held up 1.5 s by a garage hotspot used to be indistinguish-
    // able from a 1.5 s hold, because the old detector was driven by a local timer and
    // measured the gap between two messages ARRIVING. It saved a waypoint nobody asked
    // for, into the sealed log.
    //
    // A stall is a gap with no samples: the phone hears nothing, so the server clock it
    // is given does not advance. When the queued release finally lands it carries the
    // time it really happened, 140 ms after the press, and the tap reads as a tap.
    what: "a 140 ms tap whose release is delivered 1.5 s late — a stalled link is not a hold",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, { at: 1140, value: 0 }, ...traffic(1300, 3000, 0)],
    firesAt: [],
  },
  {
    // The other side of the same coin: the link goes quiet DURING a genuine hold, so
    // nothing proves the button is still down until the release arrives — and its
    // timestamp says the press was 1400 ms. Late feedback for a gesture that was really
    // made, which is much better than dropping it.
    what: "a genuine 1400 ms hold across a quiet link — learned from the release, and still saved",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, { at: 2400, value: 0 }, ...traffic(2600, 4000, 0)],
    firesAt: [2400],
    stillHeldAtFire: false,
  },
  {
    what: "the GPS clock stepping an hour forward mid-hold — a clock jump is not a press",
    samples: [
      ...traffic(0, 800, 0),
      { at: 1000, value: 1 },
      { at: 1000 + 3_600_000, value: 1 },
      { at: 1200 + 3_600_000, value: 1 },
      { at: 1400 + 3_600_000, value: 0 },
    ],
    firesAt: [],
  },
  {
    what: "the clock stepping backwards mid-hold",
    samples: [...traffic(0, 800, 0), { at: 1000, value: 1 }, { at: 500, value: 1 }, { at: 700, value: 0 }],
    firesAt: [],
  },
];

for (const testCase of LONG_PRESS_CASES) {
  const detector = new LongPressDetector();
  const firedAt: number[] = [];
  const firedWhileHeld: boolean[] = [];
  for (const sample of testCase.samples) {
    if (detector.observe(sample.value, sample.at)) {
      firedAt.push(sample.at);
      firedWhileHeld.push(sample.value === 1);
    }
  }
  if (!sameNumbers(firedAt, testCase.firesAt)) {
    failures.push(
      `long press, ${testCase.what}: fired at [${firedAt.join(", ")}], expected [${testCase.firesAt.join(", ")}]`
    );
    continue;
  }
  if (testCase.stillHeldAtFire !== undefined && firedWhileHeld.some(held => held !== testCase.stillHeldAtFire)) {
    failures.push(
      `long press, ${testCase.what}: expected every fire to be ${testCase.stillHeldAtFire ? "while still held" : "on the release"}, got [${firedWhileHeld.join(", ")}]`
    );
  }
}

// ── 2. Double click: btn_cruise_set → next tab ───────────────────────────────────

interface DoubleClickCase {
  what: string;
  samples: Sample[];
  /** How many tab switches this sequence must produce. */
  switches: number;
}

const DOUBLE_CLICK_CASES: DoubleClickCase[] = [
  {
    what: "a brisk double tap, 300 ms between rising edges",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 240, value: 0 },
      { at: 400, value: 1 },
      { at: 540, value: 0 },
    ],
    switches: 1,
  },
  {
    what: "a slow gloved double tap, right on the window",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 240, value: 0 },
      { at: 100 + DOUBLE_CLICK_WINDOW_MS, value: 1 },
      { at: 240 + DOUBLE_CLICK_WINDOW_MS, value: 0 },
    ],
    switches: 1,
  },
  {
    what: "one millisecond past the window — two presses, not a gesture",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 240, value: 0 },
      { at: 101 + DOUBLE_CLICK_WINDOW_MS, value: 1 },
      { at: 241 + DOUBLE_CLICK_WINDOW_MS, value: 0 },
    ],
    switches: 0,
  },
  {
    what: "the real 1794 ms cruise-set press, setting a cruise speed and nothing else",
    samples: [{ at: 0, value: 0 }, { at: 100, value: 1 }, { at: 1894, value: 0 }, ...traffic(2000, 3000, 0)],
    switches: 0,
  },
  {
    what: "that same press followed by another 100 ms after release — still not a double click",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 1894, value: 0 },
      { at: 1994, value: 1 },
      { at: 2134, value: 0 },
    ],
    switches: 0,
  },
  {
    // The mirror of the long-press stall case. Two presses a second apart, delivered
    // back-to-back after the link unblocks, used to collapse into one double click when
    // the gap was measured on arrival. Timed by the server's stamps they stay a second
    // apart however they were delivered.
    what: "two deliberate presses 1 s apart, delivered back-to-back after a stall",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 240, value: 0 },
      { at: 1100, value: 1 },
      { at: 1240, value: 0 },
    ],
    switches: 0,
  },
  {
    what: "a fumbled triple tap — one switch, not two, so it cannot overshoot",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 200, value: 0 },
      { at: 400, value: 1 },
      { at: 500, value: 0 },
      { at: 700, value: 1 },
      { at: 800, value: 0 },
    ],
    switches: 1,
  },
  {
    what: "four taps — two deliberate double clicks, two tabs on",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 200, value: 0 },
      { at: 400, value: 1 },
      { at: 500, value: 0 },
      { at: 700, value: 1 },
      { at: 800, value: 0 },
      { at: 1000, value: 1 },
      { at: 1100, value: 0 },
    ],
    switches: 2,
  },
  {
    what: "the page loading mid-press, then one tap",
    samples: [
      { at: 0, value: 1 },
      { at: 200, value: 0 },
      { at: 400, value: 1 },
      { at: 500, value: 0 },
    ],
    switches: 0,
  },
  {
    what: "a signal that has never arrived",
    samples: traffic(0, 1000, null),
    switches: 0,
  },
];

for (const testCase of DOUBLE_CLICK_CASES) {
  const detector = new DoubleClickDetector();
  let switches = 0;
  for (const sample of testCase.samples) {
    if (detector.observe(sample.value, sample.at)) {
      switches += 1;
    }
  }
  if (switches !== testCase.switches) {
    failures.push(`double click, ${testCase.what}: switched ${switches} times, expected ${testCase.switches}`);
  }
}

// ── 3. The thresholds themselves ─────────────────────────────────────────────────

/** The longest ordinary press recorded on any handlebar button — btn_cruise_enable. */
const LONGEST_ORDINARY_PRESS_MS = 920;

/** The gap between separate deliberate presses of one button, per public/lib/press.js. */
const DELIBERATE_PRESS_GAP_MS = 1000;

/** A gloved, vibrating double tap is roughly twice a bare-handed one's 150–300 ms. */
const GLOVED_DOUBLE_TAP_MS = 500;

/** src/ws.ts heartbeats a full snapshot this often, so a hold can be learned about this late. */
const HEARTBEAT_MS = 5_000;

/** The smallest step the GPS clock gate will ever make — DRIFT_THRESHOLD_SECONDS. */
const SMALLEST_CLOCK_STEP_MS = 60_000;

if (LONG_PRESS_MS <= LONGEST_ORDINARY_PRESS_MS) {
  failures.push(
    `LONG_PRESS_MS is ${LONG_PRESS_MS} ms, which does not clear the longest ordinary handlebar press ` +
      `ever recorded (${LONGEST_ORDINARY_PRESS_MS} ms) — an ordinary press would save a waypoint`
  );
}
if (DOUBLE_CLICK_WINDOW_MS >= DELIBERATE_PRESS_GAP_MS) {
  failures.push(
    `DOUBLE_CLICK_WINDOW_MS is ${DOUBLE_CLICK_WINDOW_MS} ms, at or past the ~${DELIBERATE_PRESS_GAP_MS} ms gap ` +
      `between separate deliberate presses — two ordinary cruise-set presses would switch tabs`
  );
}
if (DOUBLE_CLICK_WINDOW_MS <= GLOVED_DOUBLE_TAP_MS) {
  failures.push(
    `DOUBLE_CLICK_WINDOW_MS is ${DOUBLE_CLICK_WINDOW_MS} ms, inside the ~${GLOVED_DOUBLE_TAP_MS} ms a gloved ` +
      `double tap takes — the gesture would be unreachable with winter gloves on`
  );
}
// The ceiling has to sit in the gap between "the slowest we can legitimately learn a
// button is still down" and "the smallest jump the clock can make". If it ever leaves
// that gap it either drops real holds or stops catching clock steps.
if (IMPLAUSIBLE_HOLD_MS <= HEARTBEAT_MS || IMPLAUSIBLE_HOLD_MS >= SMALLEST_CLOCK_STEP_MS) {
  failures.push(
    `IMPLAUSIBLE_HOLD_MS is ${IMPLAUSIBLE_HOLD_MS} ms, outside the ${HEARTBEAT_MS}–${SMALLEST_CLOCK_STEP_MS} ms ` +
      `window between the WebSocket heartbeat and the smallest clock step the GPS gate makes`
  );
}

// ── 4. What the gestures are bound to ────────────────────────────────────────────

/**
 * ⚠️ The one binding that must never happen. `btn_cruise_enable` is the cruise ON/OFF
 * switch: src/can/decode.ts records that BOTH of its presses in the corpus armed cruise
 * control 0.53 s later, contradicting the owner's manual's "3-second hold". A UI gesture
 * on that bit would be a tab switch that changes how the bike is moving.
 */
const FORBIDDEN_BINDING = "btn_cruise_enable";

const defined = new Map(SIGNALS.map(signal => [signal.key, signal]));

// Widened to `string` deliberately. The constants have literal types, so tsc can prove
// the two comparisons below false as things stand and reports them as unintentional —
// but they are precisely the comparisons that must start being true the moment somebody
// re-points a binding, and `npm test` has to catch that whether or not tsc ran first.
const boundButtons: [string, string][] = [
  ["the tab gesture", NEXT_TAB_BUTTON],
  ["the waypoint gesture", WAYPOINT_BUTTON],
];

for (const [role, key] of boundButtons) {
  if (key === FORBIDDEN_BINDING) {
    failures.push(`${role} is bound to ${FORBIDDEN_BINDING}, which arms cruise control — see the note above`);
  }
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`${role} is bound to ${key}, which is not defined in src/can/registry.ts`);
    continue;
  }
  if (signal.group !== "buttons") {
    failures.push(`${role} is bound to ${key}, which is in group "${signal.group}" rather than "buttons"`);
  }
  // The same trap scripts/check-button-decode.ts guards, restated because a gesture is
  // a second thing that breaks when it happens: signals.ts logs a change only when it
  // EXCEEDS the deadband, so any deadband ≥ 1 on a 0/1 signal stops it after the first
  // sample and the gesture simply never fires again.
  if (signal.deadband) {
    failures.push(`${role} is bound to ${key}, which carries a deadband of ${signal.deadband} — it must be 0`);
  }
}

if (boundButtons[0][1] === boundButtons[1][1]) {
  failures.push(`both gestures are bound to ${NEXT_TAB_BUTTON} — one button cannot carry both`);
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
  `✓ ${LONG_PRESS_CASES.length} hold sequences and ${DOUBLE_CLICK_CASES.length} tap sequences behave as recorded — ` +
    `the 140 ms median tap, the 30 ms shortest, the 260 ms longest confirmed MODE pulse, the 920 ms longest ` +
    `ordinary press and the real 1794 ms cruise-set press all fire nothing; a stalled link is not a hold and ` +
    `two presses delivered back-to-back are not a double click; a ${LONG_PRESS_MS} ms hold saves exactly one ` +
    `waypoint; and both gestures are bound to registered, deadband-free button bits that are not the cruise-arm switch`
);

function sameNumbers(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
