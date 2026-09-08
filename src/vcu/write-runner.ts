import type { RawChannel } from "socketcan";
import { ageMs, latestValue } from "../can/signals.ts";
import { acquireBus, busHeldBy, type BusLease } from "./bus-lease.ts";
import { parameterAtIndex } from "./param-table.ts";
import { checkPiClock, type PiClockVerdict, type ServiceStamp } from "./service-actions.ts";
import type { ServiceGateVerdict } from "./service-gate.ts";
import type { LatestSweep } from "./snapshot-store.ts";
import type { TableTypeReport, VcuParameterSnapshot } from "./snapshot.ts";
import { evaluateTableGate, type TableGateVerdict } from "./table-gate.ts";
import { appendAuditRecord, recentAuditRecords, type AuditAction, type AuditRecord } from "./write-audit.ts";
import type { ChargeMode } from "../can/charge-command.ts";
import {
  clearStoredDtcs,
  readServiceStamp,
  resetVcu,
  sendChargeCommand,
  sendChargeStopCommand,
  setServicePoint,
  syncBikeClock,
  writeParameter,
  writeParameters,
  type ClearDtcsOutcome,
  type ResetVcuOutcome,
  type RunningWriteSession,
  type ServicePointOutcome,
  type ServiceWriteOutcome,
} from "./write-session.ts";
import {
  planBitWrite,
  planWrite,
  writeTargetNamed,
  writeTargetProblemIn,
  writeTargets,
  type ParameterWritePlan,
  type WriteTarget,
} from "./write-targets.ts";
import { parameterTableFor } from "./table-catalog.ts";

// Service mode's WRITE engine: decide whether the bike may be changed, do exactly one thing
// to it, read the result back, and write down what happened. The read engine is
// ./read-runner.ts and this deliberately mirrors it, but it is a separate file and a
// separate switch, because the two are not the same risk and must not share an off button.
//
// The five locks on this door, in the order they are checked — each argued in
// docs/vcu-parameters.md §8:
//  1. SERVICE_WRITE_ENABLED, its own switch, and ⚠️ the only one here that defaults to OFF.
//  2. The bus lease (./bus-lease.ts). One thing at a time — a sweep's read answered by a
//     write's security seed would file four random bytes as a calibration value.
//  3. The safety gate (./service-gate.ts), shared with the read path. ⚠️ It permits
//     STATIONARY-AND-CHARGING deliberately; every other check still applies.
//  4. The table-type gate (./table-gate.ts). ⚠️ It gates the two PARAMETER actions and
//     nothing else — see `tableGateAppliesTo` for why the service actions are left alone.
//  5. The allowlist and the ranges (./write-targets.ts), in the pure layer.
//
// And behind all five, per action: a read of the current value, a compare-and-swap against
// what the caller thought it was, and a read-back afterwards.
//
// ⚠️ What is NOT here, and must not be added: no "restore from a snapshot", no "revert", no
// bulk loader that writes a table of values nobody read one at a time. Each turns a
// confirmed change into a batch nobody reads.
//
// There IS one batch — `kind: "parameters"`, for the all-lights buttons — and it is the
// shape this rule always allowed: a short fixed list that is genuinely ONE gesture, where
// every parameter is still compare-and-swapped against a fresh read, read back, and given
// its own audit line. The ONLY thing shared is the authenticated session, because five
// separate unlocks cannot fit inside SECURITY_COOLDOWN_MS and one unlock risks fewer
// attempts than five. What stays refused is the OPEN-ENDED batch — a snapshot restore, a
// revert, a loop over an arbitrary list; for one of those the right shape is still a list
// the owner confirms one row at a time.

/** What the write runner can be asked to do. Closed, and every member is one action. */
export type ServiceWriteRequest =
  /** Set an allowlisted parameter to a value, having read `expectedCurrent` off the bike first. */
  | { kind: "parameter"; name: string; value: number; expectedCurrent: number }
  /**
   * Set SEVERAL allowlisted parameters in ONE authenticated session — a read + compare-and-swap
   * on each, then a single `27` unlock shared across all the `2E` writes. Only for a batch that
   * is genuinely one gesture (the all-lights buttons); see the ⚠️ at the top of this file for why
   * an open-ended batch is refused. Each entry is still individually planned, CAS-checked, read
   * back and audited — the session is the only shared thing.
   */
  | { kind: "parameters"; writes: { name: string; value: number; expectedCurrent: number }[] }
  /** Turn one named bit of an allowlisted config word on or off. */
  | { kind: "bit"; name: string; bit: string; on: boolean; expectedCurrent: number }
  /** Read the last-service block off A8. Read-only; here because it is the routine's before-picture. */
  | { kind: "read-service-stamp" }
  /** ⚠️ IRREVERSIBLE. `31 FC` on A8 — stamps the bike's own RTC time and odometer as "serviced now". */
  | { kind: "set-service-point" }
  /** Broadcast this Pi's UTC on 0x120, setting the bike's clock. Refused if the Pi's clock is not trustworthy. */
  | { kind: "sync-clock" }
  /** ⚠️ IRREVERSIBLE. OBD Mode 04 — erases the stored trouble codes and the freeze frame. */
  | { kind: "clear-dtcs" }
  /**
   * Command the charge-current limit on 0x121. The opcode (AC/DC) and the ceiling to echo are
   * chosen from the LIVE charge type here, not by the caller — so a stale page cannot frame a
   * DC command into an AC session. Transient and rider-overridable; refused unless charging.
   */
  | { kind: "charge-current"; amps: number }
  /**
   * Stop an active charge by injecting the 0x120 request-twin `96 ff 01 …` — the half of the
   * dash's Mode-stop that alone commits (2026-08-25 on-bike). Source-agnostic — the same frame
   * ends AC and DC — so it carries no fields; the only precondition is a live session, checked
   * off charge_manager_state like charge-current.
   */
  | { kind: "charge-stop" }
  /**
   * Restart both VCU micros with ECUReset (`11 02`) — a key-cycle restart, nothing erased.
   * Carries no fields: both nodes always reset together. Refused if a charge session is live
   * (checked off charge_manager_state like charge-stop) and, through the shared gate, if the
   * bike is moving. Reversible, so not on the irreversible tier.
   */
  | { kind: "reset-vcu" };

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
  /**
   * ⚠️ What the parameter reads on the bike NOW, off the bus, at the end of this action
   * — the read-back after a write, or the surprise value a stale precondition found.
   * Null when the action ended without reading anything (a refusal at the session or
   * security step, a timeout), and absent entirely for the actions that address no
   * parameter.
   *
   * It is here so the page can show what the bike holds after a write instead of the
   * value it held before, which the last sweep's snapshot still says. It is NOT a
   * shortcut past anything: the next write is compared server-side against a fresh read
   * exactly as this one was.
   */
  onBike?: { name: string; value: number; rawHex: string | null } | null;
  /**
   * Present only for a batch (`kind: "parameters"`): one entry per parameter asked for,
   * in the order asked, so the page can say which circuit went through and which did not.
   * The top-level `status`/`message`/`succeeded` summarise the whole run.
   */
  writes?: PerWriteResult[];
}

/** One parameter's outcome inside a batch, in the shape the page renders per row. */
export interface PerWriteResult {
  name: string;
  /** The parameter's own status word — `written`, `read-back-mismatch`, `stale-precondition`, `refused`, `failed`. */
  status: string;
  /** One sentence, already phrased for the page — the same text a single write would show. */
  message: string;
  /** True only when this parameter really is now the value asked for. */
  succeeded: boolean;
  /** What it reads on the bike now, off the bus, when the outcome read it; null otherwise. */
  onBike: { name: string; value: number; rawHex: string | null } | null;
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
  /**
   * ⚠️ Whether anything on this Pi has confirmed which parameter table the bike runs,
   * and — when it has not — which of the two blocked states this is and what opens it.
   *
   * On the status payload rather than only in a refusal because the page has to be
   * able to disable the write button and SAY WHY before anyone presses it, and because
   * the two blocked states need to look different: `mismatched` is a software problem
   * no read will fix, `unread` is one frame away. See ./table-gate.ts.
   */
  tableGate: TableGateVerdict;
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
  /**
   * How to tell afterwards whether the write actually took — free, off the broadcast,
   * with no charger and no second diagnostic session. Null where nothing outside the
   * read-back can confirm it.
   *
   * Separate from `warnings` because it belongs at a different MOMENT: the warnings are
   * the argument against pressing the button, and this is the first thing you want once
   * you have. The page shows it after the write for that reason.
   */
  verify: string | null;
  /**
   * ⚠️ What the last recorded sweep found for THIS parameter, or null when no sweep on
   * this Pi holds a usable typed reading of it.
   *
   * This is what stops the page saying "not read yet" to somebody who has just swept all
   * 277 parameters — the sweep read this value, wrote it to `latest.json`, and the write
   * form used to have no way to see it. It is not a substitute for the compare-and-swap:
   * whatever the page sends as `expected` is re-read off the bus before anything is
   * written (./write-session.ts), so a value that has moved since the sweep produces a
   * `stale-precondition` refusal naming both numbers rather than a wrong write.
   *
   * `readAt` is the sweep's own wall clock, so the page can say how old it is — which is
   * the whole difference between this and a fresh read.
   */
  onBike: SweptValue | null;
  control:
    | { kind: "number"; min: number; max: number; minLabel: string; maxLabel: string }
    | { kind: "bits"; bits: { key: string; mask: number; label: string; caveat: string }[] };
}

/** One parameter as the last sweep recorded it. */
export interface SweptValue {
  /** Typed per the table's S/U column. Never the unsigned reading — see `sweptValueOf`. */
  value: number;
  /** The bytes the bike sent, so the page can show them and not only the number. */
  rawHex: string | null;
  /** `target.unit(value)` — `75 A`, `230.0 Nm`, `0x1113`. The units live in one place. */
  label: string;
  /** Wall clock of the sweep that read it. */
  readAt: number;
  /** False when that sweep was cut short. The value is still true; the run was not finished. */
  complete: boolean;
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
  /**
   * The last sweep on this Pi — its rows, and what they say about the bike's parameter
   * table — or null when there is none.
   *
   * Injected exactly as `gate` is, and for the same reason: the decision stays in a
   * pure function (./table-gate.ts) that a laptop can exercise, and this module never
   * learns where a snapshot lives. Async because the answer is a file — sampled per
   * attempt rather than cached, so a sweep that ran while the sheet was open opens the
   * gate, and fills in the values, without a restart.
   */
  latestSweep: () => Promise<LatestSweep | null>;
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

/**
 * The most parameters one batch (`kind: "parameters"`) may write in a single session.
 *
 * NOT a bus limit — the unlock survives as many writes as stay under ~2.5 s apart, which
 * is all of them. It is a policy ceiling: one authenticated session is meant to be one
 * gesture (the five light circuits), and a request to write dozens is either a bug or the
 * batch being misused as a bulk loader — the "batch nobody reads" this file's header
 * refuses. Eight is the five lights plus headroom.
 */
const MAX_PARAMETERS_PER_BATCH = 8;

/**
 * How fresh charge_manager_state must be before a charge-current command is honoured.
 *
 * ⚠️ charge_manager_state (0x610 b7), NOT charge_type (0x605 b2). charge_type names "AC current
 * flowing right now", not "a session exists" — it flaps 1↔0 within one plug-in as the charger
 * pauses delivery (measured 8 min at 0 mid-trickle, 2026-08-25; docs/charge-manager.md §charge_type
 * flaps). charge_manager_state holds 0x02 (AC) / 0x23 (DC) steady for the whole session, and 0x610
 * broadcasts continuously, so a stale reading means the cable came out — exactly when to refuse.
 */
const CHARGE_SESSION_MAX_AGE_MS = 5000;

/** charge_manager_state (0x610 b7) settled values — the cleanest AC/DC discriminator. docs/charge-manager.md. */
const CHARGE_MANAGER_STATE_AC = 0x02;
const CHARGE_MANAGER_STATE_DC = 0x23;

/**
 * The AC ceiling (0x121 b4) to use when the dash has NOT broadcast ac_charge_ceiling_a this
 * session — the remote case, where nobody is at the bike to nudge the charge-current dial.
 * 15 (0x0f) is the only AC ceiling ever captured on this bike (docs/can-0x121-charge-command.md),
 * and it is likely charger-specific: if the real pilot/cable rating is not 15, the VCU rejects the
 * frame's b4 and settles on a ~10 A default — benign (nothing damaged, overridable on the bike),
 * just ineffective. The live signal is still preferred whenever present; this is only the fallback.
 */
const AC_CEILING_FALLBACK_A = 15;

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
  // ONE read of the last sweep for both things it is asked: whether the bike has named
  // its parameter table, and what it holds for each writable parameter. Two reads could
  // straddle a sweep finishing and describe two different files on the same screen.
  const sweep = await context.latestSweep();
  return {
    enabled: context.enabled,
    gate: context.gate(),
    tableGate: evaluateTableGate(sweep?.report ?? null),
    clock: readPiClock(),
    targets: writeTargets().map(target => summariseTarget(target, sweep?.snapshot ?? null)),
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

function summariseTarget(target: WriteTarget, sweep: VcuParameterSnapshot | null): WriteTargetSummary {
  return {
    name: target.name,
    index: target.index,
    // Straight off params.ecf, which is also where the frame's address comes from —
    // so the page cannot show a different micro from the one that gets written to.
    // The allowlist asserts at load that its index and name agree with that table.
    micro: parameterAtIndex(target.index)?.micro ?? "?",
    purpose: target.purpose,
    warnings: target.warnings,
    verify: target.verify,
    onBike: sweptValueOf(target, sweep),
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
 * What the last sweep found for one allowlisted parameter, or null.
 *
 * ⚠️ Four conditions, and every one of them is a way this could otherwise put a number on
 * screen that is not this parameter's — and that number becomes the compare-and-swap
 * precondition of a write. Matched BY INDEX and never by name; the name has to agree
 * anyway; `status === "read"` with a typed `value`, never `unsigned`; and not a width
 * mismatch. Why each is load-bearing: docs/vcu-parameters.md §8.
 */
export function sweptValueOf(target: WriteTarget, sweep: VcuParameterSnapshot | null): SweptValue | null {
  if (!sweep) {
    return null;
  }
  const row = sweep.rows.find(candidate => candidate.index === target.index);
  if (!row || row.name !== target.name || row.status !== "read" || row.widthMismatch || row.value === null) {
    return null;
  }
  return {
    value: row.value,
    rawHex: row.rawHex,
    label: target.unit(row.value),
    readAt: sweep.readAt,
    complete: sweep.complete,
  };
}

/**
 * ⚠️ Which actions the table-type gate applies to — and, more usefully, why the others are
 * deliberately exempt.
 *
 * The gate exists for ONE failure: a parameter is addressed by index, what an index means
 * comes from the parameter table, and a write under the wrong table is accepted, reads back
 * cleanly and has changed something else. `31 FC`, Mode 04, the 0x120 clock broadcast and
 * read-service-stamp carry no bank-1 parameter index at all, so `TABLE_TYPE` says nothing
 * about any of them and gating them would be superstition — a refusal resting on evidence
 * with no bearing on the action, which is how a gate stops being believed.
 *
 * The four exemptions one by one, and the honest counter-argument about Set Service Point
 * being irreversible: docs/vcu-parameters.md §4.
 */
function tableGateAppliesTo(request: ServiceWriteRequest): boolean {
  return request.kind === "parameter" || request.kind === "bit" || request.kind === "parameters";
}

/**
 * Everything that has to be true before any frame goes out, in one place.
 *
 * Ordered cheapest-first, and the gate LAST of the three cheap ones, so that a Pi with
 * writes switched off says so rather than complaining about the bike.
 *
 * The table-type gate sits AFTER the safety gate, which is a deliberate ordering and
 * not an accident of where it was added: its remedy is a read, a read needs the same
 * safety gate open, and telling someone to go and probe parameter 277 while the bike is
 * rolling would be sending them after the second-most-important thing.
 */
async function checkPreconditions(
  context: WriteContext,
  request: ServiceWriteRequest
): Promise<
  { ok: true; channel: RawChannel; lease: BusLease; tableType: TableTypeReport | null } | { ok: false; reason: string }
> {
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
  // ⚠️ charge-current AND charge-stop are EXEMPT from the stationary gate, and this is a
  // deliberate exemption, not a hole. That gate refuses PARAMETER writes while the bike could move
  // or its drive is live — but a charging bike is energized by definition and tethered by
  // definition (it cannot be ridden away while plugged in, the same argument service-gate.ts's
  // CHARGE_EVIDENCE rests on), and commanding its charge current — or stopping the charge — is a
  // charging operation. Worse, the gate only excuses `energized` while it sees fresh charger
  // frames, and those flap with the trickle, so applying it here refuses a legitimate command
  // mid-charge. Their real precondition — a live, established session — is checked off
  // charge_manager_state in performChargeCurrent / performChargeStop. So this Pi's own switches
  // (enabled/CAN/bus, above) still gate them; the bike-state gate does not. Stopping is the benign
  // direction regardless: worst case the charge halts, which is the whole point of the button.
  if (request.kind !== "charge-current" && request.kind !== "charge-stop") {
    const verdict = context.gate();
    if (!verdict.safe) {
      return { ok: false, reason: `the bike is not safe to service — ${verdict.blockers.join("; ")}` };
    }
  }
  // Sampled ONLY for the actions that thread it, which is the invariant worth keeping:
  // the report this refusal is decided from is the same object ./write-codec.ts
  // re-judges before the bytes, so the two cannot straddle a sweep finishing and
  // disagree. The exempt actions never look at it, so they do not pay for a read and a
  // JSON.parse of a 277-row file off an SD card — `sync-clock` least of all, since its
  // confirmation has a deadline attached.
  let tableType: TableTypeReport | null = null;
  if (tableGateAppliesTo(request)) {
    tableType = (await context.latestSweep())?.report ?? null;
    const table = evaluateTableGate(tableType);
    if (!table.writesAllowed) {
      // The state is named, not just the reason: `mismatched` and `unread` are read by
      // a person deciding whether to go and fix software or go and press a button, and
      // the remedy sentence is the one that tells them which.
      return { ok: false, reason: `the VCU's parameter table is ${table.state} — ${table.reason} ${table.remedy}` };
    }
    // ⚠️ THE GATE ABOVE ONLY ASKS ABOUT THE CURATED FIVE. Those five are identical in
    // all 28 carried tables, so it passes on every bike — while 26 of the 28 disagree
    // about at least one of the other 264. On a table-4102 bike, index 70 is
    // `CELL_COUNT` here and `RegenFade_0` there, and nothing downstream would notice:
    // ./write-session.ts re-reads, compares and reads back by plan.index, so a
    // misrouted write reads the wrong cell, writes it, verifies it and records success.
    // This asks about the parameter actually being written.
    // One name for a single write or bit toggle, every name for a batch — each checked,
    // because a batch shares nothing that would let one bad index ride in on another's back.
    const names =
      request.kind === "parameters" ? request.writes.map(write => write.name) : "name" in request ? [request.name] : [];
    if (names.length > 0 && table.tableType !== null) {
      const bikeTable = parameterTableFor(table.tableType);
      if (!bikeTable) {
        return { ok: false, reason: `the bike names table ${table.tableType}, which this software cannot rebuild` };
      }
      for (const name of names) {
        const named = writeTargetNamed(name);
        // An unknown name is not judged here — it is refused later, in the pure planning
        // layer, with the full writable list. This gate only asks about names it knows.
        if (!named) {
          continue;
        }
        const problem = writeTargetProblemIn(named, bikeTable);
        if (problem) {
          return {
            ok: false,
            reason:
              `refusing to write ${named.name} on a bike running table ${table.tableType} — ${problem}. ` +
              "The parameter is writable; it is this bike's table that puts something else at that index.",
          };
        }
      }
    }
  }
  // Taken LAST, so a refusal for any other reason does not hold the bus while it is
  // reported. Released in the `finally` of every path below.
  const lease = acquireBus("a service write");
  if (!lease.ok) {
    return { ok: false, reason: `${lease.heldBy} is using the bus — one thing at a time` };
  }
  return { ok: true, channel, lease: lease.lease, tableType };
}

async function perform(context: WriteContext, request: ServiceWriteRequest): Promise<ServiceWriteAnswer> {
  const ready = await checkPreconditions(context, request);
  if (!ready.ok) {
    return { ok: false, reason: ready.reason };
  }
  const watchdog = startGateWatchdog(context);
  try {
    return await performOnBus(context, request, ready.channel, ready.tableType);
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
  channel: RawChannel,
  tableType: TableTypeReport | null
): Promise<ServiceWriteAnswer> {
  switch (request.kind) {
    case "parameter":
    case "bit":
      return await performParameterWrite(context, request, channel, tableType);
    case "parameters":
      return await performParameterWrites(context, request, channel, tableType);
    case "read-service-stamp":
      return await performReadStamp(context, channel);
    case "set-service-point":
      return await performServicePoint(context, channel);
    case "sync-clock":
      return await performClockSync(context, channel);
    case "clear-dtcs":
      return await performClearDtcs(context, channel);
    case "charge-current":
      return await performChargeCurrent(context, request, channel);
    case "charge-stop":
      return await performChargeStop(context, channel);
    case "reset-vcu":
      return await performResetVcu(context, channel);
  }
}

async function performParameterWrite(
  context: WriteContext,
  request: Extract<ServiceWriteRequest, { kind: "parameter" | "bit" }>,
  channel: RawChannel,
  tableType: TableTypeReport | null
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

  // The report goes with the plan rather than being re-fetched inside the session:
  // ./write-codec.ts re-judges it immediately before the `2E` bytes are built, and it
  // must judge the same evidence this runner already refused or permitted on. Two
  // reads of the file could straddle a sweep finishing and disagree.
  const session = writeParameter(channel, plan, tableType);
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
      onBike: readingAfter(outcome),
    },
  };
}

/**
 * Writes several allowlisted parameters in ONE authenticated session — the engine behind the
 * all-lights buttons. Every parameter is still planned, compare-and-swapped, written and read
 * back exactly as a single write is; the ONLY shared thing is the `10 81` session and the one
 * `27` unlock, because five separate unlocks cannot fit inside SECURITY_COOLDOWN_MS and one
 * unlock risks one attempt rather than five. See the ⚠️ at the top of this file for what stays
 * refused (the open-ended batch).
 *
 * The whole batch is refused, before any frame, if it is empty, over the cap, names something
 * off the allowlist, or mixes micros — a batch on the wrong footing is worse than a plain
 * refusal, and half a gesture is not the gesture. Once it runs, each parameter gets its own
 * audit line and its own row in `writes`; the top-level status summarises — `written` only if
 * every one went through, `partial` if some did, `failed` if none did.
 */
async function performParameterWrites(
  context: WriteContext,
  request: Extract<ServiceWriteRequest, { kind: "parameters" }>,
  channel: RawChannel,
  tableType: TableTypeReport | null
): Promise<ServiceWriteAnswer> {
  if (request.writes.length === 0) {
    return { ok: false, reason: "a batch write named no parameters" };
  }
  if (request.writes.length > MAX_PARAMETERS_PER_BATCH) {
    return {
      ok: false,
      reason: `a batch may write at most ${MAX_PARAMETERS_PER_BATCH} parameters in one session; ${request.writes.length} were asked for`,
    };
  }

  // Plan every write in the pure layer first: a name off the allowlist or a value out of range
  // refuses the WHOLE batch before a session is opened. A batch is one gesture, and running
  // four of five writes because the fifth was malformed is not what the button promised.
  const plans: ParameterWritePlan[] = [];
  for (const write of request.writes) {
    const planned = planWrite(write.name, write.value, write.expectedCurrent);
    if (!planned.ok) {
      return { ok: false, reason: `${write.name}: ${planned.reason}` };
    }
    plans.push(planned.plan);
  }

  // One micro per session. ./write-session.ts backstops this, but refusing here keeps the
  // reason specific instead of surfacing as an opaque session-step failure.
  const micro = plans[0].micro;
  if (plans.some(plan => plan.micro !== micro)) {
    const micros = [...new Set(plans.map(plan => plan.micro))];
    return { ok: false, reason: `a single-session batch must be one micro; these span ${micros.join(", ")}` };
  }

  console.warn(
    `vcu-write: about to write ${plans.length} parameters in one session on ${micro} — ` +
      plans.map(plan => `${plan.name}=${plan.value}`).join(", ")
  );

  const session = writeParameters(channel, plans, tableType);
  context.running = session.session;
  const outcome = await session.finished;

  if (outcome.status === "failed") {
    // The batch never got past `10 81` (a live cooldown, or the micro did not answer), so no
    // parameter was read and no SecurityAccess attempt was spent. One audit line for the whole
    // batch — there is no per-parameter before/after to record — and every row reported failed.
    await appendAuditRecord(context.directory, {
      at: Date.now(),
      clockTrustworthy: readPiClock().trustworthy,
      action: "parameter-write",
      status: "failed",
      micro,
      note: `batch of ${plans.length} (${plans.map(plan => plan.name).join(", ")}) failed at the ${outcome.stage} step: ${outcome.reason}`,
    });
    return {
      ok: true,
      result: {
        action: "parameter-write",
        status: "failed",
        message: `Nothing was written — the batch failed at the ${outcome.stage} step: ${outcome.reason}`,
        succeeded: false,
        writes: plans.map(plan => ({
          name: plan.name,
          status: "failed",
          message: `Not attempted — ${outcome.reason}`,
          succeeded: false,
          onBike: null,
        })),
      },
    };
  }

  // One audit line per parameter, the SAME shape a lone write records (see performParameterWrite),
  // so a batched write and a single write are indistinguishable in the journal — which is the
  // point: each row is a real, separately compare-and-swapped and read-back change to the bike.
  for (const perWrite of outcome.results) {
    await appendAuditRecord(context.directory, {
      at: Date.now(),
      clockTrustworthy: readPiClock().trustworthy,
      action: "parameter-write",
      status: perWrite.status,
      name: perWrite.plan.name,
      identifier: perWrite.plan.identifier,
      micro: perWrite.plan.micro,
      before: perWrite.status === "stale-precondition" ? perWrite.actual : perWrite.plan.previousValue,
      after: perWrite.status === "written" || perWrite.status === "read-back-mismatch" ? perWrite.readBack : null,
      requested: perWrite.plan.value,
      rawHex: "rawHex" in perWrite ? perWrite.rawHex : undefined,
      note: describeWriteOutcome(perWrite),
    });
  }

  const writes: PerWriteResult[] = outcome.results.map(perWrite => ({
    name: perWrite.plan.name,
    status: perWrite.status,
    message: describeWriteOutcome(perWrite),
    succeeded: perWrite.status === "written",
    onBike: readingAfter(perWrite),
  }));
  const writtenCount = writes.filter(write => write.succeeded).length;
  const allWritten = writtenCount === writes.length;
  return {
    ok: true,
    result: {
      action: "parameter-write",
      status: allWritten ? "written" : writtenCount > 0 ? "partial" : "failed",
      message: `Wrote ${writtenCount} of ${writes.length} parameters in one authenticated session.`,
      succeeded: allWritten,
      writes,
    },
  };
}

/**
 * What the parameter reads on the bike at the end of a write attempt, or null.
 *
 * Only the outcomes that actually READ it: the read-back a write does, and the
 * compare-and-swap's surprise value. `refused` and `failed` are not readings — the
 * micro said no, or the exchange died, and neither says what the cell holds.
 */
function readingAfter(outcome: ServiceWriteOutcome): { name: string; value: number; rawHex: string | null } | null {
  switch (outcome.status) {
    case "written":
    case "read-back-mismatch":
      return { name: outcome.plan.name, value: outcome.readBack, rawHex: outcome.rawHex };
    case "stale-precondition":
      // No rawHex on this one: ./write-session.ts compares the typed value and the bytes
      // are not carried out of the read. The number is the point here anyway.
      return { name: outcome.plan.name, value: outcome.actual, rawHex: null };
    case "refused":
    case "failed":
      return null;
  }
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
 * Commands the charge current, choosing the opcode and ceiling from the LIVE session state.
 *
 * ⚠️ The mode is read off charge_manager_state here rather than trusted from the caller: the two
 * frames are otherwise identical, and a DC-framed command sent into an AC session (or vice versa)
 * is silently ignored by the VCU, so a page that opened during a DC charge must not be able to
 * command DC into the AC charge that replaced it. For the same reason the command is refused
 * outright unless a session is established — charge_manager_state present, fresh, and one of
 * AC (0x02) / DC (0x23). ⚠️ NOT charge_type: it flaps 1↔0 mid-session (see CHARGE_SESSION_MAX_AGE_MS).
 *
 * The ceiling (b4) is not a guess: DC uses fast_dc_limit_max_a (a 10 Hz broadcast, always
 * present awake), AC uses ac_charge_ceiling_a (the dash's own last b4, an EVENT). If the AC
 * ceiling has not been seen this session the command is refused with the remedy, because a
 * wrong b4 makes the VCU reject the value and settle on a ~10 A default — the exact silent
 * mis-command this whole feature exists to avoid. docs/can-0x121-charge-command.md.
 */
async function performChargeCurrent(
  context: WriteContext,
  request: Extract<ServiceWriteRequest, { kind: "charge-current" }>,
  channel: RawChannel
): Promise<ServiceWriteAnswer> {
  const chargeState = latestValue("charge_manager_state");
  const chargeStateAge = ageMs("charge_manager_state");
  if (chargeState === null || chargeStateAge === null || chargeStateAge > CHARGE_SESSION_MAX_AGE_MS) {
    return {
      ok: false,
      reason:
        "not charging — charge_manager_state is absent or stale, so there is no live session to command a current into. Plug the bike in first.",
    };
  }
  let mode: ChargeMode;
  let ceilingKey: string;
  if (chargeState === CHARGE_MANAGER_STATE_AC) {
    mode = "ac";
    ceilingKey = "ac_charge_ceiling_a";
  } else if (chargeState === CHARGE_MANAGER_STATE_DC) {
    mode = "dc";
    ceilingKey = "fast_dc_limit_max_a";
  } else {
    return {
      ok: false,
      reason: `charge_manager_state reads 0x${chargeState.toString(16)}, not a settled AC (0x02) or DC (0x23) session — the charge handshake may still be in progress. Retry in a moment.`,
    };
  }

  // AC falls back to a known ceiling when the dash has not broadcast one this session, so a remote
  // command works without someone at the bike to nudge the dial. DC still refuses: its ceiling is a
  // continuous broadcast, so an absent one means CAN is not being received — not a case to guess.
  let ceiling = latestValue(ceilingKey);
  if (ceiling === null && mode === "ac") {
    console.warn(
      `vcu-write: AC charge ceiling (${ceilingKey}) not seen this session — defaulting b4 to ${AC_CEILING_FALLBACK_A} A. If this charger's rating differs, the VCU will settle on ~10 A.`
    );
    ceiling = AC_CEILING_FALLBACK_A;
  }
  if (ceiling === null) {
    return {
      ok: false,
      reason:
        "the DC charge ceiling (fast_dc_limit_max_a) has not arrived — it broadcasts whenever the bike is awake, so this means CAN is not being received. Not commanding blind.",
    };
  }
  if (!Number.isInteger(request.amps) || request.amps < 1 || request.amps > ceiling) {
    return {
      ok: false,
      reason: `${request.amps} A must be a whole number between 1 and the live ${mode.toUpperCase()} ceiling of ${ceiling} A`,
    };
  }

  console.warn(
    `vcu-write: about to command ${mode.toUpperCase()} charge current ${request.amps} A (ceiling ${ceiling} A) on 0x121`
  );
  const outcome = await sendChargeCommand(channel, mode, request.amps, ceiling);
  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action: "charge-current",
    status: outcome.status,
    requested: request.amps,
    // No synchronous read-back: 0x121 has no reply. The effect surfaces on the dash's set
    // display and, current permitting, on charge_limit_a — neither is available in-band here.
    after: null,
    rawHex: outcome.status === "sent" ? outcome.hex : undefined,
    note:
      outcome.status === "sent"
        ? `${mode.toUpperCase()} ${request.amps} A, ceiling ${ceiling} A, on 0x121; event frame with no reply — confirm on the dash / charge_limit_a`
        : outcome.reason,
  });
  if (outcome.status !== "sent") {
    return { ok: false, reason: outcome.reason };
  }
  return {
    ok: true,
    result: {
      action: "charge-current",
      status: "sent",
      message:
        `Commanded ${mode.toUpperCase()} charge current ${request.amps} A (${outcome.hex}). ` +
        "⚠️ This is an event frame with no reply — watch the dash's set value and charge_limit_a to see it take. " +
        "A full battery caps the current that actually flows regardless. The setting is transient (unplugging resets it) " +
        "and you can override it on the bike's own screen.",
      succeeded: true,
    },
  };
}

/**
 * Stops an active charge by injecting the 0x120 request-twin `96 ff 01 …` — the half of the dash's
 * Mode-stop that alone commits (2026-08-25 on-bike).
 *
 * Source-agnostic — the same frame ends AC and DC — so it takes no fields and, unlike
 * performChargeCurrent, needs no opcode/ceiling lookup. The one precondition is the same live
 * session: charge_manager_state present, fresh, and a settled AC (0x02) / DC (0x23) — refused
 * otherwise, since there is no charge to stop. ⚠️ NOT charge_type, which flaps mid-session.
 *
 * Fire-and-forget like charge-current: 0x120 is an event frame with no reply, so "sent" is the
 * strongest claim. The read-back is the charge tearing down (mains_v collapsing) over the
 * following seconds as the bike's "interruption in progress" countdown runs. Audited with after:null.
 */
async function performChargeStop(context: WriteContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  const chargeState = latestValue("charge_manager_state");
  const chargeStateAge = ageMs("charge_manager_state");
  if (chargeState === null || chargeStateAge === null || chargeStateAge > CHARGE_SESSION_MAX_AGE_MS) {
    return {
      ok: false,
      reason:
        "not charging — charge_manager_state is absent or stale, so there is no live session to stop. Nothing to do.",
    };
  }
  if (chargeState !== CHARGE_MANAGER_STATE_AC && chargeState !== CHARGE_MANAGER_STATE_DC) {
    return {
      ok: false,
      reason: `charge_manager_state reads 0x${chargeState.toString(16)}, not a settled AC (0x02) or DC (0x23) session — the charge handshake may still be in progress. Retry in a moment.`,
    };
  }

  const mode = chargeState === CHARGE_MANAGER_STATE_AC ? "AC" : "DC";
  console.warn(`vcu-write: about to stop the ${mode} charge — injecting the 0x120 Mode-stop request-twin`);
  const outcome = await sendChargeStopCommand(channel);
  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action: "charge-stop",
    status: outcome.status,
    // No synchronous read-back: the stop frame has no reply. The effect surfaces as the charge
    // tearing down (mains_v → 0, charger_enabled → 0) over the next several seconds.
    after: null,
    rawHex: outcome.status === "sent" ? outcome.hex : undefined,
    note:
      outcome.status === "sent"
        ? `${mode} stop on 0x120; event frame with no reply — confirm by the charge winding down`
        : outcome.reason,
  });
  if (outcome.status !== "sent") {
    return { ok: false, reason: outcome.reason };
  }
  return {
    ok: true,
    result: {
      action: "charge-stop",
      status: "sent",
      message:
        `Sent the stop-charging command (${outcome.hex}). ` +
        "⚠️ These are event frames with no reply — the charge winds down over the next several seconds " +
        "as the bike's own 'interruption in progress' countdown runs; watch mains voltage and charger_enabled fall. " +
        "You may need to unplug the cable when the bike prompts you.",
      succeeded: true,
    },
  };
}

/**
 * Restarts both VCU micros with ECUReset (`11 02`) — a key-cycle restart, nothing erased.
 *
 * Reversible, so it is NOT on the irreversible tier — but it drops the bike off the bus for a
 * second or two, and `11 02` is also the charge manager's bootloader-entry service, so it is
 * refused mid-charge: a live charge is managed by these very controllers. The charge check keys
 * on charge_manager_state (present and fresh = a live session), matching performChargeStop — the
 * reliable session signal, NOT the 0x625 dc_charging flag that false-refused the scratch script
 * on 2026-08-27. The stationary check is inherited from the shared gate; this action is not
 * gate-exempt, unlike the two charge actions. Both nodes always reset together — see resetVcu.
 */
async function performResetVcu(context: WriteContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  const chargeState = latestValue("charge_manager_state");
  const chargeStateAge = ageMs("charge_manager_state");
  if (chargeState !== null && chargeStateAge !== null && chargeStateAge <= CHARGE_SESSION_MAX_AGE_MS) {
    return {
      ok: false,
      reason:
        "a charge session is live (charge_manager_state is fresh) — do not reset the VCU mid-charge. " +
        "Stop the charge or unplug first.",
    };
  }

  console.warn("vcu-write: about to reset both VCU micros (ECUReset 11 02) — the bike drops off the bus briefly");
  const session = resetVcu(channel);
  context.running = session.session;
  const outcome = await session.finished;
  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action: "reset-vcu",
    status: outcome.status,
    // No synchronous read-back: the micros reboot before replying, and there is nothing to read
    // afterwards but a fresh session, which the page confirms on its own poll.
    after: null,
    micro: outcome.status === "refused" || outcome.status === "failed" ? outcome.micro : undefined,
    note: describeResetOutcome(outcome),
  });
  if (outcome.status !== "reset") {
    return { ok: false, reason: describeResetOutcome(outcome) };
  }
  return {
    ok: true,
    result: {
      action: "reset-vcu",
      status: "reset",
      message:
        `Restarted both VCU micros (ECUReset 11 02, a key-cycle restart — nothing erased). ${outcome.note}. ` +
        "⚠️ The bike drops off the bus for a second or two while they reboot; the dash reconnects on its own. " +
        "If a fault stays latched, key off for 30 s and on — a real power cycle clears what a reset leaves behind.",
      succeeded: true,
    },
  };
}

function describeResetOutcome(outcome: ResetVcuOutcome): string {
  switch (outcome.status) {
    case "reset":
      return `both VCU micros restarted (${outcome.note})`;
    case "refused":
      return `${outcome.micro} refused the reset: ${outcome.description}`;
    case "failed":
      return `${outcome.micro} failed at the ${outcome.stage} step: ${outcome.reason} — key off for 30 s and on to be sure of a clean state`;
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
