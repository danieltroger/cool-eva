import { SIGNALS } from "../src/can/registry.ts";
import {
  DOUBLE_CLICK_WINDOW_MS,
  DoubleClickDetector,
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
// ## What this is really guarding
//
// Not "does a double click work". That is the easy half. Both of these gestures sit on
// buttons with primary vehicle functions — `btn_cruise_set` sets the cruise speed,
// `btn_indicator_cancel` cancels the turn signal — and the failure that matters is a
// gesture firing on an ORDINARY press of one of them. So most of the cases below are
// real durations measured off this bike's own bus that must NOT be recognised:
//
//   • 140 ms — the median handlebar press across 14 candump captures, and since
//     indicator-cancel is 63 of the ~70 presses in that corpus, effectively the median
//     cancel tap.
//   • 920 ms — the longest ordinary press ever recorded on any handlebar button
//     (`btn_cruise_enable`, 2026-08-04 19:45:47.924). The long-press threshold has to
//     clear this, or a rider who leans on a button saves a waypoint by accident.
//   • 1794 ms — the only `btn_cruise_set` press in the corpus (2026-08-04 18:04:45.055),
//     held while cruise took the speed. A press this long must never pair with the one
//     after it into a double click.
//
// It also checks that the gestures are bound to the buttons they claim, because the
// names are a trap: `btn_cruise_enable` sits next to `btn_cruise_set` and BOTH of its
// recorded presses armed cruise control 0.53 s later. Binding a UI gesture to that bit
// would put a tab switch on a control that changes how the bike is moving.

const failures: string[] = [];

/** One reading of a button, at a monotonic time in ms. */
interface Sample {
  at: number;
  /** The button bit, or null for "this signal has never arrived". */
  value: number | null;
}

// ── 1. Long press: btn_indicator_cancel → save a waypoint ────────────────────────

interface LongPressCase {
  what: string;
  samples: Sample[];
  /** Monotonic times at which the gesture must fire — usually none. */
  firesAt: number[];
}

const LONG_PRESS_CASES: LongPressCase[] = [
  {
    what: "the median 140 ms cancel tap — the single most common press on this bike",
    samples: [
      { at: 0, value: 0 },
      { at: 1000, value: 1 },
      { at: 1140, value: 0 },
      { at: 5000, value: 0 },
    ],
    firesAt: [],
  },
  {
    what: "a 30 ms tap, the shortest press in the corpus",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 130, value: 0 },
      { at: 5000, value: 0 },
    ],
    firesAt: [],
  },
  {
    what: "920 ms — the longest ordinary press recorded on any handlebar button",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 1020, value: 0 },
      { at: 5000, value: 0 },
    ],
    firesAt: [],
  },
  {
    what: "1199 ms, one millisecond short of the threshold",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 1299, value: 0 },
      { at: 5000, value: 0 },
    ],
    firesAt: [],
  },
  {
    what: "a deliberate hold — fires at the threshold, while the thumb is still down",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 2000, value: 0 },
    ],
    // 100 + LONG_PRESS_MS, and strictly before the release at 2000: the rider must be
    // told it worked without having to let go to find out.
    firesAt: [100 + LONG_PRESS_MS],
  },
  {
    what: "a 3 s hold — one waypoint, not one per second",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 3100, value: 0 },
      { at: 6000, value: 0 },
    ],
    firesAt: [100 + LONG_PRESS_MS],
  },
  {
    what: "two separate holds — one waypoint each",
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 1500, value: 0 },
      { at: 3000, value: 1 },
      { at: 4500, value: 0 },
    ],
    firesAt: [100 + LONG_PRESS_MS, 3000 + LONG_PRESS_MS],
  },
  {
    what: "the page loading mid-press — a hold we never saw begin is not a gesture",
    samples: [
      { at: 0, value: 1 },
      { at: 4000, value: 1 },
      { at: 4200, value: 0 },
    ],
    firesAt: [],
  },
  {
    what: "a signal that has never arrived, then a real hold once it does",
    samples: [
      { at: 0, value: null },
      { at: 500, value: null },
      { at: 1000, value: 0 },
      { at: 1100, value: 1 },
      { at: 3000, value: 0 },
    ],
    firesAt: [1100 + LONG_PRESS_MS],
  },
];

for (const testCase of LONG_PRESS_CASES) {
  const fired = replayLongPress(testCase.samples);
  if (!sameNumbers(fired, testCase.firesAt)) {
    failures.push(
      `long press, ${testCase.what}: fired at [${fired.join(", ")}] ms, expected [${testCase.firesAt.join(", ")}] ms`
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
    samples: [
      { at: 0, value: 0 },
      { at: 100, value: 1 },
      { at: 1894, value: 0 },
      { at: 5000, value: 0 },
    ],
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
    what: "two deliberate presses ~1 s apart, the gap press.js measures between separate presses",
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
    samples: [
      { at: 0, value: null },
      { at: 500, value: null },
      { at: 1000, value: null },
    ],
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
    `the 140 ms median tap, the 30 ms shortest, the 920 ms longest ordinary press and the real 1794 ms ` +
    `cruise-set press all fire nothing; a ${LONG_PRESS_MS} ms hold saves exactly one waypoint, while held; ` +
    `and both gestures are bound to registered, deadband-free button bits that are not the cruise-arm switch`
);

/**
 * Replays one sequence the way public/lib/handlebar-gestures.js drives it: readings
 * when they arrive, plus a wakeup at the detector's deadline.
 *
 * The wakeup is not a detail to skip. A held button produces exactly two messages, one
 * per edge, so nothing arrives at the moment the threshold is crossed — a replay driven
 * by samples alone would only ever see the gesture fire on release, and would happily
 * pass a detector that could never fire on the phone at all.
 */
function replayLongPress(samples: Sample[]): number[] {
  const detector = new LongPressDetector();
  const firedAt: number[] = [];
  let held: number | null = null;

  for (const sample of samples) {
    // Any deadline falling at or before this sample is a timer that would have run
    // first. A `while` rather than a `for` with an empty increment clause, which
    // Prettier 3.8 and 3.9 disagree about how to space and which therefore churns
    // between a local run and CI's pinned version.
    let deadline = detector.deadlineMs();
    while (deadline !== null && deadline <= sample.at) {
      if (detector.observe(held, deadline)) {
        firedAt.push(deadline);
      }
      // Only ever forwards. The detector latches after firing so deadlineMs() goes
      // null, but a deadline that came back unchanged would spin here for ever.
      const next = detector.deadlineMs();
      deadline = next !== null && next !== deadline ? next : null;
    }
    if (detector.observe(sample.value, sample.at)) {
      firedAt.push(sample.at);
    }
    held = sample.value;
  }
  return firedAt;
}

function sameNumbers(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
