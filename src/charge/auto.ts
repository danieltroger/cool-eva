import { ageMs, latestValue, onChange, record } from "../can/signals.ts";
import { monotonicNow } from "../monotonic.ts";
import { isPackTemperaturePlausible } from "../fan/curve.ts";
import { RATE_WINDOW_MS, type TemperatureSample } from "./rate.ts";
import {
  CHARGE_AUTO_REASON,
  decideChargeCurrent,
  type ChargeAutoDecision,
  type ChargeAutoReason,
} from "./auto-curve.ts";

// The half of the automatic charge controller that touches the world: it reads five signals off the
// bus, hands them to the pure rule in ./auto-curve.ts, and sends the answer through the write
// runner. Nothing here decides a current — that is all next door, so it can be replayed.
//
// ⚠️ ONE TRANSMIT PATH. Commands go through the existing `/vcu-write` `charge-current` action, so
// they inherit every lock it has: SERVICE_WRITE_ENABLED, the bus lease, the live-session check, the
// opcode and ceiling chosen from the live bus, and a line in the audit journal per command. A
// consequence worth stating: on a Pi that has not opted into writes this controller is INERT, and
// that is correct.
//
// ⚠️ AUTOMATIC IS THE DEFAULT and the mode is in memory only, exactly as src/fan/auto.ts holds its
// own: the Pi loses power with the bike's 12 V rail, so "off until the bike is switched off" is what
// not persisting already means.

/** How often the rule is re-evaluated. */
export const AUTO_TICK_MS = 60_000;

/** Which mode the controller is in, as `charge_auto_mode` carries it. */
export const CHARGE_AUTO_MODE_CODE = { off: 0, automatic: 1 } as const;

export type ChargeAutoMode = keyof typeof CHARGE_AUTO_MODE_CODE;

export interface ChargeAutoState {
  mode: ChargeAutoMode;
  /** The last decision's reason, so the page can say what it is doing and why. */
  reason: ChargeAutoReason;
  /** What it last commanded this session, or null. */
  commandedAmps: number | null;
}

/** What the controller needs from the write runner, narrowed to the one action it uses. */
export interface ChargeCommandSink {
  commandChargeCurrent: (amps: number) => Promise<{ succeeded: boolean; message: string }>;
}

/** Where a charge current came from. `manual` is the rider, from the phone; `automatic` is us. */
export type ChargeCommandOrigin = "manual" | "automatic";

export interface ChargeAutomaticOptions {
  /** Whether the controller may act at all — `CHARGE_AUTO_ENABLED`, read once in src/index.ts. */
  enabled?: boolean;
}

export interface ChargeAutomatic {
  state: () => ChargeAutoState;
  /** Switches the controller on or off from the dashboard. In memory only. */
  setMode: (mode: ChargeAutoMode) => void;
  /**
   * Told about EVERY charge current this Pi is about to put on the bus, and where it came from.
   *
   * ⚠️ Called BEFORE the frames are sent, not after, and that ordering is the whole fix: the bike
   * answers our `0x120` commit with its own `0x121` within ~3-10 ms, well inside the two `await`s
   * `sendChargeCommand` takes, so a value recorded afterwards arrives after the echo has already
   * stood the controller down. Measured 2026-09-09: reason RIDER at .961, the send's own stamp at
   * .964. A hand-set current still stands down; an automatic one only records the number.
   */
  noteChargeCurrentOutgoing: (amps: number, origin: ChargeCommandOrigin) => void;
  /** Stops the loop and unsubscribes. Called from index.ts's shutdown. */
  stop: () => void;
}

/**
 * Starts the automatic charge-current controller.
 *
 * `sink` is how a command reaches the bike — the write runner's own action, passed in rather than
 * imported, so the check can drive a whole replayed stop without a bus.
 */
export function startChargeAutomatic(sink: ChargeCommandSink, options: ChargeAutomaticOptions = {}): ChargeAutomatic {
  if (options.enabled === false) {
    // ⚠️ Inert, not merely held: with the env switch off there is nothing to subscribe to, no ring
    // worth filling and no rule worth running every minute for the life of the bike. One mode
    // record so the ride log says why nothing happened. src/fan/auto.ts does the same when the fan
    // cannot be driven at all.
    record("charge_auto_mode", CHARGE_AUTO_MODE_CODE.off);
    record("charge_auto_reason", CHARGE_AUTO_REASON.DISABLED);
    return {
      state: () => ({ mode: "off", reason: CHARGE_AUTO_REASON.DISABLED, commandedAmps: null }),
      setMode: () => console.warn("charge-auto: ignoring a mode change — CHARGE_AUTO_ENABLED is 0"),
      noteChargeCurrentOutgoing: () => {},
      stop: () => {},
    };
  }
  const context: AutoContext = {
    sink,
    mode: "automatic",
    reason: CHARGE_AUTO_REASON.NO_HISTORY,
    commandedAmps: null,
    lastSentAmps: null,
    riderOverride: false,
    samples: [],
    inFlight: false,
    lastSessionState: null,
    timer: null,
    unsubscribe: null,
  };
  context.unsubscribe = onChange(changed => {
    if (changed["batt_temp_hi"] !== undefined) {
      remember(context, changed["batt_temp_hi"].value);
    }
    // ⚠️ ONLY a setpoint that is NOT the one we asked for is the rider. The bike answers our own
    // `0x120` commit with a `0x121` carrying the amps we just commanded, so on 2026-09-09 every one
    // of our commands stood the controller down — 5 of 6 automatic commands in one session, each
    // 1 ms after its own echo, and Daniel had to tap "take the current back" six times.
    const observed = changed["dc_charge_limit_selected_a"];
    if (observed !== undefined && isRiderSetpoint(context, observed.value)) {
      standDown(context);
    }
    // ⚠️ Reset on ENTERING a DC session as well as leaving one. Resetting only on exit leaves the
    // ring full of temperatures from the ride in — a hot pack cooling on the way to the charger
    // reads as a falling rate, and the first tick of the new charge decides on it.
    const session = changed["charge_manager_state"];
    if (session !== undefined && session.value !== context.lastSessionState) {
      context.lastSessionState = session.value;
      forgetSession(context);
    }
  });
  context.timer = setInterval(() => void runTick(context), AUTO_TICK_MS);
  context.timer.unref?.();
  publishMode(context);
  return {
    state: () => stateOf(context),
    setMode: mode => {
      context.mode = mode;
      // Switching back to automatic is an explicit "you take it again", so it clears a stand-down.
      if (mode === "automatic") {
        context.riderOverride = false;
      }
      publishMode(context);
      // ⚠️ Re-decide NOW rather than waiting up to a tick, so the page shows what the controller
      // will do instead of last minute's reason — otherwise "Take the current back" stays on screen
      // for a minute after it has been taken back. src/fan/auto.ts re-evaluates on the same edge and
      // COMMANDS there; this deliberately does not, because a mode change should put nothing on the
      // bus. `decide()` only reads signals and returns a verdict.
      context.reason = decide(context).reason;
      record("charge_auto_reason", context.reason);
      console.warn(`charge-auto: mode set to ${mode}`);
    },
    noteChargeCurrentOutgoing: (amps, origin) => {
      context.lastSentAmps = amps;
      if (origin === "manual") {
        standDown(context);
        console.warn("charge-auto: a charge current was set by hand — standing down for this charge");
      }
    },
    stop: () => {
      if (context.timer) {
        clearInterval(context.timer);
        context.timer = null;
      }
      context.unsubscribe?.();
      context.unsubscribe = null;
    },
  };
}

interface AutoContext {
  sink: ChargeCommandSink;
  mode: ChargeAutoMode;
  reason: ChargeAutoReason;
  commandedAmps: number | null;
  /** The last current this Pi put on the bus, automatic or hand-set. The echo test compares to it. */
  lastSentAmps: number | null;
  riderOverride: boolean;
  samples: TemperatureSample[];
  /** True while a command is in flight, so a slow POST cannot overlap the next tick. */
  inFlight: boolean;
  /** The last `charge_manager_state` seen, so entering and leaving a session are both edges. */
  lastSessionState: number | null;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
}

async function runTick(context: AutoContext): Promise<void> {
  if (context.inFlight) {
    // A command outlasting a tick is not a reason to send another one at the same pack.
    return;
  }
  const decision = decide(context);
  context.reason = decision.reason;
  record("charge_auto_reason", decision.reason);
  if (decision.kind !== "command") {
    return;
  }
  context.inFlight = true;
  try {
    const outcome = await context.sink.commandChargeCurrent(decision.amps);
    if (outcome.succeeded) {
      context.commandedAmps = decision.amps;
      record("charge_auto_target_a", decision.amps);
    } else {
      // Not swallowed: a refused command means the bike is not where the rule thought it was, and
      // the next tick will re-read the bus and decide again from what is actually true.
      console.warn(`charge-auto: ${decision.amps} A refused — ${outcome.message}`);
    }
  } catch (err) {
    console.error(`charge-auto: commanding ${decision.amps} A failed`, err);
  } finally {
    context.inFlight = false;
  }
}

/** Reads the bus and asks the pure rule. Separate so the reading is visible next to the decision. */
function decide(context: AutoContext): ChargeAutoDecision {
  const packTemperatureC = latestValue("batt_temp_hi");
  return decideChargeCurrent({
    enabled: context.mode === "automatic",
    packTemperatureC,
    packTemperatureAgeMs: ageMs("batt_temp_hi"),
    packTemperaturePlausible: isPackTemperaturePlausible(packTemperatureC),
    chargeManagerState: latestValue("charge_manager_state"),
    chargeManagerStateAgeMs: ageMs("charge_manager_state"),
    ceilingAmps: latestValue("fast_dc_limit_max_a"),
    commandedAmps: context.commandedAmps,
    riderOverride: context.riderOverride,
    samples: context.samples,
    nowMs: monotonicNow(),
  });
}

function remember(context: AutoContext, celsius: number): void {
  // ⚠️ Gated, like everything else that reaches a decision. A single implausible frame — the pack
  // reporting 0 °C, which this bus does — would otherwise turn a gentle climb into a steep fall and
  // step the current UP. public/lib/bounds.js exists for the same reason on the display side.
  if (!isPackTemperaturePlausible(celsius)) {
    console.warn(`charge-auto: ignoring an implausible pack temperature of ${celsius} °C`);
    return;
  }
  const atMs = monotonicNow();
  context.samples.push({ atMs, celsius });
  // ⚠️ Keeps ONE sample older than the window: the estimator anchors on it, because a pack holding
  // a single whole degree emits nothing and the window would otherwise empty into `unknown`. Trim
  // to the second-oldest instead of the oldest, so exactly one survives.
  const oldest = atMs - RATE_WINDOW_MS;
  while (context.samples.length > 1 && context.samples[1].atMs < oldest) {
    context.samples.shift();
  }
}

/**
 * A session that ended takes the controller's memory with it.
 *
 * ⚠️ Including `riderOverride`: standing down is for the rest of THIS charge, not for ever. And
 * including the ring — a rate measured across an unplug is a rate across two different situations.
 */
function forgetSession(context: AutoContext): void {
  context.commandedAmps = null;
  context.lastSentAmps = null;
  context.riderOverride = false;
  context.samples.length = 0;
}

/**
 * Whether an observed setpoint is the rider rather than the bike answering our own command.
 *
 * ⚠️ Equality is safe because it is EXACT: across 21 matched sends on 2026-09-09 the echoed byte
 * was identical to the commanded one every time, including 44 A, which is not on the dash's own
 * 5 A grid. If the rider dials to exactly the value we commanded, nothing stands down and nothing
 * changes on the bike — they asked for the current already flowing.
 *
 * ⚠️ The CEILING is exempt unless we asked for it ourselves. The one setpoint event of 2026-09-09
 * that no Pi command caused was 75 A — the ceiling — at session teardown, which is the setting
 * resetting on unplug and not a rider. A rider who genuinely dials to maximum after we have
 * commanded the maximum is indistinguishable from that reset, and we take the safe reading.
 */
function isRiderSetpoint(context: AutoContext, observedAmps: number): boolean {
  if (context.lastSentAmps !== null && observedAmps === context.lastSentAmps) {
    return false;
  }
  const ceiling = latestValue("fast_dc_limit_max_a");
  if (ceiling !== null && observedAmps === ceiling && context.lastSentAmps !== ceiling) {
    return false;
  }
  return true;
}

/**
 * Publishes the EFFECTIVE mode, not the requested one.
 *
 * ⚠️ `CHARGE_AUTO_ENABLED=0` pins the mode off, so recording `context.mode` made the signal say
 * `automatic` while /charge-auto said `off` — two sources of truth for one fact, and the ride log
 * would have carried the wrong one. src/fan/auto.ts publishes through one helper for the same reason.
 */
function publishMode(context: AutoContext): void {
  record("charge_auto_mode", CHARGE_AUTO_MODE_CODE[stateOf(context).mode]);
}

/**
 * Stands the controller down and says so IMMEDIATELY.
 *
 * ⚠️ The reason has to move with the flag. Setting only the flag left `reason` stale until the next
 * tick, so for up to a minute after the rider set a current the charge tab still offered "switch
 * off" — the two-tap trap, in the exact window it is supposed to be gone from.
 */
function standDown(context: AutoContext): void {
  context.riderOverride = true;
  context.reason = CHARGE_AUTO_REASON.RIDER;
  record("charge_auto_reason", context.reason);
}

function stateOf(context: AutoContext): ChargeAutoState {
  return {
    mode: context.mode,
    reason: context.reason,
    commandedAmps: context.commandedAmps,
  };
}
