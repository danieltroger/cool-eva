import type { RawChannel } from "socketcan";
import { ageMs, latestValue } from "../can/signals.ts";
import { acquireBus, busHeldBy, type BusLease } from "./bus-lease.ts";
import { parameterAtIndex } from "./param-table.ts";
import { checkPiClock, type PiClockVerdict, type ServiceStamp } from "./service-actions.ts";
import type { ServiceGateVerdict } from "./service-gate.ts";
import { appendAuditRecord, recentAuditRecords, type AuditAction, type AuditRecord } from "./write-audit.ts";
import {
  clearStoredDtcs,
  readServiceStamp,
  setServicePoint,
  syncBikeClock,
  writeParameter,
  type ClearDtcsOutcome,
  type RunningWriteSession,
  type ServicePointOutcome,
  type ServiceWriteOutcome,
} from "./write-session.ts";
import { planBitWrite, planWrite, WRITE_TARGETS, type WriteTarget } from "./write-targets.ts";

// Service mode's WRITE engine: decide whether the bike may be changed, do exactly one
// thing to it, read the result back, and write down what happened.
//
// The read engine is ./read-runner.ts and this deliberately mirrors it — same gate,
// same watchdog, same "answers with a reason rather than throwing" contract — but it
// is a separate file and a separate switch, because the two are not the same risk and
// must not share an off button.
//
// ── The four locks on this door, in the order they are checked ──────────────
//  1. **SERVICE_WRITE_ENABLED.** Its own switch, separate from SERVICE_MODE_ENABLED.
//     A Pi with reads on and writes off is the normal configuration; a Pi that has
//     never been told otherwise is that Pi, because this one defaults to OFF while
//     SERVICE_MODE_ENABLED defaults to ON. That asymmetry is the point.
//  2. **The bus lease** (./bus-lease.ts). One thing at a time — a sweep's read
//     answered by a write's security seed would file four random bytes as a
//     calibration value, and nothing would throw.
//  3. **The safety gate** (./service-gate.ts), unchanged and shared with the read
//     path. ⚠️ Note it now permits STATIONARY-AND-CHARGING, deliberately: the DC
//     charge parameters cannot be tested on a bike that is not plugged in, and a
//     tethered bike cannot be ridden away without someone unplugging it first. Every
//     other check still applies — zero speed, zero motor rpm, `moving`, `go`,
//     `go_request` and `throttle_on` all clear.
//  4. **The allowlist and the ranges** (./write-targets.ts), in the pure layer.
//
// And behind all four, per action: a read of the current value, a compare-and-swap
// against what the caller thought it was, and a read-back afterwards.
//
// ── ⚠️ What is NOT here, and must not be added ──────────────────────────────
// No "write these five parameters". No "restore from a snapshot". No "revert". Each
// is a reasonable thing to want and each turns one confirmed change into a batch
// nobody reads. If a batch is ever genuinely needed, the right shape is a list the
// owner confirms one row at a time — not a loop over this function.

/** What the write runner can be asked to do. Closed, and every member is one action. */
export type ServiceWriteRequest =
  /** Set an allowlisted parameter to a value, having read `expectedCurrent` off the bike first. */
  | { kind: "parameter"; name: string; value: number; expectedCurrent: number }
  /** Turn one named bit of an allowlisted config word on or off. */
  | { kind: "bit"; name: string; bit: string; on: boolean; expectedCurrent: number }
  /** Read the last-service block off A8. Read-only; here because it is the routine's before-picture. */
  | { kind: "read-service-stamp" }
  /** ⚠️ IRREVERSIBLE. `31 FC` on A8 — stamps the bike's own RTC time and odometer as "serviced now". */
  | { kind: "set-service-point" }
  /** Broadcast this Pi's UTC on 0x120, setting the bike's clock. Refused if the Pi's clock is not trustworthy. */
  | { kind: "sync-clock" }
  /** ⚠️ IRREVERSIBLE. OBD Mode 04 — erases the stored trouble codes and the freeze frame. */
  | { kind: "clear-dtcs" };

/** How an action came out, in the shape the page renders. */
export interface ServiceWriteResult {
  action: AuditAction;
  /** The action's own status word — `written`, `read-back-mismatch`, `refused`, `cleared`, `sent`, … */
  status: string;
  /** One sentence, already phrased for the page. */
  message: string;
  /** True only for the statuses that mean the bike really is now as asked. */
  succeeded: boolean;
  /** The stamp, for the two service-point actions. */
  stamp?: { before: ServiceStamp | null; after: ServiceStamp | null };
}

export type ServiceWriteAnswer = { ok: true; result: ServiceWriteResult } | { ok: false; reason: string };

export interface VcuWriteRunner {
  /** Does one thing. Resolves with a refusal rather than throwing, whatever goes wrong. */
  perform: (request: ServiceWriteRequest) => Promise<ServiceWriteAnswer>;
  /** Feed CAN frames here; true when consumed. A no-op unless an action is in flight. */
  handleCanFrame: (id: number, data: Buffer) => boolean;
  /** What the page needs to render the section without a second request. */
  status: () => Promise<VcuWriteStatus>;
  /** Aborts anything in flight, for shutdown. */
  stop: () => void;
}

/** Everything the page shows about writing, in one payload. */
export interface VcuWriteStatus {
  /** False when SERVICE_WRITE_ENABLED is not 1. The page then labels the buttons as off. */
  enabled: boolean;
  gate: ServiceGateVerdict;
  /** Whether this Pi's clock may be copied into the bike, and why not when it may not. */
  clock: PiClockVerdict;
  /** The allowlist, so the page's list cannot drift from the codec's. */
  targets: WriteTargetSummary[];
  /** The last few journal lines, newest first. */
  recent: AuditRecord[];
  /** What has the bus, or null. */
  busHeldBy: string | null;
}

/** One allowlist entry as the page shows it. Everything a person needs before pressing a button. */
export interface WriteTargetSummary {
  name: string;
  index: number;
  micro: string;
  purpose: string;
  warnings: string[];
  control:
    | { kind: "number"; min: number; max: number; minLabel: string; maxLabel: string }
    | { kind: "bits"; bits: { key: string; mask: number; label: string; caveat: string }[] };
}

export interface VcuWriteRunnerOptions {
  /** The service's already-started channel; null when CAN is off, in which case everything is refused. */
  channel: () => RawChannel | null;
  /** False when the bus is listen-only (OBD_ENABLED=0) — every frame would be swallowed silently. */
  busIsActive: boolean;
  /** ⚠️ SERVICE_WRITE_ENABLED. Defaults to false in src/index.ts, unlike every other switch. */
  enabled: boolean;
  /** Where the audit journal goes. The same directory the snapshots use. */
  directory: string;
  /** The safety gate, shared with the read runner so there is one opinion and not two. */
  gate: () => ServiceGateVerdict;
}

/**
 * How often the gate is re-checked while an action is in flight.
 *
 * The same 200 ms the read path uses, and for the same reason: twenty frames of a
 * 100 Hz broadcast, and two thirds of one reply window, so an action caught
 * mid-exchange is stopped inside it rather than after it.
 */
const GATE_WATCH_INTERVAL_MS = 200;

/** How many journal lines the page shows. Enough to see the last session's work. */
const RECENT_AUDIT_LINES = 12;

interface WriteContext extends VcuWriteRunnerOptions {
  running: RunningWriteSession | null;
}

export function createVcuWriteRunner(options: VcuWriteRunnerOptions): VcuWriteRunner {
  const context: WriteContext = { ...options, running: null };
  return {
    perform: request => perform(context, request),
    handleCanFrame: (id, data) => context.running?.handleFrame(id, data) ?? false,
    status: () => status(context),
    stop: () => context.running?.abort("the service is shutting down"),
  };
}

async function status(context: WriteContext): Promise<VcuWriteStatus> {
  return {
    enabled: context.enabled,
    gate: context.gate(),
    clock: readPiClock(),
    targets: WRITE_TARGETS.map(summariseTarget),
    recent: await recentAuditRecords(context.directory, RECENT_AUDIT_LINES),
    busHeldBy: busHeldBy(),
  };
}

/**
 * The clock check, sampled here and DECIDED in ./service-actions.ts.
 *
 * Same split as the safety gate's, and for the same reason: every branch of the
 * decision stays reachable from a laptop. `ageMs` is the monotonic age from
 * src/can/signals.ts and never a `Date.now()` difference — a backwards clock step
 * would otherwise make a stale GPS reading look fresh, which on this particular
 * decision means vouching for a clock with evidence from an hour ago.
 */
function readPiClock(): PiClockVerdict {
  return checkPiClock({
    systemEpochMs: Date.now(),
    gpsEpochSeconds: latestValue("gps_epoch_s"),
    gpsAgeMs: ageMs("gps_epoch_s"),
  });
}

function summariseTarget(target: WriteTarget): WriteTargetSummary {
  return {
    name: target.name,
    index: target.index,
    // Straight off params.ecf, which is also where the frame's address comes from —
    // so the page cannot show a different micro from the one that gets written to.
    // The allowlist asserts at load that its index and name agree with that table.
    micro: parameterAtIndex(target.index)?.micro ?? "?",
    purpose: target.purpose,
    warnings: target.warnings,
    control:
      target.control.kind === "number"
        ? {
            kind: "number",
            min: target.control.min,
            max: target.control.max,
            minLabel: target.unit(target.control.min),
            maxLabel: target.unit(target.control.max),
          }
        : { kind: "bits", bits: target.control.bits },
  };
}

/**
 * Everything that has to be true before any frame goes out, in one place.
 *
 * Ordered cheapest-first, and the gate LAST of the three cheap ones, so that a Pi with
 * writes switched off says so rather than complaining about the bike.
 */
function checkPreconditions(
  context: WriteContext
): { ok: true; channel: RawChannel; lease: BusLease } | { ok: false; reason: string } {
  if (!context.enabled) {
    return {
      ok: false,
      reason:
        "writing is switched off on this Pi. Set SERVICE_WRITE_ENABLED=1 to allow it — it is off by default, unlike every other switch here.",
    };
  }
  const channel = context.channel();
  if (!channel) {
    return { ok: false, reason: "CAN is switched off on this Pi (CAN_ENABLED=0) — there is no bus to write to" };
  }
  if (!context.busIsActive) {
    return {
      ok: false,
      reason:
        "the bus is listen-only (OBD_ENABLED=0) — nothing can be transmitted, so a write would silently do nothing",
    };
  }
  const verdict = context.gate();
  if (!verdict.safe) {
    return { ok: false, reason: `the bike is not safe to service — ${verdict.blockers.join("; ")}` };
  }
  // Taken LAST, so a refusal for any other reason does not hold the bus while it is
  // reported. Released in the `finally` of every path below.
  const lease = acquireBus("a service write");
  if (!lease.ok) {
    return { ok: false, reason: `${lease.heldBy} is using the bus — one thing at a time` };
  }
  return { ok: true, channel, lease: lease.lease };
}

async function perform(context: WriteContext, request: ServiceWriteRequest): Promise<ServiceWriteAnswer> {
  const ready = checkPreconditions(context);
  if (!ready.ok) {
    return { ok: false, reason: ready.reason };
  }
  const watchdog = startGateWatchdog(context);
  try {
    return await performOnBus(context, request, ready.channel);
  } catch (err) {
    // Never swallowed and never allowed to reject into an HTTP handler: an action
    // that threw looks the same as a silent bike on screen unless it is said out loud,
    // and this is a bike we cannot attach a debugger to.
    console.error(`vcu-write: the ${request.kind} action failed:`, err);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(watchdog);
    context.running = null;
    ready.lease.release();
  }
}

async function performOnBus(
  context: WriteContext,
  request: ServiceWriteRequest,
  channel: RawChannel
): Promise<ServiceWriteAnswer> {
  switch (request.kind) {
    case "parameter":
    case "bit":
      return await performParameterWrite(context, request, channel);
    case "read-service-stamp":
      return await performReadStamp(context, channel);
    case "set-service-point":
      return await performServicePoint(context, channel);
    case "sync-clock":
      return await performClockSync(context, channel);
    case "clear-dtcs":
      return await performClearDtcs(context, channel);
  }
}

async function performParameterWrite(
  context: WriteContext,
  request: Extract<ServiceWriteRequest, { kind: "parameter" | "bit" }>,
  channel: RawChannel
): Promise<ServiceWriteAnswer> {
  // The allowlist decides, in the pure layer, before anything is opened or sent. A
  // name that is not on it never becomes a session, let alone a frame.
  const planned =
    request.kind === "parameter"
      ? planWrite(request.name, request.value, request.expectedCurrent)
      : planBitWrite(request.name, request.bit, request.on, request.expectedCurrent);
  if (!planned.ok) {
    return { ok: false, reason: planned.reason };
  }
  const plan = planned.plan;
  console.warn(
    `vcu-write: about to write ${plan.description} (${plan.micro} identifier 0x${plan.identifier.toString(16)})`
  );

  const session = writeParameter(channel, plan);
  context.running = session.session;
  const outcome = await session.finished;

  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action: "parameter-write",
    status: outcome.status,
    name: plan.name,
    identifier: plan.identifier,
    micro: plan.micro,
    // The BEFORE recorded is the one read off the bus, which for a stale precondition
    // is the value that surprised us rather than the one the caller believed.
    before: outcome.status === "stale-precondition" ? outcome.actual : plan.previousValue,
    after: outcome.status === "written" || outcome.status === "read-back-mismatch" ? outcome.readBack : null,
    requested: plan.value,
    rawHex: "rawHex" in outcome ? outcome.rawHex : undefined,
    note: describeWriteOutcome(outcome),
  });

  return {
    ok: true,
    result: {
      action: "parameter-write",
      status: outcome.status,
      message: describeWriteOutcome(outcome),
      succeeded: outcome.status === "written",
    },
  };
}

function describeWriteOutcome(outcome: ServiceWriteOutcome): string {
  switch (outcome.status) {
    case "written":
      return `${outcome.plan.description} — written and read back as ${outcome.readBack} (${outcome.rawHex}).`;
    case "read-back-mismatch":
      // The loudest sentence in this file. The bike accepted the write and does not
      // hold the value, and the number it DOES hold is what gets said.
      return (
        `⚠️ ${outcome.plan.name} was accepted but reads back as ${outcome.readBack} (${outcome.rawHex}), not ` +
        `${outcome.plan.value}. The cell did not take it — the parameter may be recomputed from something else, ` +
        "or read-only despite acknowledging the write. Nothing was changed to what you asked for."
      );
    case "stale-precondition":
      return (
        `Nothing was written. ${outcome.plan.name} reads ${outcome.actual} on the bike, not the ` +
        `${outcome.plan.previousValue} this page was showing — read it again before writing.`
      );
    case "refused":
      return `The ${outcome.plan.micro} refused at the ${outcome.stage} step: ${outcome.description}.`;
    case "failed":
      return `Nothing confirmed. Failed at the ${outcome.stage} step: ${outcome.reason}`;
  }
}

async function performReadStamp(context: WriteContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  const session = readServiceStamp(channel, Date.now());
  context.running = session.session;
  const outcome = await session.finished;
  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action: "read-service-stamp",
    status: outcome.ok ? "read" : "failed",
    before: outcome.ok ? outcome.stamp.dateIso : null,
    after: outcome.ok ? outcome.stamp.odometer : null,
    note: outcome.ok ? (outcome.stamp.implausible ?? "read cleanly") : outcome.reason,
  });
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  return {
    ok: true,
    result: {
      action: "read-service-stamp",
      status: "read",
      message: describeStamp(outcome.stamp),
      succeeded: true,
      stamp: { before: outcome.stamp, after: null },
    },
  };
}

function describeStamp(stamp: ServiceStamp): string {
  const base = `Last service stamped ${stamp.dateIso ?? "(undecodable)"} at ${stamp.odometer} (km or miles, per market).`;
  return stamp.implausible === null ? base : `${base} ⚠️ ${stamp.implausible}`;
}

async function performServicePoint(context: WriteContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  console.warn("vcu-write: about to run 31 FC Set Service Point on A8 — this is irreversible");
  const session = setServicePoint(channel, Date.now());
  context.running = session.session;
  const outcome = await session.finished;

  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action: "set-service-point",
    status: outcome.status,
    micro: "A8",
    // Both stamps, because this action overwrites the only copy of the old one. If
    // the journal does not hold it, nothing does.
    before: outcome.status === "started" ? (outcome.before?.dateIso ?? null) : null,
    after: outcome.status === "started" ? (outcome.after?.dateIso ?? null) : null,
    note: describeServicePoint(outcome),
  });

  return {
    ok: true,
    result: {
      action: "set-service-point",
      status: outcome.status,
      message: describeServicePoint(outcome),
      succeeded: outcome.status === "started",
      stamp: outcome.status === "started" ? { before: outcome.before, after: outcome.after } : undefined,
    },
  };
}

function describeServicePoint(outcome: ServicePointOutcome): string {
  switch (outcome.status) {
    case "started":
      if (!outcome.after) {
        // Ran, and we cannot show what it wrote. Said plainly — the alternative is a
        // page implying it knows the new stamp when it does not.
        return "31 FC was accepted, but the last-service block could not be read back, so what it stamped is unknown.";
      }
      return (
        `Service point set. The bike stamped ${outcome.after.dateIso ?? "(undecodable)"} at ${outcome.after.odometer}` +
        (outcome.before ? `, over ${outcome.before.dateIso ?? "(undecodable)"} at ${outcome.before.odometer}.` : ".") +
        (outcome.after.implausible ? ` ⚠️ ${outcome.after.implausible} — the bike's own RTC is what it stamps.` : "")
      );
    case "refused":
      return `The A8 refused at the ${outcome.stage} step: ${outcome.description}.`;
    case "failed":
      return `Outcome UNKNOWN — failed at the ${outcome.stage} step: ${outcome.reason}`;
  }
}

async function performClockSync(context: WriteContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  // ⚠️ Re-checked here, at the last moment, and not merely shown on the page. The
  // page's copy of the verdict was fetched when the sheet opened; the clock can have
  // been stepped by GPS since, in either direction.
  const clock = readPiClock();
  if (!clock.trustworthy) {
    return {
      ok: false,
      reason: `This Pi's clock is not fit to copy into the bike: ${clock.reasons.join("; ")}. It reads ${clock.iso}.`,
    };
  }
  const when = new Date();
  const outcome = syncBikeClock(channel, when);
  await appendAuditRecord(context.directory, {
    at: when.getTime(),
    clockTrustworthy: true,
    action: "rtc-sync",
    status: outcome.status,
    requested: when.toISOString(),
    // Nothing to read back — the bike's clock is not readable by any documented
    // means, so `after` is null for this action always, not just on failure.
    after: null,
    rawHex: outcome.status === "sent" ? outcome.hex : undefined,
    note:
      outcome.status === "sent"
        ? "broadcast on 0x120; there is no reply and no way to read the bike's clock back, so this is unverified by construction"
        : outcome.reason,
  });
  if (outcome.status !== "sent") {
    return { ok: false, reason: outcome.reason };
  }
  return {
    ok: true,
    result: {
      action: "rtc-sync",
      status: "sent",
      message:
        `Broadcast ${when.toISOString()} UTC on 0x120 (${outcome.hex}). ` +
        "⚠️ CHECK THE DASHBOARD NOW to see whether the bike took it. " +
        "There is no reply to this frame and no documented way to read the bike's clock back, so the dash is the only " +
        "confirmation that exists. Note the bike was sent UTC, so a dash showing local time will differ by your offset. " +
        "Confirm it before using Set Service Point, which stamps whatever the bike's clock says.",
      succeeded: true,
    },
  };
}

async function performClearDtcs(context: WriteContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  console.warn("vcu-write: about to send OBD Mode 04 — the stored trouble codes and the freeze frame will be erased");
  const session = clearStoredDtcs(channel);
  context.running = session.session;
  const outcome = await session.finished;
  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action: "clear-dtcs",
    status: outcome.status,
    note: describeClear(outcome),
  });
  return {
    ok: true,
    result: {
      action: "clear-dtcs",
      status: outcome.status,
      message: describeClear(outcome),
      succeeded: outcome.status === "cleared",
    },
  };
}

function describeClear(outcome: ClearDtcsOutcome): string {
  switch (outcome.status) {
    case "cleared":
      return "Mode 04 accepted. The stored list is gone; codes whose faults are still active will come back on the next drive cycle. Read the list again to see what remains.";
    case "refused":
      return `Refused: ${outcome.description}.`;
    case "failed":
      return `Nothing confirmed: ${outcome.reason}`;
  }
}

/**
 * Re-checks the gate while an action is in flight and stops it from outside the loop.
 *
 * ⚠️ Aborting a WRITE is not the same as aborting a read, and the difference is worth
 * being precise about. A read that is cut short has simply not read something. A
 * write cut short between `2E` and its read-back has CHANGED THE BIKE and not
 * confirmed what to — which is why every abort path settles the pending request as an
 * empty payload that no decoder reads as success, and why the audit record for such
 * an attempt says the outcome is unknown rather than saying it failed.
 *
 * The window is small: the gate is checked before the session opens, and from there
 * to the read-back is at most a few hundred milliseconds of exchanges. But it is not
 * zero, and a bike that is rolled while its charge current is being written is
 * exactly the situation this is for.
 */
function startGateWatchdog(context: WriteContext): ReturnType<typeof setInterval> {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) {
      return;
    }
    const verdict = context.gate();
    if (verdict.safe) {
      return;
    }
    fired = true;
    console.warn(`vcu-write: ABORTING — the bike stopped being safe to service: ${verdict.blockers.join("; ")}`);
    context.running?.abort(`the bike stopped being safe to service — ${verdict.blockers.join("; ")}`);
  }, GATE_WATCH_INTERVAL_MS);
  // This timer must never be the reason a `systemctl stop` hangs.
  timer.unref?.();
  return timer;
}
