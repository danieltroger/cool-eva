// When the wifi recovery runs, how far it goes, and what a handlebar hold does.
// docs/wifi.md §4 has the failure it exists for; scripts/check-wifi-diag.ts covers the
// logging half that #291 shipped.
//
// Everything asserted here is pure — src/wifi/ladder.ts decides, src/wifi/recover.ts
// acts — so the whole escalation is walkable with no radio, no nmcli and no bike.

import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue } from "../src/can/signals.ts";
import { HOLD_BEAT_MS } from "../src/gestures/runner.ts";
import { HOLD_OUTCOME, SAMPLE_MAX_AGE_MS, newHoldState, observeHold } from "../src/gestures/long-press.ts";
import { WIFI_LINK_STATE } from "../src/wifi/parse.ts";
import { WIFI_FAULT_DUMP_AFTER_MS, WIFI_POLL_MS } from "../src/wifi/status.ts";
import {
  CONNECTED_POLLS_TO_FORGIVE,
  REJOIN_BACKOFF_MINUTES,
  REJOIN_CONFIRM_WINDOW_MS,
  REJOIN_OUTCOME,
  afterAttempt,
  backoffMs,
  decideGesture,
  faultHeldMs,
  foldPoll,
  newFaultClock,
  shouldRecoverNow,
  type FaultClock,
} from "../src/wifi/ladder.ts";
import {
  WIFI_GESTURE_BUTTON,
  WIFI_GESTURE_MAX_KMH,
  WIFI_HOLD_MS,
  WIFI_SPEED_MAX_AGE_MS,
  republishRejoin,
} from "../src/wifi/recover.ts";
import { fallbackBoundsFor } from "../public/lib/bounds-rules.js";
import { isPlausible } from "../public/lib/bounds.js";

let failures = 0;

function check(what: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${what}`);
  } else {
    // ⚠️ stderr AND an exit code: a mutation harness that greps stdout for "FAILED"
    // reports a false green on a check whose failures only ever went to stdout.
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** Walks a sequence of polls through the fault clock, one poll per WIFI_POLL_MS. */
function walk(
  polls: readonly { linkState: number | null; hotspotSeen: boolean }[],
  startMs = 0
): { clock: FaultClock; nowMs: number } {
  let clock = newFaultClock();
  let nowMs = startMs;
  for (const poll of polls) {
    clock = foldPoll(clock, { linkState: poll.linkState as never, hotspotSeen: poll.hotspotSeen, nowMs });
    nowMs += WIFI_POLL_MS;
  }
  return { clock, nowMs };
}

const FAULT = { linkState: WIFI_LINK_STATE.DISCONNECTED, hotspotSeen: true };
const OUT_OF_RANGE = { linkState: WIFI_LINK_STATE.DISCONNECTED, hotspotSeen: false };
const UP = { linkState: WIFI_LINK_STATE.CONNECTED, hotspotSeen: true };
const ACTIVATING = { linkState: WIFI_LINK_STATE.CONNECTING, hotspotSeen: true };

// --- 1. The fault clock: three states, told apart -------------------------------------

console.log("\n1. the fault clock");

const faultPolls = Math.ceil(WIFI_FAULT_DUMP_AFTER_MS / WIFI_POLL_MS) + 1;
const held = walk(Array(faultPolls).fill(FAULT));
check("a sustained fault accumulates time", (faultHeldMs(held.clock, held.nowMs) ?? 0) >= WIFI_FAULT_DUMP_AFTER_MS);
check("…and the watchdog fires", shouldRecoverNow(held.clock, held.nowMs, WIFI_FAULT_DUMP_AFTER_MS));

const brief = walk([FAULT, FAULT]);
check("a brief fault does not fire", !shouldRecoverNow(brief.clock, brief.nowMs, WIFI_FAULT_DUMP_AFTER_MS));

// ⚠️ THE CASE THAT BITES. A bike parked out of range must not bank fault time it never
// spent trying, then fire on the first poll the hotspot reappears — racing NM's own
// autoconnect, which recovers in seconds.
const parkedAway = walk([...Array(faultPolls).fill(OUT_OF_RANGE), FAULT]);
check(
  "time spent OUT OF RANGE is not banked as fault time",
  (faultHeldMs(parkedAway.clock, parkedAway.nowMs) ?? 0) < WIFI_FAULT_DUMP_AFTER_MS
);
check(
  "…so the first poll the hotspot reappears does not fire a ladder",
  !shouldRecoverNow(parkedAway.clock, parkedAway.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);

// ⚠️ Our own `connection up` shows as CONNECTING. If that cleared the clock, the backoff
// would restart on every attempt and the escalation could never advance.
const midAttempt = walk([...Array(faultPolls).fill(FAULT), ACTIVATING]);
check("an attempt in flight (CONNECTING) does not clear the clock", midAttempt.clock.faultSince !== null);

const recovered = walk([...Array(faultPolls).fill(FAULT), UP]);
check("a connection clears the clock", recovered.clock.faultSince === null);
check("…and the fault is no longer held", faultHeldMs(recovered.clock, recovered.nowMs) === null);

// --- 2. The backoff, and what forgives it ---------------------------------------------

console.log("\n2. the backoff");

check(
  "the first attempt waits for nothing but the fault threshold",
  shouldRecoverNow(held.clock, held.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);
const attempted = afterAttempt(held.clock, held.nowMs);
check(
  "straight after an attempt, another is refused",
  !shouldRecoverNow(attempted, held.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);
check(
  "…and still refused one second short of the backoff",
  !shouldRecoverNow(attempted, held.nowMs + backoffMs(0) - 1000, WIFI_FAULT_DUMP_AFTER_MS)
);
check(
  "…and allowed once it has elapsed",
  shouldRecoverNow(attempted, held.nowMs + backoffMs(0), WIFI_FAULT_DUMP_AFTER_MS)
);
check("the backoff grows", backoffMs(0) < backoffMs(1) && backoffMs(1) < backoffMs(2));
check("…and is capped rather than running away", backoffMs(99) === backoffMs(REJOIN_BACKOFF_MINUTES.length - 1));
// ⚠️ The backoff is a SAFETY property: every attempt that reaches an association failure
// spends one of connection.auth-retries, and exhausting that budget is what CREATES the
// latch. It must never collapse to "retry immediately, for ever".
check("the shortest wait is minutes, not seconds", backoffMs(0) >= 60_000);

// ⚠️ ONE poll of CONNECTED is a flap. Forgiving on it would pin the backoff at its floor
// for the whole of a flapping episode — the trouble most likely to be flapping.
let flapping = held.clock;
flapping = afterAttempt(flapping, held.nowMs);
const flapStep = flapping.attempts;
flapping = foldPoll(flapping, { ...UP, nowMs: held.nowMs + WIFI_POLL_MS });
check("a one-poll connection does NOT forgive the backoff", flapping.attempts === flapStep);
flapping = foldPoll(flapping, { ...UP, nowMs: held.nowMs + 2 * WIFI_POLL_MS });
check(`…but ${CONNECTED_POLLS_TO_FORGIVE} consecutive polls do`, flapping.attempts === 0);
check("…and the next fault may act at once", flapping.lastAttemptAt === null);

// --- 3. The rejoin cadence is NOT the dump cadence -------------------------------------

console.log("\n3. cadence");

// ⚠️ #291 rate-limited its dump to one per 15 minutes. If the rejoin had inherited that,
// a 20-minute outage would get exactly ONE attempt.
let outage = held.clock;
let outageNow = held.nowMs;
let attempts = 0;
for (let minute = 0; minute < 20; minute += 1) {
  if (shouldRecoverNow(outage, outageNow, WIFI_FAULT_DUMP_AFTER_MS)) {
    attempts += 1;
    outage = afterAttempt(outage, outageNow);
  }
  outageNow += 60_000;
  outage = foldPoll(outage, { ...FAULT, nowMs: outageNow });
}
check(`a 20-minute outage gets more than one attempt (got ${attempts})`, attempts >= 3);
check("…and not an unbounded number of them", attempts <= 8);

// --- 4. What a hold does -------------------------------------------------------------

console.log("\n4. the guard rule");

check("link DOWN, first hold: recover", decideGesture(WIFI_LINK_STATE.DISCONNECTED, null).rejoin);
check("…and it does not need arming first", !decideGesture(WIFI_LINK_STATE.DISCONNECTED, null).arm);
// ⚠️ The case the window exists for: a curious hold while the rider is watching a working
// dashboard must not drop the link they are watching it on.
check("link UP, first hold: dump only", !decideGesture(WIFI_LINK_STATE.CONNECTED, null).rejoin);
check("…and it arms the window", decideGesture(WIFI_LINK_STATE.CONNECTED, null).arm);
check("link UP, second hold inside the window: recover", decideGesture(WIFI_LINK_STATE.CONNECTED, 1000).rejoin);
check(
  "…at the exact boundary it is NOT confirmed",
  !decideGesture(WIFI_LINK_STATE.CONNECTED, REJOIN_CONFIRM_WINDOW_MS).rejoin
);
check(
  "link UP, second hold after the window: dump only, re-armed",
  !decideGesture(WIFI_LINK_STATE.CONNECTED, REJOIN_CONFIRM_WINDOW_MS + 1).rejoin &&
    decideGesture(WIFI_LINK_STATE.CONNECTED, REJOIN_CONFIRM_WINDOW_MS + 1).arm
);
check("an unknown link state is treated as down", decideGesture(null, null).rejoin);
check(
  "EVERY hold dumps, whatever else it does",
  [null, 0, REJOIN_CONFIRM_WINDOW_MS + 1].every(armed => decideGesture(WIFI_LINK_STATE.CONNECTED, armed).dump)
);

// --- 5. One hold is one action --------------------------------------------------------

console.log("\n5. one hold, one action");

// ⚠️ THE FIXTURE IS THE PRESS THAT NEARLY DISQUALIFIED THE BUTTON: 29 664 ms, session 200,
// 2026-09-19, at 0.0 km/h (docs/handlebar-gestures.md). Replayed through the SHIPPED
// recogniser it must fire exactly ONCE — with the `fired` latch broken it is one per beat.
const LONG_PRESS_MS = 29_664;
let state = newHoldState();
let fires = 0;
state = observeHold(state, { pressed: 0, sampleAgeMs: 0, nowMs: 0, holdMs: WIFI_HOLD_MS }).state;
for (let at = 0; at <= LONG_PRESS_MS; at += HOLD_BEAT_MS) {
  const folded = observeHold(state, { pressed: 1, sampleAgeMs: 0, nowMs: at, holdMs: WIFI_HOLD_MS });
  state = folded.state;
  if (folded.outcome === HOLD_OUTCOME.FIRED) {
    fires += 1;
  }
}
check(`the real 29 664 ms press fires exactly once (got ${fires})`, fires === 1);
check("…and it fires at all", fires > 0);

let shortState = newHoldState();
let shortFires = 0;
shortState = observeHold(shortState, { pressed: 0, sampleAgeMs: 0, nowMs: 0, holdMs: WIFI_HOLD_MS }).state;
for (let at = 0; at <= 1706; at += HOLD_BEAT_MS) {
  const folded = observeHold(shortState, { pressed: 1, sampleAgeMs: 0, nowMs: at, holdMs: WIFI_HOLD_MS });
  shortState = folded.state;
  if (folded.outcome === HOLD_OUTCOME.FIRED) {
    shortFires += 1;
  }
}
// The longest btn_set_back press in the ride log apart from the 29.7 s one.
check("the next-longest recorded press (1706 ms) fires nothing", shortFires === 0);

// --- 6. The button, and the thresholds it is argued from ------------------------------

console.log("\n6. the binding and its evidence");

const signal = SIGNALS.find(entry => entry.key === WIFI_GESTURE_BUTTON);
check(`${WIFI_GESTURE_BUTTON} is a registered signal`, signal !== undefined);
check("…in the buttons group", signal?.group === "buttons");
// A deadband ≥ 1 on a 0/1 signal stops the change notifications after the first sample,
// and the gesture would never fire.
check("…with no deadband", !signal?.deadband);

// Capture archive, 268 files, 14 854 432 frames of 0x400.
const CAPTURE_MAX_MS = 300;
const CAPTURE_PRESSES = 15;
// rides.db as imported 2026-09-19 18:15 — ⚠️ the mtime is part of the claim, because this
// corpus is re-imported by other work and the figure moved once already.
const RIDE_LOG_MAX_MS = 29_664;
const RIDE_LOG_PRESSES = 131;
check(
  `5000 ms clears the capture archive's longest press (${CAPTURE_MAX_MS} ms over ${CAPTURE_PRESSES})`,
  WIFI_HOLD_MS > CAPTURE_MAX_MS
);
// ⚠️ NOT clear of the ride log's longest, and that is stated rather than hidden. One press
// in 146 reaches it, at 0.0 km/h, so no threshold and no speed gate excludes it. What
// carries the button is the COST of a false fire: one dump, and a rejoin only when the
// link is already down. docs/handlebar-gestures.md.
check(`…and does NOT clear the ride log's ${RIDE_LOG_MAX_MS} ms press, which is known`, WIFI_HOLD_MS < RIDE_LOG_MAX_MS);
check("the ride-log corpus is the larger one, so it is the one that governs", RIDE_LOG_PRESSES > CAPTURE_PRESSES);

// ⚠️ SAMPLE_MAX_AGE_MS is argued in long-press.ts from 0x102's worst frame gap of 14 ms.
// This is the first gesture on 0x400, whose worst intra-press gap across all 129 archive
// presses is 160.2 ms — so the margin that governs is 3.12x, not 0x102's 35x.
const WORST_0X400_GAP_MS = 160.2;
check(
  `the 0x400 frame gap (${WORST_0X400_GAP_MS} ms) is inside SAMPLE_MAX_AGE_MS`,
  WORST_0X400_GAP_MS < SAMPLE_MAX_AGE_MS
);
check("…with at least 3x of margin", SAMPLE_MAX_AGE_MS / WORST_0X400_GAP_MS >= 3);

// --- 7. The stationary gate ------------------------------------------------------------

console.log("\n7. the stationary gate");

// ⚠️ ZERO, not the fan's 15: nothing about a wifi dump is useful while moving. Supported
// rather than arbitrary — speed_can_kmh reads exactly 0 in 317 780 of 317 780 frames of
// the 2026-08-08 AC session.
check("the gesture's ceiling is its own constant, not the fan's 15", WIFI_GESTURE_MAX_KMH === 0);
check("a stale speed reading is refused, so the gate fails closed", WIFI_SPEED_MAX_AGE_MS === SAMPLE_MAX_AGE_MS);

// --- 8. The new signals ---------------------------------------------------------------

console.log("\n8. the recovery's signals");

for (const key of ["wifi_rejoin_seq", "wifi_rejoin_outcome"]) {
  const entry = SIGNALS.find(item => item.key === key);
  check(`${key} is registered`, entry !== undefined);
  if (entry === undefined) {
    continue;
  }
  check(`…in the wifi group`, entry.group === "wifi");
  // ⚠️ Resolved from the REGISTRY ENTRY, never spelled: boundsFor() short-circuits on the
  // generated per-key table and is inert on group, so only fallbackBoundsFor sees a move.
  check(`…whose group reaches no fallback rule`, fallbackBoundsFor(entry.key, entry.unit, entry.group) === null);
  // ⚠️ NOT onDemand. They move only on a recovery, but status.ts re-records them every
  // poll so the group is never permanently part-dark — the property #291 created it for.
  check(`…and is not onDemand, so the group's liveness stays honest`, entry.onDemand === undefined);
}
const outcome = SIGNALS.find(item => item.key === "wifi_rejoin_outcome");
check(
  "every REJOIN_OUTCOME code is plausible",
  outcome !== undefined &&
    Object.values(REJOIN_OUTCOME).every(code => isPlausible(outcome.key, code, outcome.unit, outcome.group))
);
// ⚠️ The republish itself, driven rather than inspected. status.ts calls this on EVERY
// poll so the group is never permanently part-dark; a mutation that drops the call leaves
// both keys unwritten and turns this red. Without it the whole property was unreachable
// from any check and only the comment claimed it.
defineSignals(SIGNALS);
check("before any recovery, the rejoin keys are unwritten", latestValue("wifi_rejoin_seq") === null);
republishRejoin();
check("republishRejoin() writes the counter", latestValue("wifi_rejoin_seq") === 0);
check("…and the outcome", latestValue("wifi_rejoin_outcome") === REJOIN_OUTCOME.NONE);

const seq = SIGNALS.find(item => item.key === "wifi_rejoin_seq");
check(
  "…and a second recovery is still plausible on the counter",
  seq !== undefined && isPlausible(seq.key, 2, seq.unit, seq.group)
);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ time spent out of range is never banked as fault time, an attempt in flight cannot reset the");
  console.log("  clock that paces attempts, and one poll of CONNECTED does not forgive the backoff a flapping");
  console.log("  link earned; a 20-minute outage gets several attempts rather than the one a 15-minute dump");
  console.log("  gap would have allowed; a hold on a working link dumps and arms rather than dropping it; and");
  console.log("  the real 29 664 ms press — the one that nearly disqualified this button — fires exactly once.");
}
