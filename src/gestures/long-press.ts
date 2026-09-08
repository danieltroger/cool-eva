// Recognising a handlebar button held on purpose, from samples off the bus.
//
// Pure in the sense ../can/decode.ts is pure: every clock this reasons about is passed
// in, so scripts/check-hold-gestures.ts replays a press sequence through the very
// function the Pi runs. The impure half — the subscription, the beat and the actions —
// is ./runner.ts.
//
// ⚠️ It lives on the Pi rather than on the phone because public/lib/connection.js closes
// the WebSocket whenever the page is hidden, so a phone in a pocket recognises nothing.
// Which gestures sit on which button, what each hold length is measured against, and the
// hazard-light and trip-reset behaviours the bike attaches to these same buttons:
// docs/handlebar-gestures.md.

/**
 * How old a button reading may be and still prove the thumb is still down.
 *
 * ⚠️ THE WHOLE FRESHNESS RULE IS THIS CONSTANT plus the abandon branch below. 0x102
 * broadcasts at ~100 Hz whenever the bus is awake, and the longest gap between two of
 * its frames inside any of the 939 handlebar presses in the archive is 14 ms — so 500 ms
 * is 35× the worst observed and 50 consecutive missed frames.
 *
 * What it is really for: an AC charge silences the bus for up to 23.7 minutes
 * (docs/fan-control.md), and a pressed value left behind by a bus that then went quiet
 * must never be read as a hold. Same window and same argument as ../fan/fun.ts's
 * FUN_GATE_MAX_AGE_MS.
 */
export const SAMPLE_MAX_AGE_MS = 500;

/** What one folded-in sample did. */
export const HOLD_OUTCOME = {
  /** Nothing worth acting on. */
  NONE: "none",
  /** The hold reached its threshold on fresh evidence. Once per press. */
  FIRED: "fired",
  /** A press was open and the bus stopped proving it. It is over, unfired. */
  ABANDONED: "abandoned",
} as const;

export type HoldOutcome = (typeof HOLD_OUTCOME)[keyof typeof HOLD_OUTCOME];

export interface HoldSample {
  /** The button bit as the bus last reported it, or null if it has never arrived. */
  pressed: number | null;
  /** How old that reading is on the monotonic clock, or null if it never arrived. */
  sampleAgeMs: number | null;
  /** monotonicNow(), passed in so this file reads no clock. */
  nowMs: number;
  /** How long this gesture's button must be held. Per gesture, not global. */
  holdMs: number;
}

export interface HoldState {
  /** The previous reading, so a rising edge is one we WATCHED rather than walked in on. */
  previous: number | null;
  /** Monotonic instant of an observed 0→1, or null when no press is open. */
  pressedAt: number | null;
  /** Latched from the fire until the release, so a 10 s hold is one gesture. */
  fired: boolean;
}

export function newHoldState(): HoldState {
  return { previous: null, pressedAt: null, fired: false };
}

/**
 * Folds one reading of the button in, and says what it did.
 *
 * ⚠️ FIRES ON FRESH EVIDENCE ONLY, and never on the release. public/lib/gestures.js's
 * LongPressDetector deliberately did fire on a release — on a stalling link that was the
 * only evidence it would ever get — and here that is the one thing we must not do: a
 * release delivered after a 23-minute bus sleep carries a 23-minute press. The Pi is at
 * the bus at 100 Hz and needs no such fallback.
 *
 * ⚠️ And there is no IMPLAUSIBLE_HOLD_MS. The browser needs one because it measures on
 * the server's wall clock, which ../gps/clock.ts steps by `date -u -s`. Every duration
 * here is monotonic, which a clock step cannot move (../monotonic.ts), so that guard
 * genuinely disappears rather than being dropped for tidiness.
 */
export function observeHold(state: HoldState, sample: HoldSample): { state: HoldState; outcome: HoldOutcome } {
  if (sample.pressed === null || sample.sampleAgeMs === null) {
    // Never arrived. Says nothing about the button, and above all is not a release.
    return { state, outcome: HOLD_OUTCOME.NONE };
  }
  // When the BUS said this, not when we looked. ../fan/auto.ts's sampleTemperature()
  // takes `now - age` for the same reason: the signal store knows exactly when the
  // reading landed, so a beat does not blur a 100 Hz signal into beat-sized buckets.
  const sampleAt = sample.nowMs - sample.sampleAgeMs;
  const stale = sample.sampleAgeMs > SAMPLE_MAX_AGE_MS;

  if (state.pressedAt !== null && stale) {
    // ⚠️ THE RAIL. A press we can no longer see is not a press we may assert, however
    // long ago it started. Delete this branch and "press, then 20 minutes of silence"
    // fires the moment anything looks at it again.
    return { state: { ...state, pressedAt: null, fired: false }, outcome: HOLD_OUTCOME.ABANDONED };
  }

  if (sample.pressed !== 1) {
    return { state: { previous: sample.pressed, pressedAt: null, fired: false }, outcome: HOLD_OUTCOME.NONE };
  }

  let pressedAt = state.pressedAt;
  let fired = state.fired;
  if (state.previous === 0) {
    // A real observed 0→1. A first reading of 1 — the service started mid-press — is
    // not a press we watched, and public/lib/gestures.js draws the line in the same place.
    pressedAt = sampleAt;
    fired = false;
  }
  if (pressedAt !== null && !fired && sampleAt - pressedAt >= sample.holdMs) {
    return { state: { previous: 1, pressedAt, fired: true }, outcome: HOLD_OUTCOME.FIRED };
  }
  return { state: { previous: 1, pressedAt, fired }, outcome: HOLD_OUTCOME.NONE };
}

/** Whether a press is open, so ./runner.ts knows to keep beating at it. */
export function isPressOpen(state: HoldState): boolean {
  return state.pressedAt !== null && !state.fired;
}
