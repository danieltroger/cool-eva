import { SIGNALS } from "../src/can/registry.ts";
import { DOUBLE_CLICK_WINDOW_MS, DoubleClickDetector, NEXT_TAB_BUTTON } from "../public/lib/gestures.js";

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
// ⚠️ WHAT THIS IS REALLY GUARDING is not "does a double click work". The gesture sits on
// a button with a primary vehicle function — `btn_cruise_set` sets the cruise speed — so
// the failure that matters is a gesture firing on ORDINARY presses. Most cases below are
// therefore real durations measured off this bike's own bus that must NOT be recognised.
//
// ⚠️ THE HOLD GESTURES ARE NOT HERE ANY MORE. They moved to the Pi with the recogniser
// (src/gestures/long-press.ts) and are checked by scripts/check-hold-gestures.ts, which
// also owns the corpus bounds both hold lengths are argued from.
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

/** The gap between separate deliberate presses of one button, per public/lib/press.js. */
const DELIBERATE_PRESS_GAP_MS = 1000;

/** A gloved, vibrating double tap is roughly twice a bare-handed one's 150–300 ms. */
const GLOVED_DOUBLE_TAP_MS = 500;

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
const boundButtons: [string, string][] = [["the tab gesture", NEXT_TAB_BUTTON]];

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

console.log("");
if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ ${DOUBLE_CLICK_CASES.length} tap sequences behave as recorded — a real 1794 ms cruise-set press never pairs ` +
    `into a double click, two presses delivered back-to-back after a stall stay two, a fumbled triple tap is one ` +
    `switch, and the tab gesture is bound to a registered, deadband-free button bit that is not the cruise-arm ` +
    `switch. The HOLD gestures left this file with the recogniser: scripts/check-hold-gestures.ts`
);
