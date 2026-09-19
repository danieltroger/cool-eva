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
import { WIFI_LINK_STATE, type WifiLinkState } from "../src/wifi/parse.ts";
import { WIFI_FAULT_DUMP_AFTER_MS, WIFI_POLL_MS } from "../src/wifi/status.ts";
import {
  CONNECTED_POLLS_TO_FORGIVE,
  HOLD_ACTION,
  decideHold,
  RECOVER_TRIGGER,
  REJOIN_BACKOFF_MINUTES,
  REJOIN_CONFIRM_WINDOW_MS,
  REJOIN_OUTCOME,
  afterAttempt,
  backoffMs,
  decideGesture,
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
  gateAllowsGesture,
  performWifiHold,
  recoverWifi,
  rejoinPublication,
  republishRejoin,
  type LadderEffects,
} from "../src/wifi/recover.ts";
import { fallbackBoundsFor } from "../public/lib/bounds-rules.js";
import { isPlausible } from "../public/lib/bounds.js";
import { WIFI_REJOIN_TEXT } from "../public/lib/announce.js";

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

/**
 * Walks polls through the fault clock, one per WIFI_POLL_MS.
 *
 * ⚠️ Takes a STARTING CLOCK. The previous version always began at `newFaultClock()`,
 * which is the one arrangement in which "time out of range is not banked" cannot fail —
 * nothing had accrued before the absence. A reviewer's probe against the shipped module
 * found a real 10 808 000 ms bank the check was blind to.
 */
function walk(
  polls: readonly { linkState: number | null; hotspotSeen: boolean }[],
  from: FaultClock = newFaultClock(),
  startMs = 0
): { clock: FaultClock; nowMs: number } {
  let clock = from;
  let nowMs = startMs;
  for (const poll of polls) {
    clock = foldPoll(clock, {
      linkState: poll.linkState as WifiLinkState | null,
      hotspotSeen: poll.hotspotSeen,
      nowMs,
    });
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

const faultPolls = Math.ceil(WIFI_FAULT_DUMP_AFTER_MS / WIFI_POLL_MS) + 2;
const held = walk(Array(faultPolls).fill(FAULT));
check("a sustained fault accumulates time", held.clock.heldMs >= WIFI_FAULT_DUMP_AFTER_MS);
check("…and the watchdog fires", shouldRecoverNow(held.clock, held.nowMs, WIFI_FAULT_DUMP_AFTER_MS));

const brief = walk([FAULT, FAULT]);
check("a brief fault does not fire", !shouldRecoverNow(brief.clock, brief.nowMs, WIFI_FAULT_DUMP_AFTER_MS));

// 🚨 THE CASE THE OLD FIXTURE COULD NOT REACH. Starting from a clock that ALREADY holds a
// fault is the whole point: a bike parked out of range after a drop came back with three
// hours banked and fired on the first poll the hotspot reappeared, racing NetworkManager's
// own autoconnect. Starting from newFaultClock() there was nothing to bank.
const alreadyFaulted = walk([FAULT, FAULT]).clock;
const awayThenBack = walk([...Array(1350).fill(OUT_OF_RANGE), FAULT], alreadyFaulted, 1_000_000);
check(
  "three hours OUT OF RANGE add nothing to the accumulated fault time",
  awayThenBack.clock.heldMs < WIFI_FAULT_DUMP_AFTER_MS
);
check(
  "…so the first poll the hotspot reappears does not fire a ladder",
  !shouldRecoverNow(awayThenBack.clock, awayThenBack.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);

// 🚨 AND THE SECOND HALF: a fault that qualified, then went away, must stop qualifying —
// otherwise the accumulated total never falls and the backoff alone paces it, which a
// reviewer measured at 98 ladder runs across a 24-hour absence.
const qualifiedThenAway = walk(Array(200).fill(OUT_OF_RANGE), held.clock, held.nowMs);
check(
  "a qualified fault stops firing once the hotspot is gone",
  !shouldRecoverNow(qualifiedThenAway.clock, qualifiedThenAway.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);
check("…and the accumulated time is kept rather than reset", qualifiedThenAway.clock.heldMs > 0);
check(
  "…and it fires again the moment the fault shape returns",
  (() => {
    const back = walk([FAULT], qualifiedThenAway.clock, qualifiedThenAway.nowMs);
    return shouldRecoverNow(back.clock, back.nowMs, WIFI_FAULT_DUMP_AFTER_MS);
  })()
);

// 🚨 And the narrow version of the same bug: time is added only between two CONSECUTIVE
// fault polls, so a gap that spans a non-fault poll contributes nothing. Without that
// guard a poll loop stalled for hours — a busy event loop, a long dump — would hand the
// next fault poll the whole stall as if it had been spent faulting.
const afterStall = walk([FAULT], walk([OUT_OF_RANGE], brief.clock, brief.nowMs).clock, brief.nowMs + 3 * 3_600_000);
check("a long gap across a non-fault poll is not banked", afterStall.clock.heldMs < WIFI_FAULT_DUMP_AFTER_MS);
check(
  "…so a stalled poll loop cannot trip the watchdog on its first fault poll",
  !shouldRecoverNow(afterStall.clock, afterStall.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);

// ⚠️ Our own `connection up` shows as CONNECTING. If that cleared the accumulated time,
// the backoff would restart on every attempt and the escalation could never advance.
const midAttempt = walk([ACTIVATING], held.clock, held.nowMs);
check("an attempt in flight (CONNECTING) does not clear the accumulated time", midAttempt.clock.heldMs > 0);
check(
  "…but it does not fire either, because the current poll is not in the fault",
  !shouldRecoverNow(midAttempt.clock, midAttempt.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);

const recovered = walk([UP], held.clock, held.nowMs);
check("a connection clears the accumulated time", recovered.clock.heldMs === 0);

// UNAVAILABLE is the radio itself being gone; it suspends like any other non-fault state.
const radioGone = walk(
  Array(50).fill({ linkState: WIFI_LINK_STATE.UNAVAILABLE, hotspotSeen: false }),
  held.clock,
  held.nowMs
);
check(
  "a vanished radio suspends rather than firing",
  !shouldRecoverNow(radioGone.clock, radioGone.nowMs, WIFI_FAULT_DUMP_AFTER_MS)
);

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

// ⚠️ THE MEASUREMENT THAT CHOSE THE BUTTON, pinned — because everything else about the
// binding (registered, in `buttons`, no deadband, not the forbidden cruise-enable, all
// three gestures distinct) is equally true of `btn_cruise_set`, which this hold length
// cannot go on. Presses at or over WIFI_HOLD_MS, both corpora summed; the capture archive
// is 268 files / 14 854 432 frames of 0x400, the ride log is as imported 2026-09-19 18:15.
const PRESSES_AT_OR_OVER_5S = {
  btn_set_back: 1,
  btn_cruise_enable: 2,
  btn_cruise_set: 26,
  btn_heated_grip: 0,
};
const chosen = PRESSES_AT_OR_OVER_5S[WIFI_GESTURE_BUTTON as keyof typeof PRESSES_AT_OR_OVER_5S];
check(`${WIFI_GESTURE_BUTTON} is one of the measured 0x400 buttons`, chosen !== undefined);
// One is accepted and argued from the cost of a false fire; twenty-six is not.
check(`…and reaches ${WIFI_HOLD_MS} ms at most once on record (it is ${chosen})`, chosen <= 1);

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

// 🚨 The POLARITY, which survived a mutation until this existed: it lived inside the
// impure hold, so nothing could drive it. `null` is "we cannot say the bike is stopped",
// which is not permission to act on the radio.
check("a stopped bike may act", gateAllowsGesture(0));
check("a creeping bike may not", !gateAllowsGesture(0.1));
check("a moving bike may not", !gateAllowsGesture(30));
check("a missing reading may not — fail closed", !gateAllowsGesture(null));
check("a NaN reading may not", !gateAllowsGesture(Number.NaN));
check("nor a nonsense negative reading — it is a bad read, not slower than stopped", !gateAllowsGesture(-5));

// 🚨 AND THE CALL TO IT, which is the half a mutation slipped through: extracting the
// predicate left `if (<predicate>)` at an unreachable call site, so replacing that whole
// branch with `if (false)` — a gesture that acts at any speed — stayed green. The gate
// now lives inside decideHold, where the check can drive it.
const UP_STATE = WIFI_LINK_STATE.CONNECTED;
const DOWN_STATE = WIFI_LINK_STATE.DISCONNECTED;
check(
  "moving: the hold is refused outright",
  decideHold(30, DOWN_STATE, null, gateAllowsGesture).action === HOLD_ACTION.REFUSED
);
check("…even creeping", decideHold(0.4, DOWN_STATE, null, gateAllowsGesture).action === HOLD_ACTION.REFUSED);
check("…and on a stale reading", decideHold(null, DOWN_STATE, null, gateAllowsGesture).action === HOLD_ACTION.REFUSED);
check("…and a refusal never arms the window", !decideHold(30, UP_STATE, null, gateAllowsGesture).arm);
check("stopped and down: recover", decideHold(0, DOWN_STATE, null, gateAllowsGesture).action === HOLD_ACTION.RECOVER);
check(
  "stopped and up: dump only, armed",
  (() => {
    const d = decideHold(0, UP_STATE, null, gateAllowsGesture);
    return d.action === HOLD_ACTION.DUMP_ONLY && d.arm;
  })()
);
check(
  "stopped, up, confirmed inside the window: recover",
  decideHold(0, UP_STATE, 1000, gateAllowsGesture).action === HOLD_ACTION.RECOVER
);

// ⚠️ ZERO, not the fan's 15: nothing about a wifi dump is useful while moving. Supported
// rather than arbitrary — speed_can_kmh reads exactly 0 in 317 780 of 317 780 frames of
// the 2026-08-08 AC session.
check("the gesture's ceiling is its own constant, not the fan's 15", WIFI_GESTURE_MAX_KMH === 0);
// ⚠️ Its OWN value, asserted directly and NOT welded to SAMPLE_MAX_AGE_MS. They are both
// 500 ms today, and ../fan/gesture.ts argues at length that a window deciding whether the
// radio may be touched must not move when the button window is retuned for a slower bit.
check("the speed window is 500 ms", WIFI_SPEED_MAX_AGE_MS === 500);
check(
  "…which is not longer than the button window it must not be welded to",
  WIFI_SPEED_MAX_AGE_MS <= SAMPLE_MAX_AGE_MS
);

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
const codes = Object.values(REJOIN_OUTCOME);
// ⚠️ Against the REGISTRY's own declaration, not only through isPlausible(). boundsFor()
// reads the GENERATED table first, and that file is only rewritten when the generator
// runs — so a bound narrowed in registry.ts slips past any assertion that resolves
// through it until `npm test` regenerates. Both are asserted; this one goes red first.
check(
  "the declared bound covers every REJOIN_OUTCOME code",
  outcome?.bounds !== undefined &&
    codes.every(code => code >= (outcome.bounds ?? [0, 0])[0] && code <= (outcome.bounds ?? [0, 0])[1])
);
check(
  "…and so does the bound the dashboard actually resolves",
  outcome !== undefined && codes.every(code => isPlausible(outcome.key, code, outcome.unit, outcome.group))
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

console.log("\n9. the ladder itself, driven through injected effects");

// 🚨 Four mutations survived before this section existed — skipping the dump, disabling
// the shared in-flight flag, and freezing the counter all left every assertion green.
// A safety claim nothing can falsify is not a safety claim.
let dumps = 0;
let activations = 0;
const gate: { release: (() => void) | null } = { release: null };
const slowEffects: LadderEffects = {
  dump: async () => {
    dumps += 1;
    await new Promise<void>(resolve => {
      gate.release = resolve;
    });
    return "/tmp/fake-dump.txt";
  },
  scanShowsHotspot: async () => true,
  activate: async () => {
    activations += 1;
    return { ok: true, profile: "a-profile" };
  },
};
const context = { iface: "wlan0", hotspotSsid: "x", dumpDirectory: "/tmp" };

const first = recoverWifi(context, RECOVER_TRIGGER.WATCHDOG, slowEffects);
// The first ladder is parked inside its dump. A gesture arriving now must be refused.
const second = await recoverWifi(context, RECOVER_TRIGGER.GESTURE, slowEffects);
check("a second trigger during a run is refused", second === REJOIN_OUTCOME.NONE);
check("…and it did NOT start a second dump", dumps === 1);
check("…nor a second activation", activations === 0);
gate.release?.();
const firstOutcome = await first;
check("the first ladder completes", firstOutcome === REJOIN_OUTCOME.REJOINED);
check("rung 0 ran — a recovery always dumps", dumps === 1);
check("…and rung 2 ran after it", activations === 1);
check("the counter advanced", latestValue("wifi_rejoin_seq") === 1);
check("…and the outcome was published", latestValue("wifi_rejoin_outcome") === REJOIN_OUTCOME.REJOINED);

// ⚠️ A failed activation is FAILED even when the scan missed the hotspot: it reached the
// auth path and can spend the connection.auth-retries the backoff exists to protect.
const failing = await recoverWifi(context, RECOVER_TRIGGER.WATCHDOG, {
  dump: async () => "/tmp/fake-dump.txt",
  scanShowsHotspot: async () => false,
  activate: async () => ({ ok: false, profile: "a-profile" }),
});
check("a failed activation reads FAILED, not a range problem", failing === REJOIN_OUTCOME.FAILED);
const noProfile = await recoverWifi(context, RECOVER_TRIGGER.WATCHDOG, {
  dump: async () => "/tmp/fake-dump.txt",
  scanShowsHotspot: async () => true,
  activate: async () => ({ ok: false, profile: null }),
});
check("only a missing profile reads NO_PROFILE", noProfile === REJOIN_OUTCOME.NO_PROFILE);
check("the counter advanced once per run", latestValue("wifi_rejoin_seq") === 3);

// ⚠️ Every outcome the rider can be handed must HAVE a sentence. Without this the phone
// silently shows nothing for a code nobody remembered to word — and NONE is the one code
// that must NOT produce a banner, because it means a trigger was ignored.
for (const [name, code] of Object.entries(REJOIN_OUTCOME)) {
  const said = WIFI_REJOIN_TEXT[code];
  if (code === REJOIN_OUTCOME.NONE) {
    check(`REJOIN_OUTCOME.${name} deliberately has no banner`, said === undefined);
    continue;
  }
  check(`REJOIN_OUTCOME.${name} has a banner`, said !== undefined && said[0].length > 0);
  check(`…with a tone the toast understands`, said !== undefined && (said[1] === "good" || said[1] === "bad"));
}
// ⚠️ And it must not say the wrong thing: code 4 is "no saved profile carries the SSID",
// which an earlier draft worded as a range problem in three separate places.
check(
  "the NO_PROFILE banner does not call it a range problem",
  !(WIFI_REJOIN_TEXT[REJOIN_OUTCOME.NO_PROFILE]?.[0] ?? "").toLowerCase().includes("range")
);

console.log("\n10. one hold, end to end");

// 🚨 The DISPATCH, not just the decision. A mutation collapsing the REFUSED arm — a
// gesture that acts on the radio at any speed — survived until a hold could be driven.
function hold(speed: number | null, link: WifiLinkState | null) {
  const calls = { dumps: 0, recovers: 0 };
  const deps = {
    speedKmh: () => speed,
    speedAgeMs: () => 0,
    linkState: () => link,
    dump: async () => {
      calls.dumps += 1;
      return "/tmp/fake.txt";
    },
    recover: async () => {
      calls.recovers += 1;
      return REJOIN_OUTCOME.REJOINED;
    },
  };
  return { calls, run: () => performWifiHold(deps) };
}

const moving = hold(30, WIFI_LINK_STATE.DISCONNECTED);
const movingSaid = await moving.run();
check("moving: nothing is dumped", moving.calls.dumps === 0);
check("moving: nothing touches the radio", moving.calls.recovers === 0);
check("moving: and the rider is told why", movingSaid.includes("not proven stopped"));

const stale = hold(null, WIFI_LINK_STATE.DISCONNECTED);
await stale.run();
check("a stale speed reading acts on nothing either", stale.calls.dumps === 0 && stale.calls.recovers === 0);

const parkedDown = hold(0, WIFI_LINK_STATE.DISCONNECTED);
await parkedDown.run();
check("parked with the link down: the ladder runs", parkedDown.calls.recovers === 1);

const parkedUp = hold(0, WIFI_LINK_STATE.CONNECTED);
const upSaid = await parkedUp.run();
check("parked with the link UP: it dumps", parkedUp.calls.dumps === 1);
check("…and does NOT touch the link", parkedUp.calls.recovers === 0);
check("…and says how to insist", upSaid.includes("Hold again"));

// The window armed by that hold is what a second one confirms against.
const confirmed = hold(0, WIFI_LINK_STATE.CONNECTED);
await confirmed.run();
check("a second hold inside the window does touch the link", confirmed.calls.recovers === 1);

// The publication is pure, so "the counter always advances" is a property, not a line.
check("rejoinPublication advances the counter", rejoinPublication(7, REJOIN_OUTCOME.REJOINED)[0][1] === 8);
check(
  "…and carries the outcome beside it",
  rejoinPublication(7, REJOIN_OUTCOME.FAILED)[1][1] === REJOIN_OUTCOME.FAILED
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
