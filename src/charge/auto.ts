import { ageMs, latestValue, onChange, record } from "../can/signals.ts";
import { monotonicNow } from "../monotonic.ts";
import { isPackTemperaturePlausible } from "../fan/curve.ts";
import { RATE_WINDOW_MS, type TemperatureSample } from "./rate.ts";
import {
  CHARGE_AUTO_REASON,
  CHARGE_MANAGER_STATE_DC,
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
  /** True once the rider has moved the dial on the bike; cleared when the session ends. */
  riderOverride: boolean;
}

/** What the controller needs from the write runner, narrowed to the one action it uses. */
export interface ChargeCommandSink {
  commandChargeCurrent: (amps: number) => Promise<{ succeeded: boolean; message: string }>;
}

export interface ChargeAutomaticOptions {
  /** Turned down by scripts/check-charge-auto.ts so a whole stop replays inside one check. */
  tickMs?: number;
  /** Whether the controller may act at all — `CHARGE_AUTO_ENABLED`, read once in src/index.ts. */
  enabled?: boolean;
}

export interface ChargeAutomatic {
  state: () => ChargeAutoState;
  /** Switches the controller on or off from the dashboard. In memory only. */
  setMode: (mode: ChargeAutoMode) => void;
  /** Runs one evaluation now. The tick calls it; the check drives it directly. */
  tick: () => Promise<void>;
  /**
   * Told when a charge current was commanded by HAND, from the phone.
   *
   * ⚠️ Stands the controller down for the rest of the session, the same as the dial on the bike —
   * both are the rider saying what they want, and a controller that overrode either three seconds
   * later is the thing that gets a Pi ripped out. Switching the toggle back to automatic clears it.
   */
  noteManualCommand: () => void;
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
  const context: AutoContext = {
    sink,
    enabled: options.enabled ?? true,
    mode: "automatic",
    reason: CHARGE_AUTO_REASON.NO_HISTORY,
    commandedAmps: null,
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
    // ⚠️ The rider moving the dial stands this down for the rest of the session. This Pi does not
    // hear its own transmissions (`createRawChannel` does not set CAN_RAW_RECV_OWN_MSGS, proven
    // 2026-09-07: our three sends produced no decoded row while all twelve of the dash's did), so a
    // `dc_charge_limit_selected_a` event is necessarily the RIDER and never our own echo.
    if (changed["dc_charge_limit_selected_a"] !== undefined) {
      context.riderOverride = true;
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
  context.timer = setInterval(() => void runTick(context), options.tickMs ?? AUTO_TICK_MS);
  context.timer.unref?.();
  record("charge_auto_mode", CHARGE_AUTO_MODE_CODE[context.mode]);
  return {
    state: () => stateOf(context),
    setMode: mode => {
      context.mode = mode;
      // Switching back to automatic is an explicit "you take it again", so it clears a stand-down.
      if (mode === "automatic") {
        context.riderOverride = false;
      }
      record("charge_auto_mode", CHARGE_AUTO_MODE_CODE[mode]);
      console.warn(`charge-auto: mode set to ${mode}`);
    },
    tick: () => runTick(context),
    noteManualCommand: () => {
      context.riderOverride = true;
      console.warn("charge-auto: a charge current was set by hand — standing down for this charge");
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
  enabled: boolean;
  mode: ChargeAutoMode;
  reason: ChargeAutoReason;
  commandedAmps: number | null;
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
    enabled: context.enabled && context.mode === "automatic",
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
  context.riderOverride = false;
  context.samples.length = 0;
}

function stateOf(context: AutoContext): ChargeAutoState {
  return {
    mode: context.enabled ? context.mode : "off",
    reason: context.reason,
    commandedAmps: context.commandedAmps,
    riderOverride: context.riderOverride,
  };
}
