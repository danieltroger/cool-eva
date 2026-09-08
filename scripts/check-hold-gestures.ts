import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue, record } from "../src/can/signals.ts";
import { FAN_MODE_CODE, startFanAutomatic } from "../src/fan/auto.ts";
import type { FanController, FanState } from "../src/fan/control.ts";
import { MAX_DUTY_PERCENT, MIN_RUNNING_DUTY_PERCENT, startFanControl } from "../src/fan/control.ts";
import type { FanPwm } from "../src/fan/pwm.ts";
import {
  FAN_GESTURE_BUTTON,
  FAN_HOLD_MS,
  STATIONARY_MAX_KMH,
  isStationary,
  nextFanGestureAction,
  type FanGestureInputs,
} from "../src/fan/gesture.ts";
import { startFanCycleGesture } from "../src/fan/gesture-runner.ts";
import { HOLD_BEAT_MS, startHoldGestures } from "../src/gestures/runner.ts";
import {
  HOLD_OUTCOME,
  SAMPLE_MAX_AGE_MS,
  newHoldState,
  observeHold,
  type HoldOutcome,
  type HoldState,
} from "../src/gestures/long-press.ts";
import { boundsFor } from "../public/lib/bounds.js";
import { fanAnnouncementKey, fanAnnouncementText } from "../public/lib/fan-display.js";
import { WAYPOINT_REFUSAL_TEXT, foldAnnouncement } from "../public/lib/announce.js";
import { DOUBLE_CLICK_WINDOW_MS } from "../public/lib/gestures.js";

// The handlebar hold gestures — the fan cycle on MODE ENTER and the waypoint on the
// indicator-cancel switch — checked with no bike, no Pi and no fan.
//
//   node --experimental-strip-types scripts/check-hold-gestures.ts
//
// ⚠️ WHAT THIS IS REALLY GUARDING is that an ORDINARY press never fires a gesture, and
// that a hold is only ever asserted by evidence the bus is still producing. Both buttons
// do something on the bike by themselves: ENTER opens the dash's reset mode, and the
// cancel switch turns the HAZARD LIGHTS on if it is held to about two seconds. So every
// threshold below is checked against durations measured off this bike's own bus, and the
// three freshness rails are planted as sequences rather than argued in a comment.
//
// ⚠️ GPS_TIME_SYNC is set before src/gps/waypoint.ts is imported, which is why that
// import is dynamic. With it unset, systemClockTrust() answers "never-synced" in a
// process that has no GPS, and every waypoint below would be refused for that one reason
// — hiding the three gates this file is actually here to check.
process.env.GPS_TIME_SYNC = "0";
const {
  MAX_PLAUSIBLE_KMH,
  MIN_FIX_INTERVAL_MS,
  WAYPOINT_GESTURE_BUTTON,
  WAYPOINT_HOLD_MS,
  WAYPOINT_REFUSAL,
  saveWaypointNow,
  startWaypointFixTracking,
  waypointHoldGesture,
  waypointsSaved,
} = await import("../src/gps/waypoint.ts");

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

// --- The corpus these thresholds are argued from --------------------------------
//
// Whole archive, 268 capture files, deduped by absolute press instant because two
// candump instances recorded some of the same seconds. Method and caveats:
// docs/handlebar-gestures.md.

/** 160 ENTER presses; the longest anywhere in the archive. No other decoded bit is this clean. */
const LONGEST_ENTER_PRESS_MS = 290;

/** 770 of the 779 indicator-cancel presses. The other nine are one afternoon's experiment. */
const LONGEST_ORDINARY_CANCEL_PRESS_MS = 330;

/** The 0.940 s press from inside that experiment — the nearest thing to a false positive. */
const LONGEST_CANCEL_PRESS_ANYWHERE_MS = 940;

/** Earliest observed hazard-light activation, 2026-08-03. The switch is at or before this. */
const EARLIEST_HAZARD_ACTIVATION_MS = 2011;

/** The longest gap between two 0x102 frames inside any recorded press. */
const LONGEST_GAP_INSIDE_A_PRESS_MS = 14;

// --- 1. The recogniser, planted -------------------------------------------------

console.log("\n1. a hold is asserted by fresh samples, and by nothing else");

interface Sample {
  /** Monotonic milliseconds. */
  at: number;
  pressed: number | null;
  /** How old the reading is at `at`. 10 ms is one frame of 0x102 at 100 Hz. */
  ageMs: number | null;
}

/** Samples at the bus's own rate, carrying an unchanged value. */
function frames(from: number, to: number, pressed: number | null, everyMs = 10): Sample[] {
  const out: Sample[] = [];
  for (let at = from; at <= to; at += everyMs) {
    out.push({ at, pressed, ageMs: pressed === null ? null : 10 });
  }
  return out;
}

/** What the runner does while a press is open: re-examine it, on an AGEING sample. */
function beats(from: number, to: number, pressed: number, sampleAt: number, everyMs = HOLD_BEAT_MS): Sample[] {
  const out: Sample[] = [];
  for (let at = from; at <= to; at += everyMs) {
    out.push({ at, pressed, ageMs: at - sampleAt });
  }
  return out;
}

function run(samples: Sample[], holdMs: number): { fires: number[]; abandons: number[] } {
  let state: HoldState = newHoldState();
  const fires: number[] = [];
  const abandons: number[] = [];
  for (const sample of samples) {
    const folded = observeHold(state, { pressed: sample.pressed, sampleAgeMs: sample.ageMs, nowMs: sample.at, holdMs });
    state = folded.state;
    if (folded.outcome === HOLD_OUTCOME.FIRED) {
      fires.push(sample.at);
    }
    if (folded.outcome === HOLD_OUTCOME.ABANDONED) {
      abandons.push(sample.at);
    }
  }
  return { fires, abandons };
}

// ⚠️ RAIL 1. The bus goes silent with the button down — an AC charge does this for up to
// 23.7 minutes. The press must be abandoned rather than remembered, and nothing that
// looks at it afterwards may resurrect it. Delete the abandon branch in
// src/gestures/long-press.ts and this fires.
const silence = run(
  [
    ...frames(0, 990, 0),
    { at: 1000, pressed: 1, ageMs: 10 },
    // The beat keeps looking while the sample gets older and older…
    ...beats(1100, 1_200_000, 1, 1000),
    // …and then the bus COMES BACK, still carrying a pressed button. This is the half
    // that matters: the samples are fresh again and the press began 20 minutes ago, so
    // anything still holding that start instant fires here. The button raises no change
    // event on the way back — it never changed — so only the beat sees this at all.
    ...frames(1_200_100, 1_202_000, 1),
    { at: 1_202_010, pressed: 0, ageMs: 10 },
  ],
  FAN_HOLD_MS
);
check("⚠️  press, then 20 minutes of silence — never fires", silence.fires.length === 0);
check(
  `…and the press is abandoned as soon as the sample goes stale (${silence.abandons[0]} ms)`,
  silence.abandons.length >= 1 && silence.abandons[0] <= 1000 + SAMPLE_MAX_AGE_MS + HOLD_BEAT_MS
);

// ⚠️ RAIL 2. An ordinary press.
const tap = run(
  [...frames(0, 990, 0), { at: 1000, pressed: 1, ageMs: 10 }, ...frames(1010, 1290, 1), ...frames(1300, 2000, 0)],
  FAN_HOLD_MS
);
check("⚠️  press, release at 300 ms — never fires", tap.fires.length === 0);

// ⚠️ RAIL 3. A hold that was really made.
const hold = run(
  [...frames(0, 990, 0), { at: 1000, pressed: 1, ageMs: 10 }, ...frames(1010, 2300, 1), ...frames(2310, 3000, 0)],
  FAN_HOLD_MS
);
check(`⚠️  a 1.3 s hold fires exactly once (at ${hold.fires[0]} ms)`, hold.fires.length === 1);
check(
  "…while the button is still down, not on the release",
  hold.fires.length === 1 && hold.fires[0] < 2310 && hold.fires[0] >= 1000 + FAN_HOLD_MS
);

const realPresses: [string, number, number, number][] = [
  ["the longest ENTER press in the archive", LONGEST_ENTER_PRESS_MS, FAN_HOLD_MS, 0],
  ["the median handlebar press", 140, FAN_HOLD_MS, 0],
  ["the longest ORDINARY cancel press", LONGEST_ORDINARY_CANCEL_PRESS_MS, WAYPOINT_HOLD_MS, 0],
  ["the 0.940 s cancel press from the hazard experiment", LONGEST_CANCEL_PRESS_ANYWHERE_MS, WAYPOINT_HOLD_MS, 0],
  ["one millisecond short of the fan threshold", FAN_HOLD_MS - 1, FAN_HOLD_MS, 0],
  ["one millisecond short of the waypoint threshold", WAYPOINT_HOLD_MS - 1, WAYPOINT_HOLD_MS, 0],
  ["a deliberate 10 s hold", 10_000, FAN_HOLD_MS, 1],
];
for (const [what, durationMs, holdMs, expected] of realPresses) {
  const outcome = run(
    [
      ...frames(0, 990, 0),
      { at: 1000, pressed: 1, ageMs: 10 },
      ...frames(1010, 1000 + durationMs, 1),
      ...frames(1010 + durationMs, 1010 + durationMs + 500, 0),
    ],
    holdMs
  );
  check(`${what} (${durationMs} ms) fires ${expected}×`, outcome.fires.length === expected);
}

const twoHolds = run(
  [
    ...frames(0, 990, 0),
    { at: 1000, pressed: 1, ageMs: 10 },
    ...frames(1010, 2400, 1),
    ...frames(2410, 3000, 0),
    { at: 3010, pressed: 1, ageMs: 10 },
    ...frames(3020, 4400, 1),
    ...frames(4410, 5000, 0),
  ],
  FAN_HOLD_MS
);
check("two holds in a row are two gestures, not one and not three", twoHolds.fires.length === 2);

const midPress = run([...frames(0, 3000, 1), ...frames(3010, 3500, 0)], FAN_HOLD_MS);
check("⚠️  a service that starts mid-press has not watched a press, and never fires", midPress.fires.length === 0);

const neverArrived = run(frames(0, 5000, null), FAN_HOLD_MS);
check("a button that has never arrived is not a release and fires nothing", neverArrived.fires.length === 0);

// A stall INSIDE a genuine hold: the sample goes stale, the press is abandoned, and the
// bus coming back does not hand it a hold it can no longer prove.
const stalled = run(
  [
    ...frames(0, 990, 0),
    { at: 1000, pressed: 1, ageMs: 10 },
    ...beats(1100, 1600, 1, 1000),
    ...frames(1610, 2400, 1),
    ...frames(2410, 3000, 0),
  ],
  FAN_HOLD_MS
);
check(
  "a hold interrupted by a stall is abandoned rather than completed on the far side",
  stalled.fires.length === 0 && stalled.abandons.length >= 1
);

// --- 2. The fan cycle, pure -----------------------------------------------------

console.log("\n2. one hold, one step round the cycle");

function inputs(overrides: Partial<FanGestureInputs> = {}): FanGestureInputs {
  return { mode: "automatic", targetPercent: 0, speedKmh: 0, ...overrides };
}

check("automatic + stopped → off, which is the quiet state", nextFanGestureAction(inputs()) === "off");
check(
  "off (manual at 0 %) → manual 100 %",
  nextFanGestureAction(inputs({ mode: "manual", targetPercent: 0 })) === "full"
);
check(
  "manual 100 % → automatic",
  nextFanGestureAction(inputs({ mode: "manual", targetPercent: MAX_DUTY_PERCENT })) === "automatic"
);
check(
  "a manual duty the SLIDER left → automatic, not a fourth state",
  nextFanGestureAction(inputs({ mode: "manual", targetPercent: 45 })) === "automatic"
);
check("fun mode → automatic", nextFanGestureAction(inputs({ mode: "fun" })) === "automatic");
check(
  "⚠️  automatic while MOVING skips off and goes to manual 100 % — loud is the safe side",
  nextFanGestureAction(inputs({ speedKmh: 5 })) === "full"
);
check(
  "⚠️  …and so does an unknown speed, so *off* needs proof rather than the absence of it",
  nextFanGestureAction(inputs({ speedKmh: null })) === "full"
);
check(
  "a NaN target never reads as a stopped fan",
  nextFanGestureAction(inputs({ mode: "manual", targetPercent: Number.NaN })) === "automatic"
);
check(
  `${STATIONARY_MAX_KMH} km/h is stationary and ${STATIONARY_MAX_KMH + 0.1} km/h is not`,
  isStationary(STATIONARY_MAX_KMH) && !isStationary(STATIONARY_MAX_KMH + 0.1)
);
check(
  "null, NaN and a negative speed are all NOT stationary",
  !isStationary(null) && !isStationary(Number.NaN) && !isStationary(-5)
);

// --- 3. The fan cycle, end to end -----------------------------------------------

console.log("\n3. the cycle against a real loop and a recording bridge");

defineSignals(SIGNALS);

interface PwmCall {
  method: "duty" | "output" | "bridge";
  value: number | boolean;
}
const calls: PwmCall[] = [];
const recording: FanPwm = {
  channelPath: "/sys/class/pwm/pwmchipFAKE/pwm0",
  setDutyPercent: async percent => {
    calls.push({ method: "duty", value: percent });
  },
  setOutputEnabled: async on => {
    calls.push({ method: "output", value: on });
  },
  setBridgeEnabled: async on => {
    calls.push({ method: "bridge", value: on });
  },
};

const TICK_MS = 20;
const bus = { enter: 0, cancel: 0, speedKmh: 0, throttlePercent: 0, go: 0 };
const busTimer = setInterval(() => {
  record("btn_mode_enter", bus.enter);
  record("btn_indicator_cancel", bus.cancel);
  record("speed_can_kmh", bus.speedKmh);
  record("throttle_pct", bus.throttlePercent);
  record("go", bus.go);
  record("batt_temp_hi", 20);
}, TICK_MS);

async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/** One hold of a button, at its SHIPPED length plus a beat, then a release. */
async function holdButton(button: "enter" | "cancel", holdMs: number): Promise<void> {
  bus[button] = 1;
  record(button === "enter" ? "btn_mode_enter" : "btn_indicator_cancel", 1);
  await settle(holdMs + HOLD_BEAT_MS * 2);
  bus[button] = 0;
  record(button === "enter" ? "btn_mode_enter" : "btn_indicator_cancel", 0);
  await settle(TICK_MS * 4);
}

const controller = await startFanControl({ enabled: true, openPwm: async () => recording });
const automatic = startFanAutomatic(controller, { tickMs: TICK_MS, speedMaxAgeMs: 400, chargeSessionMaxAgeMs: 400 });
const fanCycle = startFanCycleGesture(automatic, { revertBeatMs: 50 });
const gestures = startHoldGestures([fanCycle.gesture, waypointHoldGesture()]);
await settle(TICK_MS * 4);

check("a fresh loop is in automatic", automatic.mode() === "automatic");

await holdButton("enter", FAN_HOLD_MS);
check(
  `⚠️  hold 1, bike stopped: automatic → off (mode ${automatic.mode()}, ${controller.state().targetPercent} %)`,
  automatic.mode() === "manual" && controller.state().targetPercent === 0 && !controller.state().driverEnabled
);

await holdButton("enter", FAN_HOLD_MS);
check(
  `hold 2: off → manual ${MAX_DUTY_PERCENT} %`,
  automatic.mode() === "manual" && controller.state().targetPercent === MAX_DUTY_PERCENT
);

await holdButton("enter", FAN_HOLD_MS);
check("hold 3: manual 100 % → automatic, closing the cycle", automatic.mode() === "automatic");
check("…and the dashboard is told", latestValue("fan_auto_mode") === FAN_MODE_CODE.automatic);

// An ordinary press must do nothing at all, on the real wiring rather than in §1.
const beforeTap = automatic.mode();
bus.enter = 1;
record("btn_mode_enter", 1);
await settle(LONGEST_ENTER_PRESS_MS);
bus.enter = 0;
record("btn_mode_enter", 0);
await settle(TICK_MS * 6);
check(
  `⚠️  a ${LONGEST_ENTER_PRESS_MS} ms press — the longest ever recorded — changes nothing`,
  automatic.mode() === beforeTap
);

// Moving: the cycle degrades to the two-state toggle.
bus.speedKmh = 5;
record("speed_can_kmh", 5);
await settle(TICK_MS * 4);
await holdButton("enter", FAN_HOLD_MS);
check(
  `⚠️  a hold at ${bus.speedKmh} km/h skips *off* and goes to manual ${MAX_DUTY_PERCENT} %`,
  automatic.mode() === "manual" && controller.state().targetPercent === MAX_DUTY_PERCENT
);

// The revert: *off* must not follow the rider onto a road.
bus.speedKmh = 0;
record("speed_can_kmh", 0);
await settle(TICK_MS * 4);
await holdButton("enter", FAN_HOLD_MS);
check("back to automatic, ready to be switched off again", automatic.mode() === "automatic");
await holdButton("enter", FAN_HOLD_MS);
check("the fan is off with the bike stopped", automatic.mode() === "manual" && controller.state().targetPercent === 0);
bus.speedKmh = 5;
record("speed_can_kmh", 5);
await settle(250);
check("⚠️  the bike moving above 3 km/h takes *off* back to automatic", automatic.mode() === "automatic");

// ⚠️ …but only the *off* THIS gesture commanded. A duty the rider chose with the slider
// is a deliberate instruction that has always survived until the bike is switched off.
bus.speedKmh = 0;
record("speed_can_kmh", 0);
await settle(TICK_MS * 4);
await automatic.commandManualDuty(0);
bus.speedKmh = 5;
record("speed_can_kmh", 5);
await settle(250);
check(
  "⚠️  a manual 0 the SLIDER set is NOT reverted by riding away — only the gesture's own is",
  automatic.mode() === "manual" && controller.state().targetPercent === 0
);

// A bus that goes quiet with the fan off must leave it off: that silence is an AC charge,
// which is the whole reason the state exists.
//
// The mode is put back to automatic through the endpoint's own call first, because the
// slider left the fan at manual 0 above and one hold from there is `full`, not `off`.
bus.speedKmh = 0;
record("speed_can_kmh", 0);
await automatic.setMode("automatic");
await settle(TICK_MS * 4);
await holdButton("enter", FAN_HOLD_MS);
check(
  "the gesture has the fan off again, with the bike stopped",
  automatic.mode() === "manual" && controller.state().targetPercent === 0
);
clearInterval(busTimer);
await settle(SAMPLE_MAX_AGE_MS + 300);
check(
  "⚠️  a bus that goes SILENT with the fan off leaves it off — that silence is the dinner",
  automatic.mode() === "manual" && controller.state().targetPercent === 0
);

gestures.stop();
fanCycle.stop();
automatic.stop();
await controller.stop();

// --- 3b. A stop that FAILS still has to be watched -------------------------------
//
// ⚠️ src/fan/control.ts's goIdle() sets the target to 0 and drops the output BEFORE a
// failing sysfs write can throw, and commandDuty() turns that into `{ok: false}` rather
// than an exception. So a refusal can still leave the fan genuinely stopped — and if the
// watchdog is armed only on success, that is a fan switched off by a gesture with nothing
// left watching for the bike moving again. Arm it on the attempt instead.

console.log("\n3b. a stop the bridge refused is still a stopped fan");

const stubbornState: FanState = { dutyPercent: 0, targetPercent: 0, driverEnabled: false, phase: "idle" };
const failingStopController: FanController = {
  configured: true,
  fault: null,
  setDutyPercent: async percent => {
    if (percent < MIN_RUNNING_DUTY_PERCENT) {
      // Exactly what goIdle() leaves behind when one of its writes fails: the fan IS off.
      stubbornState.targetPercent = 0;
      stubbornState.dutyPercent = 0;
      stubbornState.driverEnabled = false;
      stubbornState.phase = "idle";
      return { ok: false, message: "could not stop the fan: pinctrl vanished" };
    }
    stubbornState.targetPercent = percent;
    stubbornState.dutyPercent = percent;
    stubbornState.driverEnabled = true;
    stubbornState.phase = "running";
    return { ok: true, message: `commanded ${percent} %` };
  },
  state: () => stubbornState,
  stop: async () => {},
};

const stubbornBus = setInterval(() => {
  record("btn_mode_enter", stubbornPress);
  record("speed_can_kmh", stubbornSpeed);
  record("batt_temp_hi", 20);
}, TICK_MS);
let stubbornPress = 0;
let stubbornSpeed = 0;
const stubbornLoop = startFanAutomatic(failingStopController, {
  tickMs: TICK_MS,
  speedMaxAgeMs: 400,
  chargeSessionMaxAgeMs: 400,
});
const stubbornCycle = startFanCycleGesture(stubbornLoop, { revertBeatMs: 50 });
const stubbornGestures = startHoldGestures([stubbornCycle.gesture]);
await settle(TICK_MS * 4);

// ⚠️ One tap first, and it is not padding. src/can/signals.ts notifies only when a value
// MOVES, so re-recording the 0 this button already holds from §3 raises no event and this
// second runner would never see the 0 that a watched 0→1 needs. On the bike the first
// 0x102 frame after boot is the first record of that key and does notify; here the store
// is already warm. The tap is 100 ms, far too short to fire anything.
stubbornPress = 1;
record("btn_mode_enter", 1);
await settle(100);
stubbornPress = 0;
record("btn_mode_enter", 0);
await settle(TICK_MS * 4);

stubbornPress = 1;
record("btn_mode_enter", 1);
await settle(FAN_HOLD_MS + HOLD_BEAT_MS * 2);
stubbornPress = 0;
record("btn_mode_enter", 0);
await settle(TICK_MS * 4);
check(
  "the hold stopped the fan even though the bridge refused",
  stubbornLoop.mode() === "manual" && failingStopController.state().targetPercent === 0
);
stubbornSpeed = 5;
record("speed_can_kmh", 5);
await settle(250);
check(
  "⚠️  …and riding away STILL hands it back — the watchdog is armed on the attempt, not on the reply",
  stubbornLoop.mode() === "automatic"
);
clearInterval(stubbornBus);
stubbornGestures.stop();
stubbornCycle.stop();
stubbornLoop.stop();

// --- 4. The waypoint --------------------------------------------------------------

console.log("\n4. the waypoint hold saves through the endpoint's own path");

const fixes = startWaypointFixTracking();
const noFix = saveWaypointNow();
check(`no GPS fix at all is refused (${noFix.message})`, !noFix.saved && noFix.refusal === WAYPOINT_REFUSAL.NO_FIX);

record("gps_lat", 57.7, Date.now());
record("gps_lon", 11.97, Date.now());
await settle(20);
const saved = saveWaypointNow();
check(`a fresh fix saves (${saved.message})`, saved.saved && saved.sequence === 1 && waypointsSaved() === 1);
check("…and the position reaches the log as its own signals", latestValue("waypoint_lat") === 57.7);

// ⚠️ The 2026-08-09 defect: a waypoint carrying longitude 130.30 while the next gps_lon
// row read 13.04. Nothing about the fix itself is out of range — it is a valid longitude
// — so only the distance from the fix before it can catch this.
await settle(MIN_FIX_INTERVAL_MS + 50);
record("gps_lon", 130.3, Date.now());
await settle(20);
const jumped = saveWaypointNow();
check(
  `⚠️  a fix 8 000 km from the one before it is refused (${jumped.message})`,
  !jumped.saved && jumped.refusal === WAYPOINT_REFUSAL.FIX_IMPLAUSIBLE
);
check(
  "…and the refusal is on the wire as a counter and a code",
  latestValue("waypoint_refusal") === WAYPOINT_REFUSAL.FIX_IMPLAUSIBLE
);
check(
  "…and the counter is what moves, so two identical refusals are two banners",
  latestValue("waypoint_refused_seq") === 2
);

const refusalBounds = boundsFor("waypoint_refusal", "", "waypoint");
for (const [name, code] of Object.entries(WAYPOINT_REFUSAL)) {
  check(
    `WAYPOINT_REFUSAL.${name} = ${code} is inside its bound and has a sentence for the rider`,
    refusalBounds !== null &&
      code >= refusalBounds[0] &&
      code <= refusalBounds[1] &&
      typeof WAYPOINT_REFUSAL_TEXT[code] === "string" &&
      WAYPOINT_REFUSAL_TEXT[code].length > 0
  );
}
check(
  "no sentence is left over from a code that has been removed",
  Object.keys(WAYPOINT_REFUSAL_TEXT).every(code => Object.values(WAYPOINT_REFUSAL).includes(Number(code) as never))
);
check(
  "the counters are deliberately NOT bounded — a monotonic count has no ceiling worth naming",
  boundsFor("waypoint_seq", "", "waypoint") === null && boundsFor("waypoint_refused_seq", "", "waypoint") === null
);
fixes.stop();

// --- 4b. The banner the phone raises ----------------------------------------------
//
// ⚠️ THE REGRESSION THIS SECTION EXISTS FOR. `waypoint_seq` and `waypoint_refused_seq`
// are onDemand: they are absent from the signal store entirely until the Pi saves or
// refuses something. An announcement that treats "the first value I ever saw" as the
// baseline therefore swallows the banner for the FIRST waypoint of every boot — which,
// at roughly one waypoint a ride, is most of them, and is the exact regression the two
// signals were added to prevent.

console.log("\n4b. the banner is raised for real news and swallowed for a reconnect");

const fresh = { value: null, baselined: false };
const openedWithNothing = foldAnnouncement(fresh, null);
check(
  "a link that comes up with the signal ABSENT is baselined silently",
  !openedWithNothing.announce && openedWithNothing.state.baselined
);
check(
  "⚠️  …and the first value that then arrives IS announced — the first waypoint of a boot",
  foldAnnouncement(openedWithNothing.state, 1).announce
);
const openedWithFive = foldAnnouncement(fresh, 5);
check(
  "a link that comes back to a snapshot already holding 5 announces nothing — that is old news",
  !openedWithFive.announce && openedWithFive.state.value === 5
);
check("…and an unchanged 5 afterwards is not news either", !foldAnnouncement(openedWithFive.state, 5).announce);
check("…while 6 is", foldAnnouncement(openedWithFive.state, 6).announce);
check(
  "a signal that goes away again announces nothing rather than announcing a null",
  !foldAnnouncement(openedWithFive.state, null).announce
);
check(
  "the fan's four keys are distinct, so every step of the cycle raises its own banner",
  new Set([
    fanAnnouncementKey(FAN_MODE_CODE.automatic, 0),
    fanAnnouncementKey(FAN_MODE_CODE.fun, 0),
    fanAnnouncementKey(FAN_MODE_CODE.manual, MAX_DUTY_PERCENT),
    fanAnnouncementKey(FAN_MODE_CODE.manual, 0),
  ]).size === 4
);
check(
  "⚠️  the curve moving the duty through zero in AUTOMATIC raises nothing",
  fanAnnouncementKey(FAN_MODE_CODE.automatic, 0) === fanAnnouncementKey(FAN_MODE_CODE.automatic, 84)
);
check(
  "…and a slider drag inside the running band raises nothing either",
  fanAnnouncementKey(FAN_MODE_CODE.manual, 45) === fanAnnouncementKey(FAN_MODE_CODE.manual, 60)
);
check(
  `the gesture's own step names the duty off the wire (${fanAnnouncementText(fanAnnouncementKey(FAN_MODE_CODE.manual, MAX_DUTY_PERCENT), MAX_DUTY_PERCENT)})`,
  fanAnnouncementText(fanAnnouncementKey(FAN_MODE_CODE.manual, MAX_DUTY_PERCENT), MAX_DUTY_PERCENT) ===
    `Fan: manual ${MAX_DUTY_PERCENT} %`
);

// --- 5. The thresholds, against the corpus ----------------------------------------

console.log("\n5. every threshold clears what the bike actually does");

check(
  `the fan hold (${FAN_HOLD_MS} ms) clears the longest ENTER press ever recorded (${LONGEST_ENTER_PRESS_MS} ms)`,
  FAN_HOLD_MS > LONGEST_ENTER_PRESS_MS * 4
);
check(
  `the waypoint hold (${WAYPOINT_HOLD_MS} ms) clears the longest ordinary cancel press (${LONGEST_ORDINARY_CANCEL_PRESS_MS} ms) 3×`,
  WAYPOINT_HOLD_MS > LONGEST_ORDINARY_CANCEL_PRESS_MS * 3
);
check(
  `…and still clears the ${LONGEST_CANCEL_PRESS_ANYWHERE_MS} ms press from the hazard experiment`,
  WAYPOINT_HOLD_MS > LONGEST_CANCEL_PRESS_ANYWHERE_MS
);
check(
  `⚠️  the waypoint hold fires before the hazards can come on (${EARLIEST_HAZARD_ACTIVATION_MS} ms earliest observed)`,
  WAYPOINT_HOLD_MS < EARLIEST_HAZARD_ACTIVATION_MS - 500
);
check(
  `the staleness window (${SAMPLE_MAX_AGE_MS} ms) is far past the worst gap inside a real press (${LONGEST_GAP_INSIDE_A_PRESS_MS} ms)`,
  SAMPLE_MAX_AGE_MS > LONGEST_GAP_INSIDE_A_PRESS_MS * 20
);
check(
  "a gesture fires within one beat of its threshold",
  HOLD_BEAT_MS <= FAN_HOLD_MS / 10 && HOLD_BEAT_MS <= WAYPOINT_HOLD_MS / 10
);
check("the browser's surviving double-click window is untouched by all this", DOUBLE_CLICK_WINDOW_MS === 700);

// --- 6. What the gestures are bound to ---------------------------------------------

console.log("\n6. both gestures are bound to registered, deadband-free button bits");

/**
 * ⚠️ The one binding that must never happen — the cruise ON/OFF switch, whose two presses
 * in the corpus both armed cruise control 0.53 s later.
 */
const FORBIDDEN_BINDING = "btn_cruise_enable";
const defined = new Map(SIGNALS.map(signal => [signal.key, signal]));
const bound: [string, string][] = [
  ["the fan cycle", FAN_GESTURE_BUTTON],
  ["the waypoint", WAYPOINT_GESTURE_BUTTON],
];
for (const [role, key] of bound) {
  const signal = defined.get(key);
  check(`${role} is bound to ${key}, which is a registered signal`, signal !== undefined);
  check(`…in the buttons group`, signal?.group === "buttons");
  // signals.ts logs a change only when it EXCEEDS the deadband, so any deadband ≥ 1 on a
  // 0/1 signal stops the notifications after the first sample and the gesture never fires.
  check(`…with no deadband`, !signal?.deadband);
  check(`…and it is not ${FORBIDDEN_BINDING}`, (key as string) !== FORBIDDEN_BINDING);
}
check("the two gestures are on different buttons", (FAN_GESTURE_BUTTON as string) !== WAYPOINT_GESTURE_BUTTON);
check(`the plausibility gate agrees with bounds.js about a plausible speed`, MAX_PLAUSIBLE_KMH === 300);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ a press followed by 20 minutes of silence never fires, a 300 ms press never fires, and a 1.3 s");
  console.log("  hold fires exactly once while the thumb is still down; the longest ENTER press and the longest");
  console.log("  ordinary cancel press ever recorded both fire nothing; the cycle walks automatic → off → 100 %");
  console.log("  → automatic against a real loop, skips *off* above 3 km/h, reverts its OWN off when the bike");
  console.log("  moves but never the slider's, and leaves the fan off when the bus goes quiet; and a waypoint");
  console.log("  8 000 km from the fix before it is refused with a code the phone can read");
}
