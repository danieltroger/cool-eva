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
 * ⚠️ 1200 ms, and NOT the 1000 ms the waypoint hold uses. The two buttons differ in what
 * the BIKE does with a long press: 160 recorded ENTER presses top out at 0.290 s and it
 * is the only decoded handlebar bit in the whole archive with no long press anywhere,
 * whereas indicator-cancel lights the hazards somewhere at or before 2.011 s and wants
 * the shorter hold to keep a thumb clear of it.
 */
export const FAN_HOLD_MS = 1200;

/**
 * At or below this the bike counts as stopped, so the fan may be silenced.
 *
 * The bike's own number: its dash menu is stationary-only and >3 km/h exits it
 * (obd-garage/CAN_MAP.md, owner's manual pp. 2-4 and 49). Used on BOTH sides — entering
 * *off* and leaving it — so there is one threshold rather than a band nobody measured.
 */
export const STATIONARY_MAX_KMH = 3;

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
 * ⚠️ *Off* is only reachable with the bike PROVABLY stopped, so above 3 km/h — or with
 * nothing saying the bike is stopped — the cycle degrades to the two-state toggle the
 * issue originally asked for, between automatic and a fan at full. That is deliberate on
 * both counts: a false fire while riding can then only ever land on the thermally safe
 * side, and the 160 ENTER presses in the archive include five made at 47–118 km/h.
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
  return isStationary(inputs.speedKmh) ? "off" : "automatic";
}

/**
 * Whether the bike is provably stopped.
 *
 * ⚠️ FAILS CLOSED: null, NaN and a negative all answer false, so *off* needs positive
 * evidence of a standstill and never merely the absence of evidence. It costs nothing —
 * 0x102 and 0x104 arrive and stop together, measured over a whole AC and a whole DC
 * session (docs/fan-control.md) — so a bus that can deliver the button press can always
 * deliver the speed too.
 */
export function isStationary(speedKmh: number | null): boolean {
  if (speedKmh === null || !Number.isFinite(speedKmh)) {
    return false;
  }
  return speedKmh >= 0 && speedKmh <= STATIONARY_MAX_KMH;
}
