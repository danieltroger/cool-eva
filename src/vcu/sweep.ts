import type { RawChannel } from "socketcan";
import type { FrameArrival } from "../can/frame-arrival.ts";
import { pollerRefusalFor, withObdPollerHold, type ObdPollerHold } from "../can/obd-hold.ts";
import { createVcuKwpClient, type VcuReadOutcome } from "./kwp-client.ts";
import { identifierForIndex } from "./param-codec.ts";
import { activeParameterTable, contentTwinsOf, describeTableType } from "./param-table.ts";
import { MICROS, sweepTargets, type SweepTarget } from "./sweep-targets.ts";
import {
  describeRow,
  reportTableType,
  toParameterRow,
  type VcuParameterRow,
  type VcuParameterSnapshot,
} from "./snapshot.ts";
import { loadPartialRows, openPartialSweepLog, writeSnapshot } from "./snapshot-store.ts";
import type { ServiceGateVerdict } from "./service-gate.ts";

// One parameter sweep, in the service's own process, on the service's own CAN socket.
// Started by hand from service mode and by nothing else.
//
// ⚠️ Still read-only, and still structurally. Every byte that reaches the bus is built by
// ./param-codec.ts, whose request union has three members — start session, tester present,
// read one parameter — and whose encoder throws on anything else on the way out. There is
// no raw-bytes entry point here, no service byte derived from anything a caller supplied,
// and no HTTP parameter anywhere that names a service, an identifier or a value.
//
// ⚠️ It does not configure can0 and does not own the socket. The channel is the service's,
// already up and already started. Nothing here calls `bringUpCan` (which downs the interface
// when it is not already configured, killing every other raw-CAN socket on the Pi), and
// nothing here calls `channel.start()` or `channel.stop()`. Frames are handed in by the
// caller rather than subscribed to, so this module owns no listener to leak either.
//
// Why a ~300-request burst is allowed to exist inside the always-on service at all, what
// the old ssh-script rule was really about, and which of those requests park the OBD poller
// first: docs/vcu-parameters.md §9.

/** What a sweep needs. Everything is supplied — no globals, no env, no clock of its own. */
export interface ParameterSweepOptions {
  /** The service's already-started channel. Never reconfigured, never stopped here. */
  channel: RawChannel;
  /** Where the resume file and the snapshots go. */
  directory: string;
  /**
   * Consulted before EVERY request, including the session opens. This is what makes
   * "auto-exit if the bike stops being safe" a property of the sweep rather than a
   * timer racing it: the check sits between the loop and the socket, so a sweep that
   * has been told to stop cannot emit one more frame on its way out.
   */
  checkGate: () => ServiceGateVerdict;
  /** Called once per row as it is written down, so a caller can show progress without reading the file back. */
  onRow?: (row: VcuParameterRow) => void;
  /**
   * How the OBD poller is parked for a firmware-block row. Production passes nothing.
   *
   * ⚠️ Injectable for the same reason `gate` and `latestSweep` are injected on the write
   * runner: a check has to be able to refuse a hold, and to assert that nothing reached the
   * bus when one was refused. There is no other way to reach either from outside.
   */
  acquirePollerHold?: (reason: string) => Promise<ObdPollerHold | null>;
}

export interface ParameterSweepResult {
  snapshot: VcuParameterSnapshot;
  /**
   * Null when the sweep asked about every parameter on its list. A sentence when it
   * stopped early — cancelled, or put out by the gate — already phrased for the page.
   */
  stoppedBecause: string | null;
}

/** A sweep in flight. */
export interface RunningParameterSweep {
  /**
   * Feed every CAN frame here; returns true when it was consumed. The service shares
   * one socket, so this is how a reply reaches the client without a second listener.
   */
  /** ⚠️ `arrival` is the kernel's stamp — see ../can/frame-arrival.ts and RunningProbe. */
  handleFrame: (id: number, data: Buffer, arrival?: FrameArrival | null) => boolean;
  /** Stops it. Everything read so far is kept and written. Safe to call more than once. */
  abort: (reason: string) => void;
  /** Rows on record right now, including any carried over from a resumed sweep. */
  rows: () => VcuParameterRow[];
  /** How many parameters a full sweep asks about, so a caller can show "n of N" from the first poll. */
  expected: number;
  finished: Promise<ParameterSweepResult>;
}

/**
 * Starts a sweep and hands back a handle to it.
 *
 * Synchronous on purpose: /vcu-read answers immediately and the page follows along
 * with GET, so `start` must not be waiting on a `readdir` before it can say yes.
 */
export function startParameterSweep(options: ParameterSweepOptions): RunningParameterSweep {
  const client = createVcuKwpClient(options.channel);
  const state: SweepState = { rows: new Map(), stoppedBecause: null, client, pollerRefusal: null };
  const finished = runSweep(options, state);
  return {
    handleFrame: (id, data, arrival) => client.handleFrame(id, data, arrival),
    abort: reason => abort(state, reason),
    rows: () => [...state.rows.values()],
    expected: sweepTargets().length,
    finished,
  };
}

interface SweepState {
  rows: Map<number, VcuParameterRow>;
  /** Set once, by the first thing that stopped the sweep. Later reasons do not overwrite it. */
  stoppedBecause: string | null;
  client: ReturnType<typeof createVcuKwpClient>;
  /**
   * Why the OBD poller would not park, once it has refused. Set once and never cleared.
   *
   * ⚠️ ONE refusal ends the whole firmware block. `holdObdPoller` waits up to 6 s before
   * giving up, so asking 25 times would be 150 s of a sweep doing nothing — and a poller
   * that would not go quiet for the first row is not about to for the twenty-fifth. The
   * remaining block rows are recorded `not-sent` with this sentence, which is true of every
   * one of them, and the rest of the sweep carries on.
   */
  pollerRefusal: string | null;
}

/**
 * Stops the sweep.
 *
 * `client.stop()` is what makes this immediate rather than advisory: it clears the pending
 * request, settles it as `not-sent` — our own doing, never recorded as the bike refusing to
 * answer — and refuses to transmit again.
 *
 * ⚠️ There is deliberately NO "close the session" request on the way out. `0x20`
 * StopDiagnosticSession is not in ./param-codec.ts's union and must not be added for this:
 * the session expires by itself after ~2.5 s of silence, so the clean exit is to stop
 * talking. One more frame to tidy up would be the one case where an abort put traffic on
 * the bus of a bike that had just started moving. docs/vcu-parameters.md §9.
 */
function abort(state: SweepState, reason: string): void {
  if (state.stoppedBecause === null) {
    state.stoppedBecause = reason;
  }
  state.client.stop();
}

async function runSweep(options: ParameterSweepOptions, state: SweepState): Promise<ParameterSweepResult> {
  const targets = sweepTargets();
  // Rows a previous, interrupted sweep already got. Loaded before anything is
  // transmitted so the count on screen starts where the last one left off.
  for (const [index, row] of await loadPartialRows(options.directory)) {
    state.rows.set(index, row);
  }
  // A row that failed is retried; one that answered is never re-asked. That is what
  // makes resuming cheap and what stops a resume carrying yesterday's timeout
  // forward for ever.
  const remaining = targets.filter(target => state.rows.get(target.index)?.status !== "read");
  console.log(
    `vcu-sweep: reading ${remaining.length} parameter(s) (${state.rows.size} already on record from an earlier run)`
  );

  const partial = await openPartialSweepLog(options.directory);
  try {
    await pingMicros(options, state);
    for (const target of remaining) {
      if (!mayContinue(options, state)) {
        break;
      }
      const outcome = await readOneTarget(options, state, target);
      if (state.stoppedBecause !== null) {
        // Aborted while this read was in flight. The outcome is DISCARDED rather
        // than filed: client.stop() settles it as `not-sent`, and writing that down
        // would record our own exit as the bike failing to answer — which the next
        // resume would then believe and retry as if the bike were at fault.
        break;
      }
      const row = toParameterRow(outcome);
      state.rows.set(row.index, row);
      // Written before it is logged, so a hard kill between the two loses the log
      // line and not the datum.
      await partial.append(row);
      options.onRow?.(row);
      console.log(`vcu-sweep: ${describeRow(row)}`);
    }
  } finally {
    // Every exit path closes the handle and stops the client, including a throw:
    // a sweep that died holding an open file and a live pending request would leak
    // both into a service that stays up for weeks.
    await partial.close().catch((err: unknown) => console.warn("vcu-sweep: could not close the resume file:", err));
    state.client.stop();
  }

  // "Complete" means every parameter was ASKED ABOUT, not that every one answered. A slot
  // that refuses or stays silent is a finding in its own right and must not make a finished
  // sweep look truncated for ever — the same distinction src/diagnostics/stored-codes.ts
  // draws between "no codes" and "no answer".
  //
  // ⚠️ `stoppedBecause` is CAPTURED here, on the same line as `complete`, and the captured
  // copy is what is returned. Re-reading `state.stoppedBecause` after the `await` below
  // would read it at a different moment — the writes take a few hundred milliseconds on a
  // Pi's SD card and the watchdog is still armed for part of that — and a finished sweep
  // would then render as "Stopped: the bike stopped being safe to service". Same shape as
  // the wall-clock bug the first review found, and the same fix: read the fact once.
  // docs/vcu-parameters.md §9.
  const stoppedBecause = state.stoppedBecause;
  const complete = stoppedBecause === null && targets.every(target => state.rows.has(target.index));
  const snapshot: VcuParameterSnapshot = {
    readAt: Date.now(),
    complete,
    micros: MICROS,
    rows: [...state.rows.values()].sort((left, right) => left.index - right.index),
  };
  reportTableTypeToConsole(snapshot);
  await writeSnapshot(options.directory, snapshot);
  return { snapshot, stoppedBecause };
}

/**
 * Says whether the bike agrees it runs the parameter table these names came from.
 *
 * Printed after the rows and before the archive is written, because it is the caption
 * for everything above it: 277 name/value pairs just scrolled past, and this is the
 * line that says whether the names on them were the bike's own.
 *
 * Every sweep, not once per process — unlike the `warnedThermalFrame*` flags in
 * ../can/pack-temperature.ts, which guard a warning that would otherwise fire on every
 * CAN frame. A sweep is a deliberate act an owner performs perhaps once a day, so
 * "once" is already what it means, and a run whose table type disagreed would be
 * exactly the run where a suppressed second copy is the one you needed.
 */
function reportTableTypeToConsole(snapshot: VcuParameterSnapshot): void {
  const report = reportTableType(snapshot);
  // Three levels, because there are three outcomes and journalctl grades on them:
  //   error — a micro named a table this software does not carry, the two micros named
  //           DIFFERENT tables, or a micro answered with a record the table's width
  //           forbids. Each one invalidates the NAME of some or all of the rows just
  //           printed; this is the software describing a different bike.
  //   warn  — read, no disagreement, but a micro never answered. Expected on the bike
  //           this repo runs on (the A8's 277 has never been read) and still notable
  //           every time, because the A8 is the micro that owns the one disputed id.
  //   log   — both micros answered and agreed. Routine, and worth recording as such.
  const write =
    report.mismatched || report.split || report.unusable.length > 0
      ? console.error
      : report.confirmed
        ? console.log
        : console.warn;
  for (const line of report.lines) {
    write(`vcu-sweep: ${line}`);
  }
  // ⚠️ Only the STORED snapshot gets re-named from the table the bike just reported
  // (../vcu/snapshot-store.ts). The 277 lines that scrolled past above were named as
  // they arrived, from whatever table was active then — and on a first sweep of an
  // unfamiliar bike that is a default, because 276 is only read partway through the A9
  // pass. On a `RegenFade` bike those lines say `70 CELL_COUNT 81`, and journalctl is
  // the artefact you have when the bike is out of wifi range, so the discrepancy is
  // said out loud rather than left for someone to discover by comparing the two.
  // ⚠️ contentTwinsOf(), not `!==`. 4119 and 16407 are byte-identical 277-row tables under
  // two vehicle-line tags, so a bike reporting one while the Pi names from the other has
  // every name above this line right, and shouting about it would be a false alarm that
  // teaches people to skim past a real one.
  const named = report.tableType;
  const active = activeParameterTable().tableType;
  if (named !== null && named !== active && !contentTwinsOf(named).includes(active)) {
    console.warn(
      `vcu-sweep: ⚠️  the NAMES printed above are ${describeTableType(active)}'s, but this bike runs ` +
        `${describeTableType(named)} — the snapshot on disk and /params.html are re-named from the bike's own ` +
        "table, this scrollback is not. Read it again there if a name matters."
    );
  }
}

/**
 * A pre-flight "is this micro there?" per micro, before 277 reads find out the hard
 * way. The micros answer nothing at all until a session is open, so this is `10 81`
 * followed by `3E` — and a micro that fails it produces one legible log line
 * instead of 233 identical no-sessions.
 */
async function pingMicros(options: ParameterSweepOptions, state: SweepState): Promise<void> {
  for (const micro of MICROS) {
    if (!mayContinue(options, state)) {
      return;
    }
    const reachable = await state.client.ping(micro);
    console.log(`vcu-sweep: ${micro} ${reachable ? "session open, responding" : "NOT responding to 10 81 + 3E"}`);
  }
}

/**
 * The gate check between the loop and the socket.
 *
 * ⚠️ This is HALF of the auto-exit, and which half matters: "no frame after unsafe" is the
 * sentence someone will quote when deciding whether the other half can be dropped. One
 * parameter can put up to FOUR frames on the bus since #223, and a firmware-block row adds
 * a park of up to 6 s in front of them, so a gate transition landing just after a check
 * here can be followed by another frame much later. `readWithPollerParked` therefore calls
 * this again on the far side of the park rather than trusting the check that let it in.
 *
 * What actually BOUNDS it is `stopped` inside kwp-client.ts's `exchange`, set by `abort` —
 * reached from here and from the 200 ms watchdog in ../vcu/read-runner.ts. The arithmetic:
 * docs/vcu-parameters.md §9.
 */
function mayContinue(options: ParameterSweepOptions, state: SweepState): boolean {
  if (state.stoppedBecause !== null) {
    return false;
  }
  const verdict = options.checkGate();
  if (verdict.safe) {
    return true;
  }
  // Loud: this is the bike being ridden away with a diagnostic sweep running, or a
  // signal the gate depends on going quiet. Either is worth a journal line naming
  // which requirement failed, because it is the only record of why a sweep that was
  // going fine suddenly stopped.
  console.warn(`vcu-sweep: leaving service mode — ${verdict.blockers.join("; ")}`);
  abort(state, `the bike stopped being safe to service — ${verdict.blockers.join("; ")}`);
  return false;
}

/**
 * One target, read — with the OBD poller parked first if this is a firmware-block row.
 *
 * ⚠️ The rule is "the width is a CLAIM, not a measurement", not "the record is wide". The
 * 277's widths have 233 live records behind them; the block's have one disassembly, and a
 * width that is wrong is wrong in the direction that opens a transfer for the poller to
 * land in.
 *
 * ⚠️ An abort during the park is WAITED OUT and cannot be checked away — a re-check before
 * the `await` would be dead code, since the loop's `mayContinue` runs in the same
 * synchronous block as this prologue. Nothing transmits meanwhile; what is delayed is the
 * bus lease coming free. Both arguments in full: docs/vcu-parameters.md §9.
 */
async function readOneTarget(
  options: ParameterSweepOptions,
  state: SweepState,
  target: SweepTarget
): Promise<VcuReadOutcome> {
  if (!target.widthUnverified) {
    return state.client.readParameter(target.micro, target.index);
  }
  if (state.pollerRefusal !== null) {
    return notSent(target, state.pollerRefusal);
  }
  const held = await withObdPollerHold(
    `a parameter sweep's read of ${target.micro} index ${target.index}`,
    () => readWithPollerParked(options, state, target),
    options.acquirePollerHold
  );
  if (held.ok) {
    return held.result;
  }
  // ⚠️ The stored sentence is GENERIC, and `held.reason` is only logged. That reason names
  // the row that was refused ("…read of A8 index 278…"), and it is stamped on the other 24
  // as well — so index 1007's row would have said the poller would not park for a read of
  // 278. A row must never claim something about itself that nobody established, least of
  // all an index that is not its own.
  console.warn(`vcu-sweep: ${held.reason}`);
  state.pollerRefusal = POLLER_REFUSAL;
  return notSent(target, POLLER_REFUSAL);
}

/**
 * The read itself, inside the hold.
 *
 * ⚠️ The gate is re-checked HERE, after the park. Parking can take up to 6 s
 * (`HOLD_WAIT_MS`), which is thirty gate-watchdog intervals, and transmitting on a decision
 * taken before that wait would be a frame sent on a bike that may have started moving
 * meanwhile. In the service the 200 ms watchdog wins that race anyway — it calls `abort`,
 * and `client.stop()` settles the read as `not-sent` — so this is defence in depth, and it
 * is the ONLY guard in a check harness, which has no watchdog running.
 */
async function readWithPollerParked(
  options: ParameterSweepOptions,
  state: SweepState,
  target: SweepTarget
): Promise<VcuReadOutcome> {
  if (!mayContinue(options, state)) {
    // ⚠️ What matters here is the `return` — nothing is transmitted. The ROW is thrown
    // away: `mayContinue` sets `stoppedBecause` whenever it refuses, and the loop discards
    // every outcome once that is set, because our own exit must never be filed as the bike
    // failing to answer. The `??` is for the type checker, which cannot see the first half.
    return notSent(target, state.stoppedBecause ?? POLLER_REFUSAL);
  }
  return state.client.readParameter(target.micro, target.index);
}

/**
 * What every block row says when the poller would not go quiet — the same sentence
 * `withObdPollerHold` returns, with a subject that is true of all 25 rather than of the
 * one the hold was refused for. Built by ../can/obd-hold.ts so there is one wording.
 */
const POLLER_REFUSAL = pollerRefusalFor("the A8 rows whose width comes from the firmware table");

/** A row nothing was asked for. OUR doing, never the bike's — the distinction ./kwp-client.ts draws. */
function notSent(target: SweepTarget, reason: string): VcuReadOutcome {
  return {
    micro: target.micro,
    index: target.index,
    identifier: identifierForIndex(target.index),
    status: "not-sent",
    reason,
    flowControlLatency: null,
  };
}
