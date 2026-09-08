import { latestValue, onChange, record } from "../can/signals.ts";
import { monotonicNow } from "../monotonic.ts";
import {
  ACK_TIMEOUT_MS,
  BINDING_LOOKBACK_MS,
  CHARGE_ACK_CODE,
  describeChargeAck,
  judgeChargeCommand,
  type AckSample,
  type ChargeAckVerdict,
} from "./acknowledge.ts";
import type { ChargeMode } from "../can/charge-command.ts";

// Watches whether a charge-current command took, and writes the answer down where it survives.
//
// The pure adjudication is next door in ./acknowledge.ts; this is the part that keeps the ring of
// samples, holds the pending command and records the verdict as signals. Same split as
// src/fan/curve.ts and src/fan/auto.ts, for the same reason: the judgement is replayable and this
// is not.
//
// ⚠️ It watches EVERY charge-current command, not only the automatic controller's. A second
// mechanism for the manual control is how the two drift apart, and the manual control is what a
// live test uses.
//
// ⚠️ The acknowledgement signal differs by charge type, and getting this wrong is silent:
//   DC → `fast_dc_target_a` (0x615 b2), the vehicle's own request to the station.
//   AC → `charge_limit_a` (0x10A b7 ÷ 7), the committed AC setpoint.
// `charge_limit_a` reads a flat 0.0 for the whole of a DC session — measured across all three of
// 2026-09-07 — so keying DC on it would report "not acknowledged" for ever. And neither is
// `pack_a`, which is what flowed and conflates the VCU accepting the command with the station
// being able to deliver it. docs/can-0x121-charge-command.md.

/** charge_manager_state (0x610 b7) settled values, as write-runner.ts reads them. */
const CHARGE_MANAGER_STATE_AC = 0x02;
const CHARGE_MANAGER_STATE_DC = 0x23;

/** The signal that answers "did the VCU take it", per charge type. Never the delivered current. */
export const ACK_SIGNAL: Record<ChargeMode, string> = {
  dc: "fast_dc_target_a",
  ac: "charge_limit_a",
};

/** What the charge tab shows about the last command. */
export interface ChargeAckState {
  commandedAmps: number;
  mode: ChargeMode;
  verdict: ChargeAckVerdict;
  /** Already phrased for the page. */
  message: string;
}

/**
 * Notes that a command has gone out, and starts watching.
 *
 * Called from the write runner the moment the frames hit the bus. A command that arrives while
 * another is still open supersedes it — the older one is judged immediately with what it has, so
 * its verdict is recorded rather than lost.
 */
export function noteChargeCommandSent(mode: ChargeMode, amps: number): void {
  const sentAtMs = monotonicNow();
  if (pending) {
    settle(pending, sentAtMs);
  }
  pending = { mode, amps, sentAtMs };
  record("charge_cmd_a", amps);
  latest = { commandedAmps: amps, mode, verdict: { kind: "waiting", elapsedMs: 0 }, message: "" };
}

/** The last command's outcome, or null when none has been sent this session. */
export function chargeAckState(): ChargeAckState | null {
  if (pending) {
    // Judged on every read rather than on a timer: the page asks when it renders, and a timer here
    // would be a second clock to keep in step with the one the verdict is measured against.
    const verdict = judgePending(pending, monotonicNow());
    if (verdict.kind !== "waiting") {
      settle(pending, null);
    } else {
      latest = {
        commandedAmps: pending.amps,
        mode: pending.mode,
        verdict,
        message: describeChargeAck(verdict, pending.amps),
      };
    }
  }
  return latest;
}

/**
 * Clears the readout when a charge session ends — a new session starts with nothing to show.
 *
 * Called from the watcher below rather than by a caller, so a verdict from the last charge cannot
 * be read as belonging to this one.
 */
function forgetChargeAck(): void {
  pending = null;
  latest = null;
  samples.length = 0;
}

/**
 * Starts collecting the acknowledgement signals. Call once at startup.
 *
 * Subscribes to the signal stream rather than polling, so a value that changes twice inside one
 * update period is not missed — the envelope test is only as good as the samples behind it.
 */
export function startChargeAckWatch(): void {
  onChange(changed => {
    for (const [key, value] of Object.entries(changed)) {
      if (key === ACK_SIGNAL.dc || key === ACK_SIGNAL.ac) {
        remember(key, value.value);
      }
      // A session that has ended takes its verdict with it. ⚠️ charge_manager_state, not
      // charge_type: charge_type flaps 1↔0 within one plug-in as the charger pauses delivery
      // (docs/charge-manager.md), which would wipe a perfectly good verdict mid-charge.
      if (
        key === "charge_manager_state" &&
        value.value !== CHARGE_MANAGER_STATE_AC &&
        value.value !== CHARGE_MANAGER_STATE_DC
      ) {
        forgetChargeAck();
      }
    }
  });
}

interface PendingCommand {
  mode: ChargeMode;
  amps: number;
  sentAtMs: number;
}

let pending: PendingCommand | null = null;
let latest: ChargeAckState | null = null;

/**
 * Samples per signal, oldest first, trimmed to what a verdict can still need.
 *
 * Module-level and bounded: the ring only ever has to reach back one lookback plus one window, and
 * a charge lasting an hour must not accumulate an hour of samples on a Pi Zero.
 */
const samples: { key: string; sample: AckSample }[] = [];

function remember(key: string, amps: number): void {
  const atMs = monotonicNow();
  samples.push({ key, sample: { atMs, amps } });
  const oldest = atMs - (BINDING_LOOKBACK_MS + ACK_TIMEOUT_MS);
  while (samples.length > 0 && samples[0].sample.atMs < oldest) {
    samples.shift();
  }
}

function judgePending(command: PendingCommand, nowMs: number): ChargeAckVerdict {
  const key = ACK_SIGNAL[command.mode];
  const forSignal = samples.filter(entry => entry.key === key).map(entry => entry.sample);
  // ⚠️ Seed the ring with the signal's current value when nothing has changed inside the lookback.
  // Without it a rock-steady request — exactly what a healthy capped charge looks like — has no
  // samples at all and every command reads `no-evidence`.
  const current = latestValue(key);
  if (forSignal.length === 0 && current !== null) {
    forSignal.push({ atMs: command.sentAtMs, amps: current });
  }
  return judgeChargeCommand({
    commandedAmps: command.amps,
    sentAtMs: command.sentAtMs,
    nowMs,
    samples: forSignal,
    supersededAtMs: null,
  });
}

/** Records a command's final verdict and stops watching it. `supersededAtMs` when a newer one came. */
function settle(command: PendingCommand, supersededAtMs: number | null): void {
  const key = ACK_SIGNAL[command.mode];
  const forSignal = samples.filter(entry => entry.key === key).map(entry => entry.sample);
  const verdict = judgeChargeCommand({
    commandedAmps: command.amps,
    sentAtMs: command.sentAtMs,
    nowMs: supersededAtMs ?? monotonicNow(),
    samples: forSignal,
    supersededAtMs,
  });
  latest = {
    commandedAmps: command.amps,
    mode: command.mode,
    verdict,
    message: describeChargeAck(verdict, command.amps),
  };
  record("charge_cmd_ack", CHARGE_ACK_CODE[verdict.kind]);
  if (verdict.kind === "took") {
    record("charge_cmd_ack_ms", verdict.latencyMs);
  }
  console.warn(`charge-ack: ${command.mode.toUpperCase()} ${command.amps} A — ${latest.message}`);
  pending = null;
}
