import type { FanMode } from "./auto.ts";

// Which way the fan gesture moves the fan next. Arithmetic and nothing else — a state
// in, an action out, no signal lookups and no clock — so scripts/check-hold-gestures.ts
// can walk the whole cycle without a fan. ./gesture-runner.ts is the half that reads the
// bus and commands.
//
// ⚠️ The next step is DERIVED FROM THE FAN'S LIVE STATE, never from a step counter this
// module keeps. A counter would disagree with the fan the moment the rider touched the
// slider or fun mode ended on its own — and the rider would then hold the button and get
// the wrong third of the cycle. docs/fan-control.md §"The handlebar gesture".

/** The button, and how long it must be held. Both argued in docs/handlebar-gestures.md. */
export const FAN_GESTURE_BUTTON = "btn_mode_enter";

/**
 * ⚠️ 1200 ms, and NOT the 500 ms the waypoint hold uses. The two buttons differ in what
 * the BIKE does with a long press: 160 recorded ENTER presses top out at 0.290 s and it
 * is the only decoded handlebar bit in the CAPTURE archive with no long press anywhere,
 * whereas indicator-cancel lights the hazards somewhere at or before 2.011 s and wants
 * the shorter hold to keep a thumb clear of it.
 *
 * ⚠️ "No long press anywhere" is TRUE OF THAT CORPUS ONLY. The ride log has four ENTER
 * presses at or past this threshold, the longest 4 260 ms, measured 2026-09-10. They are
 * presses made on purpose — for the bike's own dash menu, not for the fan — which is
 * exactly why no hold length can tell them from a fan gesture, and why this constant does
 * not move on account of them. docs/handlebar-gestures.md §"Long ENTER presses in the
 * ride log" has the four, and §"Holding ENTER opens the dash's own reset mode" the
 * collision they land in.
 */
export const FAN_HOLD_MS = 1200;

/**
 * At or below this the fan may be silenced, and above it the gesture's *off* is handed
 * back. Read on BOTH sides, so there is one threshold rather than a band nobody measured.
 *
 * ⚠️ 15 and NOT the bike's own 3. The 3 came from the dash menu, which is stationary-only
 * and exits above 3 km/h — a true fact about the bike that turned out to be answering the
 * wrong question. Daniel, 2026-09-11, from two real cases on day 2: a toll queue where he
 * silenced the fan to hear the booth, and a hotel forecourt where he silenced it while
 * manoeuvring and being talked to. Both crept, both put the fan back to full. Creeping is
 * exactly when the noise matters and exactly what 3 km/h refuses.
 *
 * The hysteresis that keeps a shunt in a queue from tripping the hand-back is a DURATION
 * and not a second speed — ./gesture-runner.ts's FAN_OFF_REVERT_HOLD_MS — so this stays a
 * single number. ⚠️ `speed_can_kmh` reads ~3.5 % high (../can/registry.ts), so 15
 * indicated is about 14.5 true; nothing here needs that precision, but the constant is in
 * indicated km/h like every other speed in this repo.
 *
 * What it costs, stated because it is a safety property moving: a hold that fires at
 * 14 km/h now silences the fan, where before it could not. docs/fan-control.md
 * §"The handlebar gesture" has the bound and the retired 3 km/h rationale.
 */
export const FAN_OFF_CEILING_KMH = 15;

/**
 * How old `speed_can_kmh` may be and still say whether the bike is stopped.
 *
 * ⚠️ Its own constant, and NOT the button window from ../gestures/long-press.ts even
 * though both are 500 ms today. That one is argued from gaps between 0x102 frames; this
 * one decides whether a fan may be switched off under a moving bike, and retuning the
 * button's window for a slower bit must not quietly move this. Same 500 ms and the same
 * fail-closed argument as ./fun.ts's FUN_GATE_MAX_AGE_MS, which asks this exact question
 * of this exact signal; scripts/check-hold-gestures.ts pins the three together.
 */
export const STATIONARY_MAX_AGE_MS = 500;

/** What the gesture does next. `full` is MAX_DUTY_PERCENT, `off` is a manual 0. */
export type FanGestureAction = "automatic" | "full" | "off";

export interface FanGestureInputs {
  /** What ./auto.ts says the mode is. */
  mode: FanMode;
  /** The duty the fan was last asked for. A stop makes this exactly 0 (./control.ts). */
  targetPercent: number;
  /** Fresh `speed_can_kmh`, or null when absent, stale or not finite. */
  speedKmh: number | null;
}

/**
 * One hold, one step round the cycle: manual 100 % → off → automatic → manual 100 %.
 *
 * ⚠️ THE DIRECTION IS THE RIDER'S, not an arbitrary enumeration. He rides with the fan at
 * manual 100 % and drops it when the noise matters, so from his riding state "quiet at the
 * charger" is ONE hold this way round and two the other. That also halves how often the
 * cycle asks for two consecutive holds, which is what walks into the dash's own reset mode
 * — docs/handlebar-gestures.md §"Holding ENTER opens the dash's own reset mode".
 *
 * ⚠️ *Off* needs positive evidence that the bike is under FAN_OFF_CEILING_KMH, so above
 * the ceiling — or with nothing saying how fast the bike is going — the cycle degrades to
 * the two-state toggle the issue originally asked for, between automatic and a fan at
 * full. That is deliberate on both counts: a false fire at road speed can then only ever
 * land on the thermally safe side, and the 160 ENTER presses in the capture archive
 * include five made at 47.0–118.1 km/h, every one far above the ceiling.
 */
export function nextFanGestureAction(inputs: FanGestureInputs): FanGestureAction {
  if (inputs.mode === "fun") {
    // The same place ./auto.ts's own handBackToCurve() goes, so a rider who wants out of
    // fun mode with the phone in a pocket gets the answer the rest of the file gives.
    return "automatic";
  }
  if (inputs.mode === "automatic") {
    return "full";
  }
  if (!Number.isFinite(inputs.targetPercent)) {
    // Manual, with nothing readable saying what the fan was asked for. Neither "it is
    // running" nor "it is stopped" can be claimed, and automatic is the one step that is
    // right either way: the curve takes the fan back and the next hold starts from a
    // state both ends agree on.
    return "automatic";
  }
  if (inputs.targetPercent === 0) {
    return "automatic";
  }
  // A running manual duty — the gesture's own 100 %, or 45 % left by the slider. Quiet is
  // the next step, and it is the one step the bike has to agree to.
  return isBelowOffCeiling(inputs.speedKmh) ? "off" : "automatic";
}

/**
 * Whether the bike is slow enough for the fan to be silenced.
 *
 * ⚠️ Named for what it tests and not for what it used to test: at 15 km/h the bike is not
 * stationary, and a predicate called `isStationary` returning true at 14 km/h would be a
 * worse lie than the number is a change.
 *
 * ⚠️ FAILS CLOSED: null, NaN and a negative all answer false, so *off* needs positive
 * evidence of a slow bike and never merely the absence of evidence. It costs nothing —
 * 0x102 and 0x104 arrive and stop together, measured over a whole AC and a whole DC
 * session (docs/fan-control.md) — so a bus that can deliver the button press can always
 * deliver the speed too.
 */
export function isBelowOffCeiling(speedKmh: number | null): boolean {
  if (speedKmh === null || !Number.isFinite(speedKmh)) {
    return false;
  }
  return speedKmh >= 0 && speedKmh <= FAN_OFF_CEILING_KMH;
}
