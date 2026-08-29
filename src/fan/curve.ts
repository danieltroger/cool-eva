import { MIN_RUNNING_DUTY_PERCENT } from "./control.ts";

// What duty the automatic mode asks for, as arithmetic and nothing else.
//
// Pure on purpose, the way ../can/decode.ts and ../ble/protocol.ts are: values in,
// a decision out, no signal lookups, no clock reads, no I/O. That is what lets
// scripts/check-fan-curve.ts replay a pack warming through 35 °C, a rider crossing
// 90 km/h and a temperature sensor dying, none of which can be staged in a garage.
// ./auto.ts is the half that reads the bus and drives the bridge.
//
// Every number here — the two curves, the hysteresis pairs, the 60 s grace — is
// argued in docs/fan-control.md §"The automatic curve". Read that before changing one.
// ⚠️ Argued, not measured: none of them has been checked against what this radiator
// actually needs, and both tables there carry the marker saying so.

/** ⚠️ 0x610 b7 = 0x23 is a DC session. NOT `charge_type`, which flaps 1↔0 mid-session. */
export const CHARGE_MANAGER_STATE_DC = 0x23;

/**
 * `batt_temp_hi`'s physical range, and the server's own copy of it.
 *
 * ⚠️ Deliberately not read from public/lib/bounds.js: that gate exists to stop the
 * dashboard DRAWING a sentinel, and this one decides whether to spin a fan. They must
 * agree, so scripts/check-fan-curve.ts asserts they do rather than sharing a module the
 * Pi would then depend on the browser code for.
 */
export const PACK_TEMPERATURE_MIN_C = -30;
export const PACK_TEMPERATURE_MAX_C = 90;

/** Warm enough to start the fan. The foot of both curves, so 35 °C maps to the floor. */
export const FAN_ON_TEMPERATURE_C = 35;

/**
 * …and cool enough to stop it again. The 2 °C gap is the hysteresis: `batt_temp_hi`
 * is whole degrees off 0x200, so without it a pack sitting on 35 would start and stop
 * the fan on every crossing.
 */
export const FAN_OFF_TEMPERATURE_C = 33;

/** Where the riding / parked / AC curve reaches 100 %. */
export const RIDING_CURVE_TOP_C = 48;

/** Where the DC curve reaches 100 %. Higher because a DC session runs hotter for longer. */
export const DC_CURVE_TOP_C = 54;

/** Below this the fan may start: above it the airstream through the duct does the work. */
export const SPEED_GATE_ON_KMH = 90;

/** A running fan keeps running up to here. The 3 km/h gap is the speed hysteresis. */
export const SPEED_GATE_OFF_KMH = 93;

/**
 * The fastest `speed_can_kmh` this treats as a road speed.
 *
 * ⚠️ Not decoration. `speed_can_kmh` is the only one of the three inputs that public/lib
 * /bounds.js does NOT gate — it has no BY_KEY entry and "km/h" is not in BY_UNIT — and a
 * garbage high reading is the one that fails DANGEROUSLY here, by holding the fan off
 * over a hot pack. Anything past this is read as no speed at all, which opens the gate.
 */
export const ROAD_SPEED_MAX_KMH = 300;

/**
 * How old `batt_temp_hi` may be and still be treated as the pack's temperature now.
 *
 * It arrives on 0x200 at 20 Hz or on 0x660 at 1 Hz, whichever ../can/pack-temperature.ts
 * has routed, so 5 s is five missed frames at the SLOWER of the two — which is the one
 * this has to be safe for.
 */
export const TEMPERATURE_FRESH_MS = 5_000;

/**
 * …and how long the last in-bounds reading is steered by before it is given up on.
 * Past this the fan runs at the floor rather than at whatever the curve makes of a
 * number nobody is refreshing. See docs/fan-control.md §"When the temperature goes away".
 */
export const TEMPERATURE_GRACE_MS = 60_000;

/** Which rule set the duty. Published as `fan_auto_reason` so the dashboard can say why. */
export const FAN_REASON = {
  /** Automatic is not driving: the duty on the bridge came from the slider. */
  MANUAL: 0,
  /** Nothing has arrived under `batt_temp_hi` yet and the grace has not run out. */
  NO_READING_YET: 1,
  /** No usable `batt_temp_hi` for TEMPERATURE_GRACE_MS. The floor, and a fault. */
  TEMPERATURE_FAULT: 2,
  /** Pack below the start threshold (or back under the stop one). */
  BELOW_THRESHOLD: 3,
  /** Riding at or above the speed gate. */
  ROAD_SPEED: 4,
  /** On the riding / parked / AC curve. */
  PACK_TEMPERATURE: 5,
  /** DC session, pack at or under the curve's foot — the floor a DC session always gets. */
  DC_FLOOR: 6,
  /** DC session, on the 35 → 54 °C curve. */
  DC_TEMPERATURE: 7,
} as const;

export type FanReason = (typeof FAN_REASON)[keyof typeof FAN_REASON];

/** Where the temperature the decision rests on came from. Published as `fan_temp_input`. */
export const FAN_TEMPERATURE_INPUT = {
  /** An in-bounds reading no older than TEMPERATURE_FRESH_MS. */
  LIVE: 0,
  /** The last in-bounds reading, still inside the grace. */
  HELD: 1,
  /** Nothing usable at all. */
  NONE: 2,
} as const;

export type FanTemperatureInput = (typeof FAN_TEMPERATURE_INPUT)[keyof typeof FAN_TEMPERATURE_INPUT];

export interface FanCurveInputs {
  /** The last IN-BOUNDS `batt_temp_hi`, or null if there has never been one. */
  packTemperatureC: number | null;
  /**
   * Milliseconds since that reading arrived — or since the loop started, when none ever
   * has. ⚠️ A duration, so the caller measures it with since() from ../monotonic.ts.
   */
  temperatureAgeMs: number;
  /** `speed_can_kmh`, or null when it is absent or stale — i.e. the bike is not moving. */
  speedKmh: number | null;
  /** `charge_manager_state` (0x610 b7), or null when it is absent or stale. */
  chargeManagerState: number | null;
  /** Whether the fan was running on the previous decision. This is the hysteresis memory. */
  previouslyRunning: boolean;
}

export interface FanCurveDecision {
  /** What to command. 0 stops the fan; anything else is at least MIN_RUNNING_DUTY_PERCENT. */
  dutyPercent: number;
  reason: FanReason;
  temperatureInput: FanTemperatureInput;
  /** The temperature this decision was made on, or null when there was none to use. */
  temperatureC: number | null;
}

/**
 * The whole automatic policy: what the fan should be doing, and why.
 *
 * ⚠️ The one thing this must never do is answer 0 because a sensor went quiet. A dead
 * `batt_temp_hi` reads exactly like a cold pack, so the grace expiring is a floor plus a
 * fault, never an off — docs/fan-control.md §"When the temperature goes away".
 */
export function fanCurveDecision(inputs: FanCurveInputs): FanCurveDecision {
  const charging = inputs.chargeManagerState === CHARGE_MANAGER_STATE_DC;
  const temperature = usableTemperature(inputs);

  if (temperature === null) {
    if (inputs.temperatureAgeMs > TEMPERATURE_GRACE_MS) {
      return floor(FAN_REASON.TEMPERATURE_FAULT, FAN_TEMPERATURE_INPUT.NONE);
    }
    // Nothing has arrived yet and the grace has not run out — the first seconds after a
    // restart. A DC session still gets its floor: that rule does not consult the pack.
    return charging
      ? floor(FAN_REASON.DC_FLOOR, FAN_TEMPERATURE_INPUT.NONE)
      : {
          dutyPercent: 0,
          reason: FAN_REASON.NO_READING_YET,
          temperatureInput: FAN_TEMPERATURE_INPUT.NONE,
          temperatureC: null,
        };
  }

  const input =
    inputs.temperatureAgeMs > TEMPERATURE_FRESH_MS ? FAN_TEMPERATURE_INPUT.HELD : FAN_TEMPERATURE_INPUT.LIVE;

  if (charging) {
    const dutyPercent = rampDuty(temperature, FAN_ON_TEMPERATURE_C, DC_CURVE_TOP_C);
    const reason = dutyPercent > MIN_RUNNING_DUTY_PERCENT ? FAN_REASON.DC_TEMPERATURE : FAN_REASON.DC_FLOOR;
    return { dutyPercent, reason, temperatureInput: input, temperatureC: temperature };
  }

  if (!belowSpeedGate(inputs.speedKmh, inputs.previouslyRunning)) {
    return { dutyPercent: 0, reason: FAN_REASON.ROAD_SPEED, temperatureInput: input, temperatureC: temperature };
  }
  if (!warmEnough(temperature, inputs.previouslyRunning)) {
    return { dutyPercent: 0, reason: FAN_REASON.BELOW_THRESHOLD, temperatureInput: input, temperatureC: temperature };
  }
  return {
    dutyPercent: rampDuty(temperature, FAN_ON_TEMPERATURE_C, RIDING_CURVE_TOP_C),
    reason: FAN_REASON.PACK_TEMPERATURE,
    temperatureInput: input,
    temperatureC: temperature,
  };
}

/** True if `celsius` is a reading of a pack rather than a sentinel. Bounds above. */
export function isPackTemperaturePlausible(celsius: number | null): celsius is number {
  return (
    celsius !== null &&
    Number.isFinite(celsius) &&
    celsius >= PACK_TEMPERATURE_MIN_C &&
    celsius <= PACK_TEMPERATURE_MAX_C
  );
}

/**
 * The straight line from the floor at `footC` to 100 % at `topC`, clamped at both ends.
 *
 * Exported because it is the arithmetic both curves are, and the two are the same shape
 * with a different top — 48 °C riding, 54 °C on DC.
 */
export function rampDuty(temperatureC: number, footC: number, topC: number): number {
  if (temperatureC >= topC) {
    return 100;
  }
  if (temperatureC <= footC) {
    return MIN_RUNNING_DUTY_PERCENT;
  }
  const span = (temperatureC - footC) / (topC - footC);
  const duty = MIN_RUNNING_DUTY_PERCENT + span * (100 - MIN_RUNNING_DUTY_PERCENT);
  return Math.round(duty);
}

/** The temperature to steer by, or null when there is none inside the grace. */
function usableTemperature(inputs: FanCurveInputs): number | null {
  if (inputs.temperatureAgeMs > TEMPERATURE_GRACE_MS) {
    return null;
  }
  return isPackTemperaturePlausible(inputs.packTemperatureC) ? inputs.packTemperatureC : null;
}

/**
 * ⚠️ An ABSENT — or impossible — speed opens the gate rather than closing it. A parked
 * bike stops broadcasting 0x104 entirely, and a pack that is hot in a garage is the case
 * the fan exists for; the caller passes null once the signal is stale for the same
 * reason. Both failures therefore leave the fan free to run, never held off.
 */
function belowSpeedGate(speedKmh: number | null, previouslyRunning: boolean): boolean {
  if (speedKmh === null || !Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > ROAD_SPEED_MAX_KMH) {
    return true;
  }
  return speedKmh < (previouslyRunning ? SPEED_GATE_OFF_KMH : SPEED_GATE_ON_KMH);
}

function warmEnough(temperatureC: number, previouslyRunning: boolean): boolean {
  return temperatureC > (previouslyRunning ? FAN_OFF_TEMPERATURE_C : FAN_ON_TEMPERATURE_C);
}

function floor(reason: FanReason, temperatureInput: FanTemperatureInput): FanCurveDecision {
  return { dutyPercent: MIN_RUNNING_DUTY_PERCENT, reason, temperatureInput, temperatureC: null };
}
