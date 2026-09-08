import { latestValue, onChange, record } from "../can/signals.ts";
import { monotonicNow } from "../monotonic.ts";
import {
  ACK_TIMEOUT_MS,
  SAMPLE_HISTORY_MS,
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
// ⚠️ It watches EVERY charge-current command, not only the automatic controller's — a second
// mechanism for the manual control is how the two drift apart.
//
// ⚠️ The acknowledgement signal differs by charge type and getting it wrong is silent: DC reads
// `fast_dc_target_a`, AC reads `charge_limit_a`, and NEITHER is `pack_a`. Why each, and why
// charge_limit_a is unusable on DC: docs/can-0x121-charge-command.md § "Confirming a DC command".

/**
 * charge_manager_state (0x610 b7) settled values.
 *
 * ⚠️ The fourth private copy of these two bytes (fan/curve.ts exports DC only, write-runner.ts and
 * public/lib/charge-write.js each keep their own pair). Left alone deliberately: folding them into
 * one shared charge module means editing three files this change has no other business in.
 */
const CHARGE_MANAGER_STATE_AC = 0x02;
const CHARGE_MANAGER_STATE_DC = 0x23;

/** The signal that answers "did the VCU take it", per charge type. Never the delivered current. */
const ACK_SIGNAL: Record<ChargeMode, string> = {
  dc: "fast_dc_target_a",
  ac: "charge_limit_a",
};

/** What the charge tab shows about the last command. Exactly what it renders, nothing spare. */
export interface ChargeAckState {
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
  // ⚠️ The verdict must land with NOBODY WATCHING. It used to be computed only when the page
  // fetched /vcu-write, so an unattended charge — the case this whole feature exists for — recorded
  // nothing at all. One short-lived timer per command, cleared the moment it settles.
  clearSettleTimer();
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (pending) {
      settle(pending, null);
    }
  }, ACK_TIMEOUT_MS + SETTLE_TIMER_MARGIN_MS);
  settleTimer.unref?.();
  record("charge_cmd_a", amps);
}

/**
 * The last command's outcome, or null when none has been sent this session.
 *
 * ⚠️ PURE. It judges into a local and returns a snapshot; it does not settle. /vcu-write's GET is
 * documented as touching nothing, and settling here made a query record signals and append to the
 * encrypted log — with two polling clients racing to be the one that did it. Settling happens where
 * evidence arrives (`remember`) with the timer as the backstop.
 */
export function chargeAckState(): ChargeAckState | null {
  if (!pending) {
    return latest;
  }
  const verdict = judgeChargeCommand({
    commandedAmps: pending.amps,
    sentAtMs: pending.sentAtMs,
    nowMs: monotonicNow(),
    samples: samplesFor(pending),
    supersededAtMs: null,
  });
  return stateFor(pending.amps, verdict);
}

/**
 * Clears the readout when a charge session ends — a new session starts with nothing to show.
 *
 * Called from the watcher below rather than by a caller, so a verdict from the last charge cannot
 * be read as belonging to this one.
 */
function forgetChargeAck(): void {
  clearSettleTimer();
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
    for (const key of [ACK_SIGNAL.dc, ACK_SIGNAL.ac]) {
      const value = changed[key];
      if (value !== undefined) {
        remember(key, value.value);
      }
    }
    // A session that has ended takes its verdict with it. ⚠️ charge_manager_state, not charge_type:
    // charge_type flaps 1↔0 within one plug-in as the charger pauses delivery, which would wipe a
    // perfectly good verdict mid-charge (docs/charge-manager.md).
    const session = changed["charge_manager_state"];
    if (
      session !== undefined &&
      session.value !== CHARGE_MANAGER_STATE_AC &&
      session.value !== CHARGE_MANAGER_STATE_DC
    ) {
      forgetChargeAck();
      return;
    }
    // ⚠️ Settled HERE, where new evidence arrives, rather than when a page happens to ask. That is
    // the earliest a verdict can be known and it needs nobody watching; the timer is the backstop
    // for the case where the signal simply goes quiet.
    if (pending && monotonicNow() >= pending.sentAtMs + ACK_TIMEOUT_MS) {
      settle(pending, null);
    }
  });
}

/** The rendered shape for one verdict. One builder, so the phrasing cannot drift from the verdict. */
function stateFor(amps: number, verdict: ChargeAckVerdict): ChargeAckState {
  return { verdict, message: describeChargeAck(verdict, amps) };
}

interface PendingCommand {
  mode: ChargeMode;
  amps: number;
  sentAtMs: number;
}

let pending: PendingCommand | null = null;
let latest: ChargeAckState | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/** A beat past the window, so the timer never fires on a verdict that is still legitimately open. */
const SETTLE_TIMER_MARGIN_MS = 500;

function clearSettleTimer(): void {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

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
  const oldest = atMs - (SAMPLE_HISTORY_MS + ACK_TIMEOUT_MS);
  while (samples.length > 0 && samples[0].sample.atMs < oldest) {
    samples.shift();
  }
}

/**
 * The samples a verdict is judged from.
 *
 * ⚠️ ONE path, used by both the live read and the final settle. They used to differ — only the live
 * one seeded from `latestValue` — so a steady capped charge, which is exactly the case the seed
 * exists for, read `not-acknowledged` while the command was open and `no-evidence` the instant it
 * settled. Same command, two answers, decided by which function happened to run.
 */
function samplesFor(command: PendingCommand): AckSample[] {
  const key = ACK_SIGNAL[command.mode];
  // ⚠️ Filtered to the window the JUDGE uses, not merely "the ring is non-empty". The ring is
  // trimmed only when a sample arrives, so a steady charge leaves one stale entry in it — enough
  // to skip the seed, and then the judge discards that entry as too old and answers `no-evidence`
  // in exactly the case the seed exists for.
  const forSignal = samples
    .filter(entry => entry.key === key && entry.sample.atMs >= command.sentAtMs - SAMPLE_HISTORY_MS)
    .map(entry => entry.sample);
  // The signal is logged on change, so silence means it is still sitting at its current value.
  const current = latestValue(key);
  if (forSignal.length === 0 && current !== null) {
    forSignal.push({ atMs: command.sentAtMs, amps: current });
  }
  return forSignal;
}

/** Records a command's final verdict and stops watching it. `supersededAtMs` when a newer one came. */
function settle(command: PendingCommand, supersededAtMs: number | null): void {
  const verdict = judgeChargeCommand({
    commandedAmps: command.amps,
    sentAtMs: command.sentAtMs,
    nowMs: supersededAtMs ?? monotonicNow(),
    samples: samplesFor(command),
    supersededAtMs,
  });
  latest = stateFor(command.amps, verdict);
  record("charge_cmd_ack", CHARGE_ACK_CODE[verdict.kind]);
  if (verdict.kind === "took") {
    record("charge_cmd_ack_ms", verdict.latencyMs);
  }
  console.warn(`charge-ack: ${command.mode.toUpperCase()} ${command.amps} A — ${latest.message}`);
  clearSettleTimer();
  pending = null;
}
