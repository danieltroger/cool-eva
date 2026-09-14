import type { RawChannel } from "socketcan";
import type { FrameArrival } from "../can/frame-arrival.ts";
import { ageMs, latestValue } from "../can/signals.ts";
import { acquireBus, busHeldBy, type BusLease } from "./bus-lease.ts";
import { evaluateServiceGate, sampleServiceGate, type ServiceGateVerdict } from "./service-gate.ts";
import { startParameterSweep, type RunningParameterSweep } from "./sweep.ts";
import { startProbe, type VcuProbeReading, type VcuProbeRequest } from "./probe.ts";
import { describeMeasurement, startLifetimeRead, type LifetimeReadResult } from "./lifetime-read.ts";
import { withObdPollerHold } from "../can/obd-hold.ts";
import type { VcuMicro } from "./param-table.ts";
import type { VcuParameterRow } from "./snapshot.ts";

// Service mode's engine: decide whether the bike may be serviced, run one parameter sweep
// in this process while that stays true, and put service mode straight back out the moment
// it does not. Reading is still read-only by construction — nothing in this file or in the
// HTTP layer can name a service, an identifier or a value.
//
// ⚠️ THE EXIT PATH IS THE PART THAT MATTERS. Two independent things stop a sweep, and both
// end in the same `abort`:
//
//  1. The sweep asks the gate before EVERY request (./sweep.ts, `mayContinue`), so the
//     check precedes the socket rather than racing it.
//  2. A watchdog here re-checks the gate every GATE_WATCH_INTERVAL_MS and calls `abort`
//     from outside the loop. That is what bounds the worst case: one `readParameter` can
//     spend ~1.33 s inside itself, and without the watchdog a bike that started moving
//     during one would keep five more frames on the bus until the loop came back round.
//     (Both numbers grew with #223: a reply that starts and stalls costs a transfer
//     window on top of the reply window, and a First Frame draws a flow control.)
//
// `abort` calls `client.stop()`, which refuses every subsequent transmit, so the sweep
// cannot emit one more frame on its way out. The session it opened is left to expire by
// itself after ~2.5 s of silence, which is why there is no closing frame to send.
//
// Nothing read is lost on the way out. Why this stopped being a spawned script, and why
// that traded a bright line for a better one: docs/vcu-parameters.md §9.

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
   * Reads the bike's lifetime battery statistics — components 51 and 52 — in this
   * process, behind the same gate and the same single-flight as a sweep or a probe.
   *
   * ⚠️ It PARKS THE 2 Hz OBD POLLER for the duration, and so does a probe since #223:
   * a parameter read's reply can be multi-frame too, and the poller is the documented
   * cause of that channel's failures (src/can/obd.ts). A SWEEP parks for part of its
   * list only — see `runParameterSweep`. The result carries
   * how late our flow control was, which is the number this whole path exists to
   * produce. Resolves with a refusal rather than throwing.
   */
  readLifetimeStatistics: () => Promise<LifetimeReadOutcomeOrRefusal>;
  /**
   * Feed CAN frames here; true when consumed. A no-op unless a sweep or a one-shot
   * module is running, so the service's frame router pays two null checks per
   * OBD-range frame and nothing at all the rest of the time.
   *
   * ⚠️ `arrival` is REQUIRED — see `OneShotBusModule.handleFrame`.
   */
  handleCanFrame: (id: number, data: Buffer, arrival: FrameArrival | null) => boolean;
  /**
   * Stops any running sweep, for shutdown. Resolves once it has written itself
   * down — await it, or `process.exit()` takes the archive with it.
   */
  stop: () => Promise<void>;
}

/** A lifetime read's result, or the reason there is not one. */
export type LifetimeReadOutcomeOrRefusal = { ok: true; result: LifetimeReadResult } | { ok: false; reason: string };

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

/**
 * Every status a row can carry, at zero, so a tally always has all the keys and the page
 * never sees `undefined`.
 *
 * ⚠️ A RECORD, not an array — so adding a status to the union is a missing-property error
 * here and retiring one an excess-property error. As a `VcuParameterRow["status"][]` only
 * the retirement was caught, and an added status simply vanished from the phone's
 * breakdown (`public/views/service-mode.js` renders whatever keys the tally has) — the
 * failure you would only notice by the thing you added it to see not being there. Same
 * reasoning as `RECORD_LENGTH_BYTES` in ../vcu/param-file.ts.
 */
const ZERO_BY_STATUS: VcuReadTally["byStatus"] = {
  "read": 0,
  "refused": 0,
  "no-response": 0,
  "no-session": 0,
  "stalled": 0,
  "abandoned": 0,
  "unrecognised": 0,
  "not-sent": 0,
};

interface RunnerContext extends VcuReadRunnerOptions {
  sweep: RunningParameterSweep | null;
  /**
   * The one-shot module running, if any — a probe or a lifetime-statistics read.
   *
   * ⚠️ ONE field rather than one per kind, and it carries its own NAME. The refusal a
   * caller reads is built from that name, so a second kind cannot inherit the first
   * one's message: before this, a lifetime read blocked by a probe would have been told
   * "a probe is already running" and vice versa, which is a lie a person acts on.
   */
  oneShot: { name: string; module: OneShotBusModule } | null;
  /**
   * The bus lease held by whichever of the two is running, or null.
   *
   * ⚠️ Added 2026-08-16 alongside service WRITES, which live in their own runner
   * (./write-runner.ts) and therefore cannot be excluded by the two nullable fields
   * above. The lease is what makes single-flight hold ACROSS files. Released in the
   * same place the field is cleared, on every path including a throw — a leaked
   * lease would make service mode permanently refuse itself, which is why the two
   * always move together.
   */
  lease: BusLease | null;
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
    oneShot: null,
    lease: null,
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
    readLifetimeStatistics: () => runLifetimeRead(context),
    // Whichever is running gets the frame; neither running means it was not ours.
    handleCanFrame: (id, data, arrival) =>
      (context.sweep ?? context.oneShot?.module)?.handleFrame(id, data, arrival) ?? false,
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
  // ⚠️ The gate chooses what to sample, not this file. It used to be the other way round
  // and the two disagreed: the charge evidence was never asked for, so a charging bike was
  // refused for a month with "the drive is not energized" while every check said otherwise.
  return evaluateServiceGate(sampleServiceGate(key => ({ value: latestValue(key), ageMs: ageMs(key) })));
}

/**
 * Single-flight WITHIN this process, which is now the whole story: the sweep runs
 * here, so there is no longer a second copy of it anyone can start over ssh, and no
 * lockfile to go stale on a Pi that loses power.
 *
 * ⚠️ A SWEEP DOES NOT PARK THE OBD POLLER FOR THE 277 `params.ecf` DESCRIBES, where a probe
 * and a lifetime read park for everything: a sweep can run for a minute against a 15 s
 * `MAX_HOLD_MS`, and every record in those 277 is 1 or 2 bytes — measured, not claimed — so
 * no transfer window ever opens for the poller to land in.
 *
 * ⚠️ **It DOES park, per read, for the 25 rows of #219's A8 block** (../vcu/sweep-targets.ts),
 * whose widths come from a firmware image nobody has matched against what is flashed — the
 * objection `runProbe` records below against parking off a width. Why all 25 and not the
 * three wide ones, and what a refused park does: docs/vcu-parameters.md §9.
 */
function start(context: RunnerContext): { started: boolean; reason: string | null } {
  const ready = checkPreconditions(context, "a parameter read");
  if (!ready.ok) {
    return { started: false, reason: ready.reason };
  }
  const channel = ready.channel;
  context.lease = ready.lease;

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
      // Released in the same breath the field is cleared, on every path including a
      // throw — the `.catch` above is what makes this `.finally` reachable after one.
      // A lease that outlived its sweep would make service mode refuse itself for as
      // long as the process stayed up.
      context.lease?.release();
      context.lease = null;
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
function checkPreconditions(
  context: RunnerContext,
  what: string
): { ok: true; channel: RawChannel; lease: BusLease } | { ok: false; reason: string } {
  const ready = checkBusFreeRefusals(context);
  if (!ready.ok) {
    return ready;
  }
  const lease = acquireBus(what);
  if (!lease.ok) {
    return { ok: false, reason: `${lease.heldBy} is using the bus — one thing at a time` };
  }
  return { ok: true, channel: ready.channel, lease: lease.lease };
}

/**
 * Every reason to refuse that costs nothing to find out.
 *
 * ⚠️ SEPARATE SO THEY CAN BE ANSWERED FIRST. The lifetime read parks the OBD poller
 * before it opens a session, and parking it to discover that CAN is switched off means
 * a six-second wait for a loop that does not exist, answered with a sentence about the
 * poller — while the true reason sits right here. Worse on a Pi where the poller IS
 * running: a refusal that was always going to be a refusal costs the rest of a poll
 * round, and a whole trouble-code cycle if it lands on the round that reads them.
 */
function checkBusFreeRefusals(
  context: RunnerContext
): { ok: true; channel: RawChannel } | { ok: false; reason: string } {
  if (context.sweep) {
    return { ok: false, reason: "a parameter read is already running" };
  }
  if (context.oneShot) {
    return { ok: false, reason: `${context.oneShot.name} is already running` };
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
  // ⚠️ The CROSS-FILE lease, and it has to be asked HERE rather than left to
  // `checkPreconditions`. Since a one-shot read parks the OBD poller first, a probe
  // pressed while the trouble-code clear holds the bus would otherwise spend the park
  // wait — up to 6 s — and come back blaming the poller, for a bus that was never going
  // to be free. `busHeldBy` costs nothing and names who has it.
  const holder = busHeldBy();
  if (holder !== null) {
    // ⚠️ Word for word what `checkPreconditions` says when `acquireBus` refuses below,
    // because it is the same refusal found earlier — two wordings for one condition is
    // what makes a journal ungreppable.
    return { ok: false, reason: `${holder} is using the bus — one thing at a time` };
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
 * up to ~1.33 s of a bike that might have started moving, and the rule this feature
 * rests on is that nothing transmits once the gate shuts — not that nothing
 * transmits for long.
 */
async function runProbe(context: RunnerContext, request: VcuProbeRequest): Promise<VcuProbeOutcomeOrRefusal> {
  // ⚠️ Logged HERE as well as by the shared runner, and with the `vcu-probe:` prefix a
  // journal is grepped by: the shared line cannot name an identifier it knows nothing
  // about, and a probe that hangs or is aborted by the gate watchdog would otherwise
  // never say which one it was — on a bike you cannot attach a debugger to.
  console.log(`vcu-probe: reading bank ${request.bank} index ${request.index} off ${request.target}`);
  // ⚠️ THE POLLER IS PARKED, as it is for a lifetime read and for the same reason: since
  // #223 a probe's reply can be multi-frame, and ../can/obd.ts records that "a request
  // arriving mid-transfer is what makes the VCU abandon it". A probe is the read most
  // likely to be pointed at a wide record — that is what it is for — so racing the 2 Hz
  // poller would produce intermittent `stalled` outcomes indistinguishable from a micro
  // that went quiet. A sweep parks only for the 25 rows whose width is a firmware claim
  // rather than a measurement; see the note on `runParameterSweep`.
  //
  // ⚠️ Unconditionally, including for the 1- and 2-byte reads that cannot need it, which
  // costs ~0.2-1 s of telemetry (the poller's park wait) on a manual button press. The
  // cheaper form — park only when the name table says the record is wide — was weighed
  // and rejected: it skips the park exactly where the table is WRONG about a parameter,
  // which is the entire finding of #219 and the reason this path exists.
  const what = "a probe";
  const outcome = await runOneShotBusModule(context, what, channel => startProbe({ ...request, channel }));
  if (!outcome.ok) {
    console.log(`vcu-probe: ${request.target} bank ${request.bank} index ${request.index} — ${outcome.reason}`);
    return outcome;
  }
  console.log(`vcu-probe: ${request.target} 0x${outcome.result.identifier.toString(16)} → ${outcome.result.status}`);
  return { ok: true, reading: outcome.result };
}

/**
 * The lifetime read, with the poller parked around it.
 *
 * ⚠️ THE HOLD IS TAKEN BEFORE THE LEASE and released after it, and both releases are in
 * `finally`s. The bus must be quiet before the session opens, not after the First Frame
 * has already raced a mode-01 reply. If the poller will not park, the read is refused
 * rather than attempted on a busy bus — the failure it would produce is a stalled
 * transfer, which is indistinguishable from a bike that did not answer.
 */
async function runLifetimeRead(context: RunnerContext): Promise<LifetimeReadOutcomeOrRefusal> {
  const what = "a lifetime-statistics read";
  const outcome = await runOneShotBusModule(context, what, channel => startLifetimeRead({ channel }));
  if (outcome.ok) {
    console.log(`vcu-read: lifetime statistics — ${describeMeasurement(outcome.result)}`);
  }
  return outcome;
}

/** A probe or a lifetime read: one bounded exchange, driven the same way. */
export interface OneShotBusModule<T = unknown> {
  /**
   * ⚠️ `arrival` is REQUIRED here, unlike on the transports underneath. Dropping it
   * anywhere on this path silently un-measures the one thing the in-service read exists
   * to measure, and a check cannot see the difference — so the type is what stops it.
   */
  handleFrame: (id: number, data: Buffer, arrival: FrameArrival | null) => boolean;
  abort: (reason: string) => void;
  finished: Promise<T>;
}

/**
 * Preconditions → start → watchdog → await → release, for the modules that are one
 * bounded exchange rather than a 277-read sweep.
 *
 * ⚠️ Factored rather than copied: `runProbe` and the lifetime read are structurally
 * identical, and the gate watchdog, the `finally` that releases everything, and the
 * refusal-rather-than-throw contract are the parts that must not diverge.
 *
 * ⚠️ It did NOT shrink this file — 505 lines to ~655, and an earlier draft of this
 * comment claimed the opposite. The win is that a second kind of one-shot read cannot
 * inherit the first one's refusal message or forget one of its releases.
 *
 * The file is past the ~400 guideline and splitting it is its own migration. The seam,
 * so the next person does not have to find it: `OneShotBusModule`,
 * `runOneShotBusModule`, `runHeldOneShot`, `startWatchdog` and `startGateWatchdog`
 * are ~130 self-contained lines that already take the context as a parameter.
 */
async function runOneShotBusModule<T>(
  context: RunnerContext,
  what: string,
  start: (channel: RawChannel) => OneShotBusModule<T>
): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  // ⚠️ FIRST, and before the poller hold — every refusal that costs nothing to find
  // out. A read refused for a switched-off bus must say so, not park the OBD poller for
  // six seconds and then blame the poller.
  const free = checkBusFreeRefusals(context);
  if (!free.ok) {
    return free;
  }
  // ⚠️ UNCONDITIONAL, and through ../can/obd-hold.ts's wrapper rather than a park helper
  // of our own. Both one-shot reads want the poller quiet for one reason — a reply that
  // spans frames is abandoned by the VCU if a request lands mid-transfer (../can/obd.ts)
  // — and #233 landed `withObdPollerHold` for exactly that, with one refusal sentence and
  // the release in its own `finally`. A second helper here would be the third wording of
  // one condition, which is what both of them were written to stop. A SWEEP does not come
  // through this function at all; why it does not park is argued at `start`.
  //
  // The double `ok` is flattened on the way out: the wrapper reports whether the HOLD was
  // granted, the body whether the READ succeeded, and a caller wants one answer.
  const held = await withObdPollerHold(what, () => runHeldOneShot(context, what, start));
  return held.ok ? held.result : held;
}

/**
 * One one-shot read, with the poller already parked and the lease still to take.
 *
 * Split from `runOneShotBusModule` only so the hold can wrap it: everything here runs
 * inside `withObdPollerHold`'s `finally`, so the poller is released on every path out of
 * it, including a throw.
 */
async function runHeldOneShot<T>(
  context: RunnerContext,
  what: string,
  start: (channel: RawChannel) => OneShotBusModule<T>
): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  // The lease comes after the hold, so the poller is already quiet before a session is
  // opened — the ordering the lifetime read's own header argues for.
  const ready = checkPreconditions(context, what);
  if (!ready.ok) {
    return { ok: false, reason: ready.reason };
  }
  const watchdog = startWatchdog(reason => context.oneShot?.module.abort(reason));
  try {
    // ⚠️ INSIDE the try. `start` does real work before it returns — a KWP client and an
    // event-loop histogram — and the lease is already held, so a throw out here would
    // wedge service mode for the life of the process with nothing to say why.
    const module = start(ready.channel);
    context.oneShot = { name: what, module };
    console.log(`vcu-read: ${what} started — the bike checked out as safe to service`);
    return { ok: true, result: await module.finished };
  } catch (err) {
    // Never swallowed, and never allowed to reject into the HTTP handler: a read that
    // threw looks the same as a silent bike on screen unless it is said out loud.
    console.error(`vcu-read: ${what} failed:`, err);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(watchdog);
    context.oneShot = null;
    ready.lease.release();
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
  // A one-shot module is aborted and not waited for. A probe holds nothing and is
  // bounded by two reply windows plus, on a reply that starts and stalls, one transfer
  // window each — ~1.33 s worst case since #223, not the ~600 ms this used to imply;
  // a lifetime read holds a durable store write, but that
  // write happens AFTER the lease is released and outside the module's own promise, so
  // awaiting the module here would not protect it either — ./lifetime-read.ts and the
  // caller in ../http/lifetime-read.ts own that ordering. A sweep is the exception,
  // below, because its archive write IS inside its promise.
  context.oneShot?.module.abort("the service is shutting down");
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
 * runs between parameters, which is every ~310 ms in the good case but up to ~1.33 s
 * when a read times out and the session is re-opened, or when a reply starts and stalls;
 * a bike that starts moving
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
//
// ⚠️ DELIBERATELY NOT the same shape as write-runner.ts's startGateWatchdog, which returns early
// when nothing is in flight. This one is started WITH the in-flight object and stopped when it
// settles, so it cannot fire against a settled exchange and needs no such guard; that one runs
// for the whole of `perform` and reads a nullable field. Unifying them would have to keep this
// property. Why the write side needed the guard: docs/clear-dtcs.md §5.
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
      // What a full sweep will ask about, taken from the RUNNING sweep rather than
      // recomputed here, so it cannot drift from what that sweep actually does. It used
      // to read `parameterTable().length`, which was the same number until the sweep's
      // list grew past the name table (#219).
      expected: context.sweep.expected,
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
  const byStatus = { ...ZERO_BY_STATUS };
  const perMicro = new Map<VcuMicro, { micro: VcuMicro; read: number; failed: number }>();
  for (const row of rows) {
    // ⚠️ `?? 0` for a row that came off DISK, not for the union. `ZERO_BY_STATUS` seeds
    // every status this build knows, and its type is what keeps that exhaustive — but
    // `sweep.partial.jsonl` is `JSON.parse(...) as VcuParameterRow` (./snapshot-store.ts),
    // so a row written by an older build can carry a status this one retired, and `+= 1`
    // on a missing key puts NaN on the phone.
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
