import type { RawChannel } from "socketcan";
import { ageMs, latestValue } from "../can/signals.ts";
import { evaluateServiceGate, serviceGateSignalKeys, type ServiceGateVerdict } from "./service-gate.ts";
import { startParameterSweep, type RunningParameterSweep } from "./sweep.ts";
import { startProbe, type RunningProbe, type VcuProbeReading, type VcuProbeRequest } from "./probe.ts";
import { PARAMETER_TABLE, type VcuMicro } from "./param-table.ts";
import type { VcuParameterRow } from "./snapshot.ts";

// Service mode's engine: decide whether the bike may be serviced, run one parameter
// sweep in this process while that stays true, and put service mode straight back
// out the moment it does not.
//
// ── What changed, and why the old rule no longer applies ─────────────────────
// This used to `spawn` scripts/read-vcu-params.ts and watch the files it left
// behind, so that the always-on service could truthfully say it never asked the
// micros anything. That rule bought one thing — a bright line nobody could cross by
// accident — and cost three: a second copy of the resume/partial/baseline rules, a
// progress feed parsed back off disk, and a cross-process clock comparison to work
// out which archive belonged to which run.
//
// The bright line is now drawn somewhere better. Service mode is entered only with
// the bike PROVED stationary and out of drive (./service-gate.ts), and it is left
// automatically the instant that stops being true — so "the service does not touch
// the micros" becomes "the service touches the micros only when the motorcycle
// cannot move", which is the property that was actually wanted. Reading is still
// read-only by construction: ./param-codec.ts's request union has three members and
// its encoder throws on anything else, and nothing in this file or in the HTTP layer
// can name a service, an identifier or a value.
//
// ── The exit path, which is the part that matters ────────────────────────────
// Two independent things stop a sweep, and both end in the same `abort`:
//
//  1. The sweep asks the gate before EVERY request (./sweep.ts, `mayContinue`), so
//     the check precedes the socket rather than racing it.
//  2. A watchdog here re-checks the gate every GATE_WATCH_INTERVAL_MS and calls
//     `abort` from outside the loop. That is what bounds the worst case: one
//     `readParameter` can spend ~1.2 s inside itself (a reply window, a session
//     re-open, a second reply window), and without the watchdog a bike that started
//     moving during one would keep four more frames on the bus until the loop came
//     back round.
//
// `abort` calls `client.stop()`, which clears the pending request and refuses every
// subsequent transmit, so the sweep cannot emit one more frame on its way out. The
// diagnostic session it opened is left to expire by itself after ~2.5 s of silence,
// which is the documented behaviour and is why there is no closing frame to send —
// see the note on `abort` in ./sweep.ts.
//
// Nothing read is lost on the way out: every row was appended to the resume file as
// it arrived, the partial snapshot is written and labelled `complete: false`, and
// starting again resumes from where it stopped.

/** How the last (or current) sweep is going. A closed union so the page cannot render a state we did not mean. */
export type VcuReadState =
  /** Nothing has been started since this process came up. Says nothing about whether a snapshot exists. */
  | { phase: "idle" }
  | { phase: "running"; startedAt: number; expected: number; tally: VcuReadTally }
  /**
   * The sweep ran to the end of its list. `complete` is the sweep's own flag —
   * every parameter was ASKED ABOUT, which is not the same as every one answering,
   * and `tally` is where that difference shows.
   */
  | { phase: "finished"; startedAt: number; finishedAt: number; complete: boolean; tally: VcuReadTally }
  /**
   * Stopped early, or never got going. Kept apart from `finished` with its own
   * reason because "we could not start", "the owner stopped it" and "the bike
   * started moving" are different claims, and only one of them is about a fault.
   */
  | { phase: "failed"; startedAt: number; finishedAt: number; reason: string; tally: VcuReadTally };

/** Rows on record for a sweep, counted the two ways that make a failure legible. */
export interface VcuReadTally {
  /** Rows written down so far, including any carried over from a resumed sweep. */
  total: number;
  /** …of which answered with a record. The number a human actually wants. */
  read: number;
  /** Every outcome by name, so "44 refused" and "44 no-session" do not look alike. */
  byStatus: Record<VcuParameterRow["status"], number>;
  /** Per micro, because "the A8 was asleep" must not read as "the bike lost 44 parameters". */
  micros: { micro: VcuMicro; read: number; failed: number }[];
}

export interface VcuReadRunner {
  /** Starts a sweep. Answers with why not, rather than throwing, when it may not. */
  start: () => { started: boolean; reason: string | null };
  /** Asks a running sweep to stop, keeping what it has. False if none is running. */
  cancel: () => boolean;
  /** The current state. Synchronous and allocation-cheap: everything is in memory. */
  state: () => VcuReadState;
  /** The gate as it reads right now, for the page to show whether service mode is available. */
  gate: () => ServiceGateVerdict;
  /**
   * Reads ONE identifier off ONE target — service mode's probe.
   *
   * Behind the same gate and the same single-flight as a sweep: two things must not
   * share the bus, and there is one reply id per target with no request tag to match
   * on, so a probe running alongside a sweep would be answered by whichever frame
   * landed first. Resolves with a refusal rather than throwing.
   */
  probe: (request: VcuProbeRequest) => Promise<VcuProbeOutcomeOrRefusal>;
  /**
   * Feed CAN frames here; true when consumed. No-op unless a sweep is running, so
   * the service's frame router pays one null check per OBD-range frame and nothing
   * at all the rest of the time.
   */
  handleCanFrame: (id: number, data: Buffer) => boolean;
  /**
   * Stops any running sweep, for shutdown. Resolves once it has written itself
   * down — await it, or `process.exit()` takes the archive with it.
   */
  stop: () => Promise<void>;
}

/** A probe's answer, or the reason there is not one. Never throws into an HTTP handler. */
export type VcuProbeOutcomeOrRefusal = { ok: true; reading: VcuProbeReading } | { ok: false; reason: string };

export interface VcuReadRunnerOptions {
  /**
   * The service's CAN channel, already up and started; null when CAN_ENABLED=0 or
   * bring-up failed, in which case a read is refused rather than attempted.
   *
   * A getter rather than the channel itself so the runner can be built BEFORE the
   * bus is, which is what lets `handleCanFrame` be wired into the frame router in
   * the same breath as the router is created. Capturing the channel would have made
   * this file's construction order load-bearing in src/index.ts.
   */
  channel: () => RawChannel | null;
  /**
   * False when the bus was brought up listen-only (OBD_ENABLED=0). A listen-only
   * interface swallows every request silently and the result is indistinguishable
   * from a switched-off bike, so this is refused up front rather than reported as
   * 277 no-sessions — the same trap scripts/read-vcu-params.ts used to warn about
   * by shelling out to `ip`.
   */
  busIsActive: boolean;
  /** Where the resume file and the snapshots go. */
  directory: string;
}

/**
 * How often the gate is re-checked while a sweep runs.
 *
 * 200 ms is twenty frames of a 100 Hz broadcast, so it cannot miss a state change,
 * and it is two thirds of one reply window — short enough that a `readParameter`
 * caught mid-retry is stopped inside it rather than after it.
 */
const GATE_WATCH_INTERVAL_MS = 200;

/** Every status a row can carry, so a tally always has all the keys and the page never sees `undefined`. */
const ROW_STATUSES: VcuParameterRow["status"][] = [
  "read",
  "refused",
  "no-response",
  "no-session",
  "multi-frame",
  "unrecognised",
  "not-sent",
];

interface RunnerContext extends VcuReadRunnerOptions {
  sweep: RunningParameterSweep | null;
  /** At most one of `sweep` and `probe` is ever set. Both put frames on the same bus. */
  probe: RunningProbe | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Null while running and once a run ended cleanly; a sentence for a cancel, a gate exit or a crash. */
  failure: string | null;
  /** The tally of the run that just ended, kept so `state()` needs no disk and no clock. */
  lastTally: VcuReadTally | null;
  lastComplete: boolean;
  watchdog: ReturnType<typeof setInterval> | null;
}

export function createVcuReadRunner(options: VcuReadRunnerOptions): VcuReadRunner {
  const context: RunnerContext = {
    ...options,
    sweep: null,
    probe: null,
    startedAt: null,
    finishedAt: null,
    failure: null,
    lastTally: null,
    lastComplete: false,
    watchdog: null,
  };
  return {
    start: () => start(context),
    cancel: () => cancel(context),
    state: () => readState(context),
    gate: () => readGate(),
    probe: request => runProbe(context, request),
    // Whichever is running gets the frame; neither running means it was not ours.
    handleCanFrame: (id, data) => (context.sweep ?? context.probe)?.handleFrame(id, data) ?? false,
    stop: () => stop(context),
  };
}

/**
 * The gate as it reads right now.
 *
 * Sampling lives here and the DECISION lives in ./service-gate.ts, which is what
 * keeps every branch of the decision reachable from a laptop. `ageMs` is the
 * monotonic age from src/can/signals.ts and never a `Date.now()` difference — on a
 * Pi that steps its own clock, a backwards step would otherwise make a stale
 * reading look fresh, and on this particular decision that means declaring a moving
 * motorcycle parked.
 */
function readGate(): ServiceGateVerdict {
  const readings = Object.fromEntries(
    serviceGateSignalKeys().map(key => [key, { value: latestValue(key), ageMs: ageMs(key) }])
  );
  return evaluateServiceGate(readings);
}

/**
 * Single-flight WITHIN this process, which is now the whole story: the sweep runs
 * here, so there is no longer a second copy of it anyone can start over ssh, and no
 * lockfile to go stale on a Pi that loses power.
 */
function start(context: RunnerContext): { started: boolean; reason: string | null } {
  const ready = checkPreconditions(context);
  if (!ready.ok) {
    return { started: false, reason: ready.reason };
  }
  const channel = ready.channel;

  const sweep = startParameterSweep({
    channel,
    directory: context.directory,
    checkGate: readGate,
  });
  context.sweep = sweep;
  context.startedAt = Date.now();
  context.finishedAt = null;
  context.failure = null;
  context.lastTally = null;
  context.lastComplete = false;
  startGateWatchdog(context, sweep);

  // Fire-and-forget on purpose: start() answers the HTTP request immediately and the
  // page follows along with GET. Every outcome, including a throw, lands in the
  // context below — nothing here can reject into an unhandled rejection.
  void sweep.finished
    .then(result => {
      context.lastComplete = result.snapshot.complete;
      context.failure = result.stoppedBecause;
      console.log(`vcu-read: sweep ended (${result.stoppedBecause ?? "complete"})`);
    })
    .catch((err: unknown) => {
      // Never swallowed: a sweep that threw looks identical to a silent bike on
      // screen unless it is said out loud, and this is a bike we cannot attach a
      // debugger to.
      console.error("vcu-read: the sweep failed:", err);
      context.failure = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      context.lastTally = tallyOf(sweep.rows());
      context.finishedAt = Date.now();
      context.sweep = null;
      stopGateWatchdog(context);
    });

  console.log("vcu-read: started an in-process parameter sweep — the bike checked out as parked and out of drive");
  return { started: true, reason: null };
}

/**
 * Everything that has to be true before ANY frame goes out, in one place.
 *
 * Shared by the sweep and the probe deliberately: two entry points that each decided
 * for themselves whether the bike was safe would be two things to keep in step, and
 * the one that drifted would be the one nobody was looking at.
 */
function checkPreconditions(context: RunnerContext): { ok: true; channel: RawChannel } | { ok: false; reason: string } {
  if (context.sweep) {
    return { ok: false, reason: "a parameter read is already running" };
  }
  if (context.probe) {
    return { ok: false, reason: "a probe is already running" };
  }
  const channel = context.channel();
  if (!channel) {
    return { ok: false, reason: "CAN is switched off on this Pi (CAN_ENABLED=0) — there is no bus to read" };
  }
  if (!context.busIsActive) {
    return {
      ok: false,
      reason: "the bus is listen-only (OBD_ENABLED=0) — nothing can be transmitted, so every read would time out",
    };
  }
  const verdict = readGate();
  if (!verdict.safe) {
    return { ok: false, reason: `the bike is not safe to service — ${verdict.blockers.join("; ")}` };
  }
  return { ok: true, channel };
}

/**
 * One probe, start to finish.
 *
 * Awaited rather than fire-and-forget, unlike a sweep: this is two reply windows at
 * worst, so the HTTP request can simply hold until it answers and the page gets the
 * reading in the response it asked for. There is no progress to follow and nothing
 * to resume.
 *
 * The gate watchdog runs for it too. A single read is short, but "short" here means
 * up to ~1.2 s of a bike that might have started moving, and the rule this feature
 * rests on is that nothing transmits once the gate shuts — not that nothing
 * transmits for long.
 */
async function runProbe(context: RunnerContext, request: VcuProbeRequest): Promise<VcuProbeOutcomeOrRefusal> {
  const ready = checkPreconditions(context);
  if (!ready.ok) {
    return { ok: false, reason: ready.reason };
  }
  const probe = startProbe({ ...request, channel: ready.channel });
  context.probe = probe;
  const watchdog = startWatchdog(reason => probe.abort(reason));
  console.log(
    `vcu-probe: reading bank ${request.bank} index ${request.index} off ${request.target} — the bike checked out as safe to service`
  );
  try {
    const reading = await probe.finished;
    console.log(`vcu-probe: ${request.target} 0x${reading.identifier.toString(16)} → ${reading.status}`);
    return { ok: true, reading };
  } catch (err) {
    // Never swallowed, and never allowed to reject into the HTTP handler: a probe
    // that threw looks the same as a silent bike on screen unless it is said out loud.
    console.error("vcu-probe: the probe failed:", err);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(watchdog);
    context.probe = null;
  }
}

function cancel(context: RunnerContext): boolean {
  if (!context.sweep) {
    return false;
  }
  context.sweep.abort("stopped from the dashboard — everything read so far was kept");
  console.log("vcu-read: cancel requested");
  return true;
}

/**
 * Shutdown. Awaited by src/index.ts, and that matters.
 *
 * `abort` settles the request in flight straight away and blocks every transmit
 * after it, but the sweep then still has to close the resume file and write its
 * archive — tens of milliseconds of local I/O. `process.exit(0)` follows immediately
 * in the shutdown path, so a fire-and-forget stop would take the archive with it and
 * a run cut short by a `systemctl restart` (which is what deploy IS here) would
 * leave no record of itself. Nothing READ would be lost either way — every row is
 * already in `sweep.partial.jsonl` — but "0 of 277" and "we stopped at 41" are
 * different claims and the second one is the true one.
 */
async function stop(context: RunnerContext): Promise<void> {
  const sweep = context.sweep;
  stopGateWatchdog(context);
  // A probe is at most two reply windows long and holds no file handle and no
  // partial state, so it is aborted and not waited for — unlike a sweep, which has
  // an archive to write.
  context.probe?.abort("the service is shutting down");
  if (!sweep) {
    return;
  }
  sweep.abort("the service is shutting down — everything read so far was kept");
  // Never rejects into the shutdown path: the sweep's own failure is already
  // reported by the handler in start(), and a throw here would skip everything
  // after this call in index.ts's shutdown.
  //
  // ⚠️ This works ONLY because ../vcu/sweep.ts awaits writeSnapshot() inside
  // runSweep, before the promise settles. Move the archive write out of that
  // promise — into a `.then`, a listener, anything — and awaiting here stops
  // meaning anything: `process.exit(0)` is a few lines behind us and the write
  // would not have happened. This resolves one microtask before start()'s
  // `.finally()`, so `lastTally` and `finishedAt` are still unset at exit; that is
  // fine, because nothing reads them after a shutdown.
  await sweep.finished.catch(() => undefined);
}

/**
 * Re-checks the gate on a timer while a sweep runs, and stops it from outside the
 * loop.
 *
 * This is the half of auto-exit that bounds the worst case. The sweep's own check
 * runs between parameters, which is every ~310 ms in the good case but up to ~1.2 s
 * when a read times out and the session is re-opened; a bike that starts moving
 * during one of those would otherwise keep several more frames on the bus. Calling
 * `abort` from here settles the request in flight immediately and blocks every
 * transmit after it.
 */
function startGateWatchdog(context: RunnerContext, sweep: RunningParameterSweep): void {
  stopGateWatchdog(context);
  context.watchdog = startWatchdog(reason => {
    sweep.abort(reason);
    // One abort is the whole job. Left running, this would re-fire every 200 ms
    // through the sweep's wind-down — the file close, the archive write, the
    // 277-row diff — printing the same blocker line two or three times for one
    // event. `abort` is idempotent so it did no harm, but a log that repeats reads
    // as three things happening.
    stopGateWatchdog(context);
  });
}

/**
 * A timer that re-reads the gate and calls `onUnsafe` once when it shuts.
 *
 * Shared by the sweep and the probe so there is one interval, one threshold and one
 * log line to reason about. The caller decides what stopping means; this only
 * decides when.
 */
function startWatchdog(onUnsafe: (reason: string) => void): ReturnType<typeof setInterval> {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) {
      return;
    }
    const verdict = readGate();
    if (verdict.safe) {
      return;
    }
    fired = true;
    console.warn(`vcu-read: leaving service mode — ${verdict.blockers.join("; ")}`);
    onUnsafe(`the bike stopped being safe to service — ${verdict.blockers.join("; ")}`);
  }, GATE_WATCH_INTERVAL_MS);
  // Neither a sweep nor a probe may be the reason a `systemctl stop` hangs, and this
  // timer must never be the reason the process stays alive on its own.
  timer.unref?.();
  return timer;
}

function stopGateWatchdog(context: RunnerContext): void {
  if (context.watchdog) {
    clearInterval(context.watchdog);
    context.watchdog = null;
  }
}

function readState(context: RunnerContext): VcuReadState {
  if (context.sweep && context.startedAt !== null) {
    return {
      phase: "running",
      startedAt: context.startedAt,
      // What a full sweep will ask about — the whole table, so this cannot drift
      // from what the sweep actually does.
      expected: PARAMETER_TABLE.length,
      tally: tallyOf(context.sweep.rows()),
    };
  }
  if (context.startedAt === null || context.finishedAt === null || context.lastTally === null) {
    // Either nothing has run, or a run is half-recorded between its two callbacks.
    // Both mean there is no run of ours to describe; the snapshot on disk is still
    // served by /vcu-params either way.
    return { phase: "idle" };
  }
  if (context.failure) {
    return {
      phase: "failed",
      startedAt: context.startedAt,
      finishedAt: context.finishedAt,
      reason: context.failure,
      tally: context.lastTally,
    };
  }
  return {
    phase: "finished",
    startedAt: context.startedAt,
    finishedAt: context.finishedAt,
    complete: context.lastComplete,
    tally: context.lastTally,
  };
}

/** Counts rows the two ways the page needs them. Pure. */
export function tallyOf(rows: VcuParameterRow[]): VcuReadTally {
  const byStatus = Object.fromEntries(ROW_STATUSES.map(status => [status, 0])) as VcuReadTally["byStatus"];
  const perMicro = new Map<VcuMicro, { micro: VcuMicro; read: number; failed: number }>();
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const entry = perMicro.get(row.micro) ?? { micro: row.micro, read: 0, failed: 0 };
    if (row.status === "read") {
      entry.read += 1;
    } else {
      entry.failed += 1;
    }
    perMicro.set(row.micro, entry);
  }
  return {
    total: rows.length,
    read: byStatus["read"],
    byStatus,
    micros: [...perMicro.values()].sort((left, right) => left.micro.localeCompare(right.micro)),
  };
}
