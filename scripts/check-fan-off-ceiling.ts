import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue, onChange, record, type LiveValue } from "../src/can/signals.ts";
import { FAN_MODE_CODE, startFanAutomatic } from "../src/fan/auto.ts";
import { startFanControl } from "../src/fan/control.ts";
import type { FanPwm } from "../src/fan/pwm.ts";
import {
  FAN_OFF_CEILING_KMH,
  STATIONARY_MAX_AGE_MS,
  isBelowOffCeiling,
  nextFanGestureAction,
} from "../src/fan/gesture.ts";
import {
  FAN_OFF_BEAT_MS,
  FAN_OFF_REVERT_HOLD_MS,
  FAN_OFF_STATE,
  startFanCycleGesture,
} from "../src/fan/gesture-runner.ts";
import { apply, peek, valueOf } from "../public/lib/store.js";
import { foldFanAnnouncement } from "../public/lib/announce.js";
import { FAN_OFF_CEILING_KMH as BROWSER_CEILING_KMH, FAN_OFF_STATE_CODE } from "../public/lib/fan-display.js";

// The fan's *off* step at a creep, and the hand-back when the creep becomes a departure.
//
//   node --experimental-strip-types scripts/check-fan-off-ceiling.ts
//
// ⚠️ WHAT THIS IS GUARDING is Daniel's two cases from day 2 of the trip: a toll queue
// where he silenced the fan to hear the booth and then rolled forward, and a hotel
// forecourt where he silenced it while manoeuvring. Both crept, and at the old 3 km/h
// ceiling both put the fan straight back to full. So *off* is now enterable to 15 km/h and
// handed back only once the bike has been ABOVE it continuously — a duration, not a second
// speed, because a duration is the only thing that separates a shunt in a queue from
// riding away. docs/fan-control.md §"The handlebar gesture".
//
// ⚠️ The safety property moved with it and the checks below are where that is priced: a
// hold that fires at 14 km/h now silences the fan. §5 keeps the road speeds out.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

defineSignals(SIGNALS);

/** The bridge, stubbed. Every assertion is on the loop's state or on the wire. */
const recording: FanPwm = {
  channelPath: "/sys/class/pwm/pwmchipFAKE/pwm0",
  setDutyPercent: async () => {},
  setOutputEnabled: async () => {},
  setBridgeEnabled: async () => {},
};

const TICK_MS = 20;
const LOOP_OPTIONS = { tickMs: 60_000, speedMaxAgeMs: 400, chargeSessionMaxAgeMs: 400 };
/** The creep Daniel described: rolling forward in a queue, well under the ceiling. */
const CREEP_KMH = [5, 9, 12];
/** Riding away. Above the ceiling by enough that no rounding argument is involved. */
const DEPARTURE_KMH = 20;

/**
 * The longest a hand-back may take once the bike is genuinely riding away.
 *
 * ⚠️ A LITERAL, and deliberately not `FAN_OFF_REVERT_HOLD_MS + FAN_OFF_BEAT_MS * 2`. A
 * budget computed from the constants under test widens with them, so it cannot notice
 * either of them moving — the same shape of mistake as a filter that selects for the
 * property it is about to conclude. 3 500 ms is the shipped 2 000 ms hold plus a beat plus
 * a second of slack for a loaded machine, written down rather than derived.
 */
const PROMPT_MS = 3_500;

const batches: Record<string, LiveValue>[] = [];
onChange(changed => batches.push({ ...changed }));

let memory: { value: string | null; baselined: boolean; offState?: number | null } = {
  value: null,
  baselined: false,
  offState: null,
};

/** The phone, replayed one patch at a time — store.js's own apply(), announce.js's own fold. */
function drainBanners(): string[] {
  const raised: string[] = [];
  for (const signals of batches.splice(0)) {
    apply({ type: "patch", ts: Date.now(), signals });
    const folded = foldFanAnnouncement(
      memory,
      valueOf("fan_auto_mode"),
      valueOf("fan_target_pct"),
      peek("fan_off_state")
    );
    memory = folded.state;
    if (folded.banner !== null) {
      raised.push(folded.banner);
    }
  }
  return raised;
}

/** Which batch first carried a key, or -1. §6 is an order between two of these. */
function batchIndexOf(collected: Record<string, LiveValue>[], key: string): number {
  return collected.findIndex(signals => key in signals);
}

function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The bus. `speed_can_kmh` has a 500 ms freshness window and *off* is unreachable without
// a fresh sample, so it is re-recorded continuously rather than once per phase.
const bus = { speedKmh: 0, packC: 42 };
const busTimer = setInterval(() => {
  record("speed_can_kmh", bus.speedKmh);
  record("batt_temp_hi", bus.packC);
}, TICK_MS);

/**
 * Two holds: automatic → manual 100 % → off. The cycle's direction is the rider's, so
 * *off* is never one hold from automatic — ../src/fan/gesture.ts argues why.
 */
async function silenceTheFan(gesture: { perform: () => Promise<string> }): Promise<void> {
  await gesture.perform();
  await settle(TICK_MS * 3);
  await gesture.perform();
  await settle(TICK_MS * 3);
}

/**
 * Sets a speed and holds it for a stated DURATION.
 *
 * ⚠️ One duration and not a (beats, beatMs) pair. The pair multiplied, so five call sites
 * passing `beats: 0` silently asked for 40 ms of excursion while their labels said 200,
 * 240 and 750 — and two assertions about the hysteresis clock were green whether the clock
 * restarted or accumulated, because two 40 ms blips cannot sum past any hold worth having.
 */
async function rideAt(speedKmh: number, forMs: number): Promise<void> {
  bus.speedKmh = speedKmh;
  record("speed_can_kmh", speedKmh);
  await settle(forMs + TICK_MS * 2);
}

// --- 1. The toll booth, at the SHIPPED constants ----------------------------------
//
// ⚠️ The one section that runs at the real 2 000 ms hold and the real 500 ms beat.
// Everything below turns them down, and if nothing ran at the shipped values then
// reverting the beat to its old 2 000 ms would stop being detectable at all.

console.log("\n1. the toll booth, at the shipped beat and hold");

const controller = await startFanControl({ enabled: true, openPwm: async () => recording });
const automatic = startFanAutomatic(controller, LOOP_OPTIONS);
const cycle = startFanCycleGesture(automatic);
await settle(TICK_MS * 3);
await automatic.setMode("automatic");
await settle(TICK_MS * 3);

// Stopped in the queue: automatic → full → off.
await silenceTheFan(cycle.gesture);
check(
  "stopped in the queue, the cycle reaches *off*",
  automatic.mode() === "manual" && controller.state().targetPercent === 0
);
check("…and the wire says whose *off* it is", latestValue("fan_off_state") === FAN_OFF_STATE.ARMED);

// The queue shuffles forward. Every one of these is above the OLD 3 km/h ceiling, so
// every one of them used to put the fan back to full before the rider reached the booth.
for (const speedKmh of CREEP_KMH) {
  await rideAt(speedKmh, FAN_OFF_BEAT_MS * 2);
  check(
    `⚠️  creeping at ${speedKmh} km/h — the fan is STILL off (this is the bug #205 is about)`,
    automatic.mode() === "manual" && controller.state().targetPercent === 0
  );
}

// Through the booth and away. Measured rather than waited out, because the LATENCY is the
// assertion: bounded below by the hold and above by the hold plus the beat's own phase.
//
// ⚠️ The upper bound is what makes the beat load-bearing. With only "it eventually handed
// back", reverting FAN_OFF_BEAT_MS to the 2 000 ms it used to be goes undetected — the
// hand-back just lands later, somewhere between 2 and 4 s, and nothing notices. That is
// the whole reason the beat had to shrink: a 2 000 ms sampler cannot measure a 2 000 ms
// window. This is measured on Date.now() and not since(), because it is the check's own
// stopwatch over real setTimeout time rather than anything the Pi reasons about.
const departedAt = Date.now();
bus.speedKmh = DEPARTURE_KMH;
record("speed_can_kmh", DEPARTURE_KMH);
while (automatic.mode() !== "automatic" && Date.now() - departedAt < PROMPT_MS * 3) {
  await settle(TICK_MS);
}
const handBackMs = Date.now() - departedAt;
check(
  `⚠️  riding away at ${DEPARTURE_KMH} km/h hands the fan back to automatic (after ${handBackMs} ms)`,
  automatic.mode() === "automatic"
);
check(
  `…no sooner than the ${FAN_OFF_REVERT_HOLD_MS} ms hold, and promptly (${handBackMs} ms, budget ${PROMPT_MS} ms)`,
  handBackMs >= FAN_OFF_REVERT_HOLD_MS && handBackMs <= PROMPT_MS
);
cycle.stop();
automatic.stop();
await controller.stop();
bus.speedKmh = 0;
batches.splice(0);

// --- 2. The hysteresis, on its own ------------------------------------------------
//
// ⚠️ THE ASSERTION THAT GOES RED IF THE HOLD IS DELETED. A shunt forward in a queue
// crosses the ceiling briefly; riding away does not stop crossing it. Nothing but a
// duration tells those apart, which is why this is not a second speed threshold.

console.log("\n2. a blip over the ceiling is not riding away");

const FAST_BEAT_MS = 20;
const SHORT_HOLD_MS = 400;
const blipController = await startFanControl({ enabled: true, openPwm: async () => recording });
const blipLoop = startFanAutomatic(blipController, LOOP_OPTIONS);
const blipCycle = startFanCycleGesture(blipLoop, { revertBeatMs: FAST_BEAT_MS, revertHoldMs: SHORT_HOLD_MS });
await settle(TICK_MS * 3);
await blipLoop.setMode("automatic");
await settle(TICK_MS * 3);
await silenceTheFan(blipCycle.gesture);
check("the fan is off at the kerb", blipLoop.mode() === "manual" && blipController.state().targetPercent === 0);

// Over the ceiling, but for less than the hold, then back down.
await rideAt(DEPARTURE_KMH, SHORT_HOLD_MS / 2);
await rideAt(CREEP_KMH[0], FAST_BEAT_MS * 3);
check(
  `⚠️  a ${SHORT_HOLD_MS / 2} ms blip over ${FAN_OFF_CEILING_KMH} km/h (hold is ${SHORT_HOLD_MS} ms) does NOT hand the fan back`,
  blipLoop.mode() === "manual" && blipController.state().targetPercent === 0
);
check("…and the wire still says the gesture has it", latestValue("fan_off_state") === FAN_OFF_STATE.ARMED);

// ⚠️ And the clock restarts rather than accumulating: two blips that add up to more than
// the hold, separated by a creep, must still not hand back.
await rideAt(DEPARTURE_KMH, SHORT_HOLD_MS * 0.6);
await rideAt(CREEP_KMH[1], FAST_BEAT_MS * 3);
await rideAt(DEPARTURE_KMH, SHORT_HOLD_MS * 0.6);
await rideAt(CREEP_KMH[1], FAST_BEAT_MS * 3);
check(
  "⚠️  two blips that SUM past the hold still do not — the clock restarts, it does not accumulate",
  blipLoop.mode() === "manual" && blipController.state().targetPercent === 0
);

// Sustained, and it goes back.
await rideAt(DEPARTURE_KMH, SHORT_HOLD_MS * 4);
check("sustained over the ceiling hands it back", blipLoop.mode() === "automatic");
blipCycle.stop();
blipLoop.stop();
await blipController.stop();
bus.speedKmh = 0;
batches.splice(0);

// --- 3. A silent bus mid-excursion ------------------------------------------------
//
// ⚠️ A null CLEARS the mark rather than letting it accumulate: the hold measures PROVEN
// sustained motion and silence proves nothing. It is the same polarity as the staleness
// rule the watchdog already had — an AC charge silences the bus for up to 23.7 minutes,
// which is the dinner *off* exists for, so failing closed here would start the fan in the
// middle of it.

console.log("\n3. a bus that goes quiet mid-excursion");

const quietController = await startFanControl({ enabled: true, openPwm: async () => recording });
const quietLoop = startFanAutomatic(quietController, LOOP_OPTIONS);
// ⚠️ A hold LONGER than the freshness window, and that is the point of the number rather
// than impatience. A sample stays usable for STATIONARY_MAX_AGE_MS after the bus stops, so
// a hold shorter than that window could be completed by the silence itself — the
// stale-but-still-fresh reading carrying the excursion over the line. The shipped pair has
// the same ordering (2 000 ms hold against a 500 ms window), which is what makes "silence
// interrupts an excursion" true on the bike; §3 keeps that relationship rather than
// shrinking both and losing it.
const SILENT_HOLD_MS = STATIONARY_MAX_AGE_MS * 3;
const quietCycle = startFanCycleGesture(quietLoop, { revertBeatMs: FAST_BEAT_MS, revertHoldMs: SILENT_HOLD_MS });
await settle(TICK_MS * 3);
await quietLoop.setMode("automatic");
await settle(TICK_MS * 3);
await silenceTheFan(quietCycle.gesture);
check("the fan is off", quietLoop.mode() === "manual" && quietController.state().targetPercent === 0);

// Above the ceiling for most of the hold, then the bus stops saying anything at all.
await rideAt(DEPARTURE_KMH, SILENT_HOLD_MS * 0.2);
clearInterval(busTimer);
await settle(STATIONARY_MAX_AGE_MS * 2);
check(
  "⚠️  the bus going silent mid-excursion leaves the fan OFF — that silence is the charge",
  quietLoop.mode() === "manual" && quietController.state().targetPercent === 0
);
const resumedBus = setInterval(() => {
  record("speed_can_kmh", bus.speedKmh);
  record("batt_temp_hi", bus.packC);
}, TICK_MS);
// …and the clock restarted, so the remaining 30 % of the hold is not enough on its own.
await rideAt(DEPARTURE_KMH, SILENT_HOLD_MS * 0.5);
check(
  "⚠️  …and the clock RESTARTED — what was left of the hold before the silence does not count",
  quietLoop.mode() === "manual"
);
await rideAt(DEPARTURE_KMH, SILENT_HOLD_MS * 4);
check("a full hold after the bus returns does hand it back", quietLoop.mode() === "automatic");
quietCycle.stop();
quietLoop.stop();
await quietController.stop();
bus.speedKmh = 0;
batches.splice(0);

// --- 4. The banners ---------------------------------------------------------------

console.log("\n4. the two sentences the rider reads");

const wordController = await startFanControl({ enabled: true, openPwm: async () => recording });
const wordLoop = startFanAutomatic(wordController, LOOP_OPTIONS);
const wordCycle = startFanCycleGesture(wordLoop, { revertBeatMs: FAST_BEAT_MS, revertHoldMs: SHORT_HOLD_MS });
await settle(TICK_MS * 3);
await wordLoop.setMode("automatic");
await settle(TICK_MS * 3);
drainBanners();

// The *full* step first and its banner discarded — §1 of check-fan-banner.ts owns that
// wording; what this section is about is the step after it.
await wordCycle.gesture.perform();
await settle(TICK_MS * 3);
drainBanners();
await wordCycle.gesture.perform();
await settle(TICK_MS * 3);
const offBanner = drainBanners();
check(
  `⚠️  entering *off* promises what it will survive (${JSON.stringify(offBanner)})`,
  offBanner.length === 1 && offBanner[0] === `Fan: off until ${FAN_OFF_CEILING_KMH} km/h`
);

await rideAt(DEPARTURE_KMH, SHORT_HOLD_MS * 4);
const movedBanner = drainBanners();
check(
  `⚠️  the hand-back says the BIKE did it, not the rider (${JSON.stringify(movedBanner)})`,
  movedBanner.length === 1 && movedBanner[0] === "Fan: automatic (moving)"
);

// ⚠️ …and it is one-shot. `fan_off_state` returns to NOT_ARMED one batch behind the mode,
// so a later arrival at automatic — the fun gate closing, say — must say plain "automatic".
bus.speedKmh = 0;
record("speed_can_kmh", 0);
await settle(TICK_MS * 3);
drainBanners();
await wordLoop.setMode("manual");
await settle(TICK_MS * 3);
drainBanners();
await wordLoop.setMode("automatic");
await settle(TICK_MS * 3);
const laterBanner = drainBanners();
check(
  `⚠️  a LATER arrival at automatic does not claim the bike moved (${JSON.stringify(laterBanner)})`,
  laterBanner.length === 1 && laterBanner[0] === "Fan: automatic"
);

// ⚠️ The one-shot, driven at the fold rather than through the loop — ON PURPOSE. In the
// live flow `fan_off_state` is back to NOT_ARMED one batch after the hand-back, so nothing
// end-to-end can ever present a STALE MOVED and the guard would sit there untested and
// green. This is the world where the Pi stops clearing it: the same MOVED read twice, and
// only the first arrival at automatic may claim the bike did it.
const armed = { value: "manual-stopped", baselined: true, offState: FAN_OFF_STATE.ARMED };
const firstArrival = foldFanAnnouncement(armed, FAN_MODE_CODE.automatic, 0, FAN_OFF_STATE.MOVED);
check(
  `⚠️  a MOVED that is news words the hand-back (${firstArrival.banner})`,
  firstArrival.banner === "Fan: automatic (moving)"
);
const backToManual = foldFanAnnouncement(firstArrival.state, FAN_MODE_CODE.manual, 60, FAN_OFF_STATE.MOVED);
const secondArrival = foldFanAnnouncement(backToManual.state, FAN_MODE_CODE.automatic, 0, FAN_OFF_STATE.MOVED);
check(
  `⚠️  …and the SAME MOVED read again does not claim it twice (${secondArrival.banner})`,
  secondArrival.banner === "Fan: automatic"
);

// The slider's own 0 makes no promise, because nothing is watching it.
await wordLoop.commandManualDuty(0);
await settle(TICK_MS * 3);
const sliderOff = drainBanners();
check(
  `⚠️  the SLIDER's own 0 says plain "off" — only the gesture's carries the ceiling (${JSON.stringify(sliderOff)})`,
  sliderOff.length === 1 && sliderOff[0] === "Fan: off"
);
wordCycle.stop();
wordLoop.stop();
await wordController.stop();
batches.splice(0);

// --- 5. Entering: the ceiling, and the road speeds that must stay out --------------

console.log("\n5. what may and may not reach *off*");

check(
  `${FAN_OFF_CEILING_KMH} km/h may be silenced and ${FAN_OFF_CEILING_KMH + 0.1} km/h may not`,
  isBelowOffCeiling(FAN_OFF_CEILING_KMH) && !isBelowOffCeiling(FAN_OFF_CEILING_KMH + 0.1)
);
check(
  "⚠️  fail-closed is unchanged: absent, NaN and negative speeds all refuse *off*",
  !isBelowOffCeiling(null) && !isBelowOffCeiling(Number.NaN) && !isBelowOffCeiling(-5)
);

// ⚠️ A NEW assertion, not a re-pointed one — nothing pinned this before. The five ENTER
// presses in the capture archive that were made while moving, quoted from
// docs/can-decode-findings.md § "bit 2 — MODE ENTER" rather than rounded from memory.
// None may reach *off* at the new ceiling.
const PRESSES_MADE_WHILE_MOVING_KMH = [47.0, 52.2, 88.0, 93.6, 118.1];
for (const speedKmh of PRESSES_MADE_WHILE_MOVING_KMH) {
  check(
    `a hold at ${speedKmh} km/h — one of the five recorded — cannot reach *off*`,
    nextFanGestureAction({ mode: "manual", targetPercent: 100, speedKmh }) === "automatic"
  );
}

// --- 6. The ordering the banners depend on ----------------------------------------
//
// ⚠️ #199's invariant, applied to the new signal: whatever WORDS a banner must reach the
// phone no later than whatever MOVES its key. Asserted as an order between batch indices
// and never as equality — ../src/can/signals.ts clears `pending` before it calls the
// listeners, so a record() made from inside one always opens the NEXT batch, and an
// equality here would go red on correct code.

console.log("\n6. the wording never arrives after the key it words");

const orderController = await startFanControl({ enabled: true, openPwm: async () => recording });
const orderLoop = startFanAutomatic(orderController, LOOP_OPTIONS);
const orderCycle = startFanCycleGesture(orderLoop, { revertBeatMs: FAST_BEAT_MS, revertHoldMs: SHORT_HOLD_MS });
await settle(TICK_MS * 3);
await orderLoop.setMode("automatic");
await settle(TICK_MS * 3);
await orderCycle.gesture.perform();
await settle(TICK_MS * 3);
batches.splice(0);
await orderCycle.gesture.perform();
await settle(TICK_MS * 3);
const armBatches = [...batches];
const armedAt = batchIndexOf(armBatches, "fan_off_state");
const targetAt = batchIndexOf(armBatches, "fan_target_pct");
check(
  `⚠️  ARMED is on the wire before the duty that moves the key (state in batch ${armedAt}, duty in ${targetAt})`,
  armedAt >= 0 && targetAt >= 0 && armedAt <= targetAt
);

batches.splice(0);
await rideAt(DEPARTURE_KMH, SHORT_HOLD_MS * 4);
const revertBatches = [...batches];
const movedAt = batchIndexOf(revertBatches, "fan_off_state");
const modeAt = batchIndexOf(revertBatches, "fan_auto_mode");
check(
  `⚠️  MOVED is in the mode's own batch or earlier (state in batch ${movedAt}, mode in ${modeAt})`,
  movedAt >= 0 && modeAt >= 0 && movedAt <= modeAt
);
orderCycle.stop();
orderLoop.stop();
await orderController.stop();
bus.speedKmh = 0;
batches.splice(0);

// ⚠️ THE OTHER HALF OF THE ASYMMETRY. `record(ARMED)` sits before the awaited command and
// `armRevert()` after it, and only the first half is pinned above. Arming EARLY has its
// own hazard: the beat would start while the duty is still on its way down, see a target
// that is not yet 0, conclude somebody else has the fan and disarm — leaving a stopped fan
// with nothing watching for the bike moving again.
//
// A bridge that takes its time plus a beat far shorter than it is what makes that visible:
// with the arming after the command there is no beat between the two, and with it before
// there are several.
const slowBridge = await startFanControl({
  enabled: true,
  openPwm: async () => ({
    ...recording,
    setBridgeEnabled: () => new Promise<void>(resolve => setTimeout(resolve, TICK_MS * 4)),
  }),
});
const slowLoop = startFanAutomatic(slowBridge, LOOP_OPTIONS);
const slowCycle = startFanCycleGesture(slowLoop, { revertBeatMs: 5, revertHoldMs: SHORT_HOLD_MS });
await settle(TICK_MS * 3);
await slowLoop.setMode("automatic");
await settle(TICK_MS * 3);
await silenceTheFan(slowCycle.gesture);
check(
  "⚠️  a slow bridge does not let the watchdog disarm itself mid-stop — armed AFTER the command",
  latestValue("fan_off_state") === FAN_OFF_STATE.ARMED
);
check("…and the fan really is stopped behind it", slowBridge.state().targetPercent === 0);
slowCycle.stop();
slowLoop.stop();
await slowBridge.stop();
batches.splice(0);

// --- 7. The slider taking the fan off the gesture ----------------------------------
//
// ⚠️ src/http/fan.ts calls the loop directly and tells the gesture nothing, so before the
// subscription in ./gesture-runner.ts a drag from 0 up and back to 0 — seven commands a
// second — fitted entirely inside one beat: the watchdog stayed armed over a duty a thumb
// had chosen, and the phone promised a ceiling on the rider's own 0.
//
// ⚠️ It works through ./control.ts's unconditional publish(): a drag 0 → 45 takes the
// fromRest branch, and that line is the only thing putting the new target on the wire.
// Delete it and this section stops disarming.

console.log("\n7. a slider drag through zero takes the fan off the gesture");

const dragController = await startFanControl({ enabled: true, openPwm: async () => recording });
const dragLoop = startFanAutomatic(dragController, LOOP_OPTIONS);
const dragCycle = startFanCycleGesture(dragLoop, { revertBeatMs: 60_000, revertHoldMs: SHORT_HOLD_MS });
await settle(TICK_MS * 3);
await dragLoop.setMode("automatic");
await settle(TICK_MS * 3);
await silenceTheFan(dragCycle.gesture);
check("the gesture has the fan off", latestValue("fan_off_state") === FAN_OFF_STATE.ARMED);

// The drag, inside what used to be one beat: the watchdog's own beat is 60 s here, so only
// the subscription can possibly notice.
await dragLoop.commandManualDuty(45);
await dragLoop.commandManualDuty(0);
await settle(TICK_MS * 3);
check(
  "⚠️  the drag took the fan off the gesture — no beat could have noticed at a 60 s beat",
  latestValue("fan_off_state") === FAN_OFF_STATE.NOT_ARMED
);
const dragBanners = drainBanners();
check(
  `⚠️  …so the last word is a plain "off", not a promise about a 0 the thumb set (${JSON.stringify(dragBanners)})`,
  dragBanners.length > 0 && dragBanners[dragBanners.length - 1] === "Fan: off"
);
// And riding away does not take back a duty the rider chose by hand.
await rideAt(DEPARTURE_KMH, SHORT_HOLD_MS * 4);
check(
  "⚠️  riding away does NOT revert the slider's 0 — only the gesture's own",
  dragLoop.mode() === "manual" && dragController.state().targetPercent === 0
);
dragCycle.stop();
dragLoop.stop();
await dragController.stop();
clearInterval(resumedBus);
batches.splice(0);

// --- 8. The two copies, and the loop that has no fan -------------------------------

console.log("\n8. the browser's copies, and the loop with no fan");

check(`the browser's ceiling is the Pi's (${BROWSER_CEILING_KMH} km/h)`, BROWSER_CEILING_KMH === FAN_OFF_CEILING_KMH);
check(
  "the browser's FAN_OFF_STATE codes are the Pi's",
  FAN_OFF_STATE_CODE.NOT_ARMED === FAN_OFF_STATE.NOT_ARMED &&
    FAN_OFF_STATE_CODE.ARMED === FAN_OFF_STATE.ARMED &&
    FAN_OFF_STATE_CODE.MOVED === FAN_OFF_STATE.MOVED
);
check(
  `⚠️  the beat (${FAN_OFF_BEAT_MS} ms) is fine enough to MEASURE the hold ` +
    `(${FAN_OFF_REVERT_HOLD_MS} ms) — at least two beats have to fit inside it`,
  FAN_OFF_BEAT_MS * 2 <= FAN_OFF_REVERT_HOLD_MS
);
check(
  `⚠️  the hold (${FAN_OFF_REVERT_HOLD_MS} ms) outlasts the speed's freshness window ` +
    `(${STATIONARY_MAX_AGE_MS} ms) — or a silent bus could complete a hand-back by itself`,
  FAN_OFF_REVERT_HOLD_MS > STATIONARY_MAX_AGE_MS
);
check("…and the bound in bounds.js reaches the widest of them", FAN_OFF_STATE.MOVED === 2 && FAN_MODE_CODE.fun === 2);

// ⚠️ The retry branch: MOVED is recorded before setMode() and the hand-back is retried
// every beat when it is refused. That is only safe because record() seals a value that
// MOVED — so a refused hand-back writes one row, not one per beat. On a live loop the
// branch is unreachable at all, because switchMode("automatic") returns ok unconditionally;
// this pins that, so the day it can fail the retry's cost is a known quantity.
const liveController = await startFanControl({ enabled: true, openPwm: async () => recording });
const liveLoop = startFanAutomatic(liveController, LOOP_OPTIONS);
await settle(TICK_MS * 3);
const handBack = await liveLoop.setMode("automatic");
check("switchMode(automatic) cannot fail on a live loop, so the retry branch is unreachable", handBack.ok);
liveLoop.stop();
await liveController.stop();

// ⚠️ And the loop with no fan driver at all: its setMode never publishes a mode, so the
// same-batch property is false there by construction. It cannot reach *off* — its
// controller refuses every duty — but "cannot happen" is exactly what has to be loud.
const inert = await startFanControl({ enabled: false });
const inertLoop = startFanAutomatic(inert, LOOP_OPTIONS);
const inertOutcome = await inertLoop.setMode("automatic");
check("a Pi with no fan driver refuses the mode rather than claiming it", !inertOutcome.ok);
check("…and its controller refuses a duty, so the cycle cannot reach *off* there", !(await inert.setDutyPercent(0)).ok);
inertLoop.stop();
await inert.stop();

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ the fan stays off through a 5, 9 and 12 km/h creep and hands back only after the bike has been");
  console.log(
    `  above ${FAN_OFF_CEILING_KMH} km/h for ${FAN_OFF_REVERT_HOLD_MS} ms — a blip does not, two blips that sum past it do not,`
  );
  console.log("  and a bus that goes quiet mid-excursion restarts the clock rather than accumulating it. Entering");
  console.log("  says what it will survive and the hand-back says the bike did it, once; the slider's own 0 makes");
  console.log("  no promise and a drag through zero takes the fan off the gesture; and the five ENTER presses");
  console.log("  recorded at 47-118 km/h still cannot reach *off*");
}
