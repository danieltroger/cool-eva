import type { RawChannel } from "socketcan";
import { monotonicNow, since } from "../monotonic.ts";
import {
  buildRequestFrame,
  canIdsFor,
  decodeParameterReply,
  identifierFor,
  interpretRecord,
  isSessionOpened,
  parseResponseFrame,
  toHex,
  type VcuAddressedFrame,
} from "./param-codec.ts";
import {
  ROUTINE_MICROS,
  buildWriteFrame,
  decodeParameterWriteReply,
  decodeRoutineReply,
  decodeSecurityAccessReply,
  routineIdFor,
  securityKeyForSeed,
  type ServiceRoutineName,
} from "./write-codec.ts";
import { parameterAtIndex } from "./param-table.ts";
import {
  SERVICE_STAMP_IDENTIFIERS,
  SERVICE_STAMP_MICRO,
  RTC_SYNC_CAN_ID,
  buildClearDtcsFrame,
  buildRtcSyncFrame,
  decodeClearDtcsReply,
  interpretServiceStamp,
  isClearDtcsReply,
  OBD_FUNCTIONAL_REQUEST_ID,
  type ServiceStamp,
} from "./service-actions.ts";
import type { TableTypeReport } from "./snapshot.ts";
import type { ParameterWritePlan } from "./write-targets.ts";

// The transport half of writing: put the frames on the bus in the right order, at
// the right speed, and stop the moment anything is not as expected. Every byte it
// sends is built by ./param-codec.ts (the read legs) or ./write-codec.ts (the
// write legs); every byte it receives is interpreted there. This file holds only
// the socket, the clock and the sequencing.
//
// ── ⚠️ NOTHING HERE HAS EVER RUN AGAINST THE BIKE (2026-08-16) ───────────────
// The bike is a week away. The SERVICES and their framing are proven — from a
// passive capture of Energica's own software writing to this bike's A8
// (obd-garage/DIAG_ADDRESSES.md §9) and from five parameters written to this bike
// with obd-garage/vcu_param.py on 2026-08-09 — but not one frame in this file has
// been transmitted by this repo. The SEQUENCING below is the part with no live
// evidence at all, and it is the part most likely to be wrong.
//
// ── The sequence, and why each step is where it is ──────────────────────────
//
//     10 81        open a session on the micro that owns the parameter
//     22 CID       read what it holds RIGHT NOW
//     ── compare against what the caller thought it held; refuse on disagreement
//     27 01        ask for a seed
//     27 02 <key>  answer it
//     2E CID <v>   write            ← must be within ~2 s of the line above
//     22 CID       READ IT BACK
//     ── compare against what was written; a mismatch is reported, loudly
//
// The two reads are the point. `2E`'s positive reply is `6E <hi> <lo>` and carries
// NO VALUE (DIAG_ADDRESSES.md §9.2), so "the micro accepted it" is not the same
// claim as "the cell now holds that number" — and another owner's tool has a
// failure message for exactly the gap between them: "the ECU accepted the write but
// the value reverted. That usually means the parameter is recomputed from something
// else." Nothing here reports success without having read the value back.
//
// The read BEFORE is a compare-and-swap and matters just as much. A dashboard left
// open since yesterday would otherwise write 80 over whatever the parameter has
// since become.
//
// ── ⚠️ The SecurityAccess rules, which are the sharp edges ──────────────────
//
//  1. **The unlock decays in about two seconds.** Measured across six writes by the
//     factory software (DIAG_ADDRESSES.md §9.3): 2 ms and 167 ms after the unlock
//     succeeded; 2.32 s and 4.44 s were refused with NRC 0x33. So the write follows
//     the unlock immediately, with nothing in between — no read, no logging, no
//     `await` that could be scheduled behind something else.
//  2. **A bad key costs one of about three attempts, and the lockout clears only on
//     a VCU power cycle.** That is why ./write-codec.ts's key function is asserted
//     against four real captured seed/key pairs rather than trusted.
//  3. **Running `27` against an ALREADY-UNLOCKED micro returns NRC 0x35 invalidKey
//     and burns an attempt.** obd-garage/VCU_PARAM_CHANGES.md records one being
//     burned this way. Two writes in quick succession would do it — the second one's
//     `27 01` would land while the first one's unlock was still live — so
//     SECURITY_COOLDOWN_MS below refuses to start a second authenticated operation
//     until the unlock has certainly expired. It costs four seconds and it protects
//     the one resource here that cannot be replenished without walking to the bike
//     and turning it off.

/** How one authenticated operation came out. Resolves; nothing here rejects. */
export type ServiceWriteOutcome =
  /** The write was accepted AND read back as the value that was written. The only success. */
  | { status: "written"; plan: ParameterWritePlan; readBack: number; rawHex: string }
  /**
   * The micro accepted the write and the read-back says something else.
   *
   * ⚠️ The loudest outcome here. It means the EEPROM cell did not take the value —
   * because the parameter is recomputed from something else, because it is
   * read-only despite answering `6E`, or because something wrote over it. The
   * value that IS there is reported, never the value that was asked for.
   */
  | { status: "read-back-mismatch"; plan: ParameterWritePlan; readBack: number; rawHex: string }
  /**
   * Nothing was written, and the parameter did not hold what the caller thought.
   *
   * The compare-and-swap failing. Reported with both numbers so the page can say
   * "you were looking at 75, it reads 80" rather than a bare refusal.
   */
  | { status: "stale-precondition"; plan: ParameterWritePlan; actual: number }
  /** The micro said no, by name. `0x33` is a stale unlock; `0x31` is "I will not take that value". */
  | {
      status: "refused";
      plan: ParameterWritePlan;
      stage: WriteStage;
      negativeResponseCode: number;
      description: string;
    }
  /** Something went wrong that is not the micro refusing. `stage` says how far it got. */
  | { status: "failed"; plan: ParameterWritePlan; stage: WriteStage; reason: string };

/** How far an operation got. On the audit record, because "refused" means different things at each step. */
export type WriteStage = "session" | "read-before" | "security-seed" | "security-key" | "write" | "read-back";

/** How the Set Service Point routine came out. */
export type ServicePointOutcome =
  /** `71 FC` came back, and the stamp was re-read afterwards. `after` is null when the re-read failed. */
  | { status: "started"; before: ServiceStamp | null; after: ServiceStamp | null }
  | { status: "refused"; stage: WriteStage | "routine"; negativeResponseCode: number; description: string }
  | { status: "failed"; stage: WriteStage | "routine"; reason: string };

/** How a Mode 04 clear came out. */
export type ClearDtcsOutcome =
  | { status: "cleared" }
  | { status: "refused"; negativeResponseCode: number; description: string }
  | { status: "failed"; reason: string };

/** A reply window. Inherited from ./kwp-client.ts rather than measured for this path. */
const RESPONSE_TIMEOUT_MS = 300;

/** Gap after every exchange, so this is polite to a bus shared with the ABS and the BMS at 20 Hz. */
const PACE_MS = 10;

/**
 * How long after an authenticated operation another one may start.
 *
 * The session and the security unlock both decay on the same ~2.5 s idle timer
 * (DIAG_ADDRESSES.md §3, §9.3). Four seconds is that plus margin, and it exists to
 * stop a second `27 01` landing while the first unlock is still live — which returns
 * NRC 0x35 invalidKey and spends one of the ~3 attempts before the micro locks out
 * until someone power-cycles the bike.
 *
 * Deliberately a REFUSAL rather than a wait: a button that silently blocks for four
 * seconds looks broken, and the page can say "wait 2 s" perfectly well.
 */
export const SECURITY_COOLDOWN_MS = 4000;

/**
 * Monotonic mark of the last authenticated exchange per micro.
 *
 * Module-level because the cooldown has to survive one operation ending and the next
 * one starting, and those are separate objects by construction. Monotonic, never
 * `Date.now()`: this Pi steps its own wall clock from GPS mid-run, and a backwards
 * step would make a two-second-old unlock look four seconds old — which is exactly
 * the mistake that burns an attempt.
 */
const lastAuthenticatedAt = new Map<string, number>();

/** How much longer this micro must be left alone, in ms. Zero when it is free. Pure. */
export function securityCooldownRemainingMs(lastAt: number | undefined, elapsedMs: number): number {
  if (lastAt === undefined) {
    return 0;
  }
  return Math.max(0, SECURITY_COOLDOWN_MS - elapsedMs);
}

/** An operation in flight. */
export interface RunningWriteSession {
  /** Feed every received CAN frame here; true when it was consumed. */
  handleFrame: (id: number, data: Buffer) => boolean;
  /** Stops it. The in-flight request settles as our doing, never as the bike's. */
  abort: (reason: string) => void;
}

interface SessionContext {
  channel: RawChannel;
  pending: {
    resolve: (frame: VcuAddressedFrame) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  pendingResponseCanId: number | null;
  /**
   * True while the reply we are waiting for is a plain OBD one (Mode 04), which is
   * NOT extended-addressed: byte 0 is an ISO-TP length nibble, not the tester's
   * address. Parsing it with the VCU's parser would discard it as "addressed to
   * 0x01, not the tester".
   */
  pendingIsObd: boolean;
  /**
   * The micro this session has unlocked, or null.
   *
   * ⚠️ Kept so the cooldown mark can be pushed forward on EVERY exchange after the
   * unlock, not only when it was granted. The micro's unlock decays on a ~2.5 s IDLE
   * timer, and every request re-arms that timer — so stamping only at the start of
   * `unlock` measured from the wrong end. `runSetServicePoint` is where it bites:
   * after the unlock come `31 FC` and four stamp read-backs, seven exchanges, up to
   * ~2.2 s if they all time out. The unlock would then expire at ~4.7 s while the
   * cooldown cleared at 4.0 s, and the next action's `27 01` would hit a still-
   * unlocked micro, get invalidKey, and spend one of about three attempts — the exact
   * outcome the cooldown exists to prevent.
   */
  unlockedMicro: string | null;
  stopped: boolean;
  stoppedReason: string | null;
}

/**
 * Writes one parameter, start to finish, and reads it back.
 *
 * Everything is sequential and awaited. There is deliberately no concurrency here at
 * all: one reply id serves every micro with no request/response tag to match on, so
 * two requests in flight would be answered by whichever frame landed first — and on
 * this path that could mean filing a seed as a write acknowledgement.
 */
export function writeParameter(
  channel: RawChannel,
  plan: ParameterWritePlan,
  tableType: TableTypeReport | null
): { session: RunningWriteSession; finished: Promise<ServiceWriteOutcome> } {
  const context = newContext(channel);
  return { session: sessionHandle(context), finished: runParameterWrite(context, plan, tableType) };
}

async function runParameterWrite(
  context: SessionContext,
  plan: ParameterWritePlan,
  tableType: TableTypeReport | null
): Promise<ServiceWriteOutcome> {
  const micro = plan.micro;
  const cooldown = cooldownFor(micro);
  if (cooldown > 0) {
    return {
      status: "failed",
      plan,
      stage: "session",
      reason:
        `${micro} was authenticated ${Math.round((SECURITY_COOLDOWN_MS - cooldown) / 100) / 10} s ago — ` +
        `wait ${Math.ceil(cooldown / 1000)} s. Asking a micro that is still unlocked for a seed returns invalidKey ` +
        "and spends one of about three attempts before it locks out until the bike is power-cycled.",
    };
  }

  if (!(await openSession(context, micro))) {
    return { status: "failed", plan, stage: "session", reason: `${micro} did not answer 10 81` };
  }

  // ── Compare-and-swap, first half ──────────────────────────────────────────
  const before = await readParameterValue(context, micro, plan.index);
  if (before.kind !== "value") {
    return { status: "failed", plan, stage: "read-before", reason: before.reason };
  }
  if (before.value !== plan.previousValue) {
    return { status: "stale-precondition", plan, actual: before.value };
  }
  if (before.value === plan.value) {
    // Refused rather than written as a no-op. A pointless write still spends a
    // SecurityAccess attempt, and those are the scarce thing here.
    return {
      status: "failed",
      plan,
      stage: "read-before",
      reason: `${plan.name} already reads ${plan.value} — nothing to write`,
    };
  }

  // ── SecurityAccess, then the write, with nothing in between ───────────────
  const unlocked = await unlock(context, micro);
  if (unlocked.kind === "refused") {
    return {
      status: "refused",
      plan,
      stage: unlocked.stage,
      negativeResponseCode: unlocked.negativeResponseCode,
      description: unlocked.description,
    };
  }
  if (unlocked.kind === "failed") {
    return { status: "failed", plan, stage: unlocked.stage, reason: unlocked.reason };
  }

  // Nothing between the unlock and this line. No logging, no extra await, no read —
  // the window is about two seconds and the factory software's own successful writes
  // followed within 2 ms and 167 ms.
  const written = await exchange(context, micro, { kind: "write-parameter", plan, tableType });
  if (written.kind !== "reply") {
    return { status: "failed", plan, stage: "write", reason: describeExchangeFailure(written) };
  }
  if (written.frame.kind !== "payload") {
    return { status: "failed", plan, stage: "write", reason: `the reply was a ${written.frame.kind} frame` };
  }
  const reply = decodeParameterWriteReply(written.frame.payload, plan.identifier);
  if (reply.kind === "refused") {
    return {
      status: "refused",
      plan,
      stage: "write",
      negativeResponseCode: reply.negativeResponseCode,
      // NRC 0x33 here is the one worth explaining: it means the unlock went stale,
      // which is a timing problem on our side rather than the micro objecting to the
      // value. The factory software's own recovery is to re-run SA and retry.
      description:
        reply.negativeResponseCode === 0x33
          ? `${reply.description} — the unlock went stale before the write landed; try again`
          : reply.description,
    };
  }
  if (reply.kind !== "accepted") {
    return { status: "failed", plan, stage: "write", reason: describeWriteReply(reply) };
  }

  // ── Read-back. The only thing that turns "accepted" into "written". ───────
  const after = await readParameterValue(context, micro, plan.index);
  if (after.kind !== "value") {
    // NOT reported as a success with an unknown read-back. A write we cannot confirm
    // is a write we do not know happened, and this is a calibration EEPROM.
    return {
      status: "failed",
      plan,
      stage: "read-back",
      reason: `the micro accepted the write and then would not say what it holds: ${after.reason}`,
    };
  }
  const status = after.value === plan.value ? "written" : "read-back-mismatch";
  return { status, plan, readBack: after.value, rawHex: after.rawHex };
}

/**
 * Reads the four WORDs of the last-service stamp off A8. Read-only — no
 * SecurityAccess, no write service, nothing that changes anything.
 *
 * Kept apart from the routine below on purpose: the page has to show the current
 * stamp BEFORE offering to overwrite it, and reading it must not be entangled with
 * anything that could.
 */
export function readServiceStamp(
  channel: RawChannel,
  nowMs: number
): {
  session: RunningWriteSession;
  finished: Promise<{ ok: true; stamp: ServiceStamp } | { ok: false; reason: string }>;
} {
  const context = newContext(channel);
  return { session: sessionHandle(context), finished: runReadServiceStamp(context, nowMs) };
}

async function runReadServiceStamp(
  context: SessionContext,
  nowMs: number
): Promise<{ ok: true; stamp: ServiceStamp } | { ok: false; reason: string }> {
  if (!(await openSession(context, SERVICE_STAMP_MICRO))) {
    return { ok: false, reason: `${SERVICE_STAMP_MICRO} did not answer 10 81` };
  }
  const raw: Record<string, number> = {};
  for (const [field, entry] of Object.entries(SERVICE_STAMP_IDENTIFIERS)) {
    const outcome = await readIdentifier(context, SERVICE_STAMP_MICRO, entry.identifier);
    if (outcome.kind !== "record") {
      // Named rather than collapsed: SERVICE_RESET.md §2 records the service tool
      // treating a refusal here as "this motorcycle does not have the feature", which is a
      // different thing from the bus having gone quiet.
      return {
        ok: false,
        reason: `${field} (identifier 0x${entry.identifier.toString(16).toUpperCase()}) — ${outcome.reason}. These four identifiers have never been read off this bike; a refusal may simply mean it does not carry a service stamp.`,
      };
    }
    // Each half is a WORD, so a record of any other width means the assumption is
    // wrong and the arithmetic below would silently produce a plausible date.
    if (outcome.record.length !== 2) {
      return {
        ok: false,
        reason: `${field} answered ${outcome.record.length} byte(s) (${toHex(outcome.record)}), not the 2 a WORD should be`,
      };
    }
    raw[field] = (outcome.record[0] << 8) | outcome.record[1];
  }
  return {
    ok: true,
    stamp: interpretServiceStamp(
      {
        dateLow: raw.dateLow,
        dateHigh: raw.dateHigh,
        odometerLow: raw.odometerLow,
        odometerHigh: raw.odometerHigh,
      },
      nowMs
    ),
  };
}

/**
 * Runs Set Service Point: `31 FC` on A8, after a session and SecurityAccess.
 *
 * ⚠️ IRREVERSIBLE. The routine takes no parameters — the firmware stamps its own
 * current RTC time and odometer into the last-service block, and there is no "unset".
 * The stamp is read before and after so the audit record holds both, which is the
 * only trace of what was overwritten.
 */
export function setServicePoint(
  channel: RawChannel,
  nowMs: number
): { session: RunningWriteSession; finished: Promise<ServicePointOutcome> } {
  const context = newContext(channel);
  return { session: sessionHandle(context), finished: runSetServicePoint(context, nowMs) };
}

async function runSetServicePoint(context: SessionContext, nowMs: number): Promise<ServicePointOutcome> {
  const routine: ServiceRoutineName = "set-service-point";
  const micro = ROUTINE_MICROS[routine];
  const cooldown = cooldownFor(micro);
  if (cooldown > 0) {
    return {
      status: "failed",
      stage: "session",
      reason: `${micro} is still unlocked — wait ${Math.ceil(cooldown / 1000)} s`,
    };
  }
  if (!(await openSession(context, micro))) {
    return { status: "failed", stage: "session", reason: `${micro} did not answer 10 81` };
  }

  // Read the stamp we are about to overwrite. It is the only record of what was
  // there, and it goes into the audit journal whether or not the routine then works.
  const beforeRead = await runReadStampInSession(context, nowMs);
  const before = beforeRead.ok ? beforeRead.stamp : null;
  if (!beforeRead.ok) {
    // Loud, and NOT fatal. Refusing the routine because we could not read the old
    // stamp would make a bike that simply does not serve those four identifiers
    // unable to have its service point set at all — and SERVICE_RESET.md is explicit
    // that the routine and the stamp read are separate features that a bike can have
    // one of. The audit record carries the null.
    console.warn(`vcu-write: could not read the service stamp before setting it — ${beforeRead.reason}`);
  }

  const unlocked = await unlock(context, micro);
  if (unlocked.kind === "refused") {
    return {
      status: "refused",
      stage: unlocked.stage,
      negativeResponseCode: unlocked.negativeResponseCode,
      description: unlocked.description,
    };
  }
  if (unlocked.kind === "failed") {
    return { status: "failed", stage: unlocked.stage, reason: unlocked.reason };
  }

  const started = await exchange(context, micro, { kind: "start-routine", routine });
  if (started.kind !== "reply") {
    return { status: "failed", stage: "routine", reason: describeExchangeFailure(started) };
  }
  if (started.frame.kind !== "payload") {
    return { status: "failed", stage: "routine", reason: `the reply was a ${started.frame.kind} frame` };
  }
  const reply = decodeRoutineReply(started.frame.payload, routine);
  if (reply.kind === "refused") {
    return {
      status: "refused",
      stage: "routine",
      negativeResponseCode: reply.negativeResponseCode,
      description: reply.description,
    };
  }
  if (reply.kind !== "started") {
    // ⚠️ Reported as a failure, not a success. `71 FC` is INFERRED, not logged
    // (SERVICE_RESET.md §3) — so an unexpected shape means we do not know whether the
    // routine ran, and on an irreversible action the optimistic reading is the one
    // that cannot be taken back.
    return {
      status: "failed",
      stage: "routine",
      reason:
        reply.kind === "routine-mismatch"
          ? `the micro echoed routine 0x${reply.received.toString(16)}, not 0x${routineIdFor(routine).toString(16)} — we do not know what ran`
          : `${reply.reason}. The positive response to 31 FC was never logged by anyone, so an unexpected shape means the outcome is unknown, not that it failed.`,
    };
  }

  // Re-read, so the page can show what the firmware actually stamped rather than what
  // it was asked to. This is also the only check on the bike's RTC being right.
  const afterRead = await runReadStampInSession(context, nowMs);
  return { status: "started", before, after: afterRead.ok ? afterRead.stamp : null };
}

/** The stamp read, assuming a session is already open. Shared by the read action and the routine. */
async function runReadStampInSession(
  context: SessionContext,
  nowMs: number
): Promise<{ ok: true; stamp: ServiceStamp } | { ok: false; reason: string }> {
  const raw: Record<string, number> = {};
  for (const [field, entry] of Object.entries(SERVICE_STAMP_IDENTIFIERS)) {
    const outcome = await readIdentifier(context, SERVICE_STAMP_MICRO, entry.identifier);
    if (outcome.kind !== "record" || outcome.record.length !== 2) {
      return { ok: false, reason: `${field}: ${outcome.kind === "record" ? "wrong width" : outcome.reason}` };
    }
    raw[field] = (outcome.record[0] << 8) | outcome.record[1];
  }
  return {
    ok: true,
    stamp: interpretServiceStamp(
      { dateLow: raw.dateLow, dateHigh: raw.dateHigh, odometerLow: raw.odometerLow, odometerHigh: raw.odometerHigh },
      nowMs
    ),
  };
}

/**
 * Sends OBD Mode 04 and waits for `44`.
 *
 * A different framing from everything above — plain ISO-TP on 0x7DF, not the VCU
 * micros' extended addressing — so it does not go through the KWP session at all.
 * There is no session to open and no SecurityAccess: mode 04 is unauthenticated by
 * design, which is precisely why it is behind the gate, the enable switch and the
 * confirmation instead.
 */
export function clearStoredDtcs(channel: RawChannel): {
  session: RunningWriteSession;
  finished: Promise<ClearDtcsOutcome>;
} {
  const context = newContext(channel);
  return { session: sessionHandle(context), finished: runClearDtcs(context) };
}

async function runClearDtcs(context: SessionContext): Promise<ClearDtcsOutcome> {
  const result = await exchangeRaw(context, {
    requestCanId: OBD_FUNCTIONAL_REQUEST_ID,
    // Any ECU in the OBD range may answer a functional request. 0x7E8 is what a car
    // would use and this VCU answers mode 03 on 0x7EF, so the whole range is
    // accepted rather than one id guessed at.
    responseCanId: null,
    frame: buildClearDtcsFrame(),
    isObd: true,
  });
  if (result.kind !== "reply") {
    return { status: "failed", reason: describeExchangeFailure(result) };
  }
  const reply = decodeClearDtcsReply(result.raw);
  switch (reply.kind) {
    case "cleared":
      return { status: "cleared" };
    case "refused":
      return { status: "refused", negativeResponseCode: reply.negativeResponseCode, description: reply.description };
    case "unrecognised":
      return { status: "failed", reason: reply.reason };
  }
}

/**
 * Broadcasts the Pi's UTC onto CAN 0x120, setting the bike's own clock.
 *
 * ⚠️ FIRE AND FORGET, and that is not a shortcut — it is what the mechanism is.
 * Energica's `UpdateRTC()` sends one frame, sleeps 100 ms and returns true
 * unconditionally; there is no reply to wait for, no session to open and no
 * SecurityAccess. So "sent" is the strongest claim this function can make, and it
 * makes exactly that one. There is also no way to read the bike's clock back — no
 * parameter, no service, no broadcast carries it — so nothing here can confirm the
 * bike took it. The confirmation for this action is therefore in front of it (the
 * owner agreeing to the time) rather than behind it.
 *
 * Synchronous and outside the exchange machinery for the same reason: there is
 * nothing to await.
 */
export function syncBikeClock(
  channel: RawChannel,
  when: Date
): { status: "sent"; hex: string } | { status: "failed"; reason: string } {
  const frame = buildRtcSyncFrame(when);
  try {
    channel.send({ id: RTC_SYNC_CAN_ID, ext: false, rtr: false, data: Buffer.from(frame) });
  } catch (err) {
    console.error("vcu-write: could not broadcast the clock sync", err);
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  // Logged with the bytes, because this is the one action with no read-back at all
  // and the journal line is the only evidence it ever happened.
  console.warn(`vcu-write: broadcast the clock on 0x120 as ${when.toISOString()} — ${toHex(frame)}`);
  return { status: "sent", hex: toHex(frame) };
}

// ── The machinery below: one request in flight, one reply window, paced ─────
//
// Structurally the same as ./kwp-client.ts's exchange loop, and deliberately a
// separate copy rather than a shared one. Unifying them means refactoring the READ
// path — which is proven against a simulated micro and against frames captured off
// the bus — inside a pull request whose subject is writes. That is the wrong risk to
// take in the wrong PR. If a third caller ever appears, extract it then.

function newContext(channel: RawChannel): SessionContext {
  return {
    channel,
    pending: null,
    pendingResponseCanId: null,
    pendingIsObd: false,
    unlockedMicro: null,
    stopped: false,
    stoppedReason: null,
  };
}

function sessionHandle(context: SessionContext): RunningWriteSession {
  return {
    handleFrame: (id, data) => handleFrame(context, id, data),
    abort: reason => stop(context, reason),
  };
}

function cooldownFor(micro: string): number {
  const mark = lastAuthenticatedAt.get(micro);
  return securityCooldownRemainingMs(mark, mark === undefined ? 0 : since(mark));
}

function handleFrame(context: SessionContext, id: number, data: Buffer): boolean {
  if (context.pending === null) {
    return false;
  }
  if (context.pendingIsObd) {
    // The whole OBD response range, because a functional request may be answered by
    // any ECU on it — this VCU answers mode 03 on 0x7EF rather than the 0x7E8 a car
    // would use, so pinning one id would miss the reply.
    if (id < 0x7e0 || id > 0x7ef) {
      return false;
    }
    // ⚠️ …but the id alone is NOT enough to say a frame is ours. The always-on OBD
    // poller is never paused by service mode — the bus lease excludes the two
    // service-mode runners from each other, and the poller holds no lease — so it is
    // sending mode-01 PIDs, and sometimes a multi-frame mode-03 transfer, throughout
    // the 300 ms we wait in. Consuming one of those would report "nothing confirmed"
    // for an action that may already have erased the bike's diagnostic memory, AND
    // take the frame away from the poller (index.ts returns as soon as this says
    // true), which for a Consecutive Frame loses a whole transfer.
    //
    // The KWP legs need no equivalent: parseResponseFrame demands byte 0 == 0xF1 and
    // no ISO-TP PCI can be 0xF1. Mode 04 has no such discriminator, so it gets one.
    if (!isClearDtcsReply(data)) {
      return false;
    }
    const waiting = context.pending;
    context.pending = null;
    clearTimeout(waiting.timer);
    // Copied, not sliced: a Buffer's `slice` is a VIEW, and this payload outlives
    // the frame handler by at least one await. Same trap param-codec.ts documents.
    waiting.resolve({ kind: "payload", payload: Uint8Array.from(data) });
    return true;
  }
  if (id !== context.pendingResponseCanId) {
    return false;
  }
  const frame = parseResponseFrame(data);
  if (frame.kind === "ignored") {
    // Another tester's traffic, or a micro answering someone else. Handed back
    // rather than swallowed — the OBD poller shares this range.
    return false;
  }
  const waiting = context.pending;
  context.pending = null;
  clearTimeout(waiting.timer);
  waiting.resolve(frame);
  return true;
}

async function openSession(context: SessionContext, micro: "A8" | "A9"): Promise<boolean> {
  const result = await exchange(context, micro, null);
  return result.kind === "reply" && result.frame.kind === "payload" && isSessionOpened(result.frame.payload);
}

type UnlockResult =
  | { kind: "unlocked" }
  | { kind: "refused"; stage: WriteStage; negativeResponseCode: number; description: string }
  | { kind: "failed"; stage: WriteStage; reason: string };

/**
 * `27 01` then `27 02`.
 *
 * The mark is set BEFORE the key is sent, not after it succeeds: an attempt that
 * failed still left the micro in a state where another `27 01` is a bad idea, and
 * the cooldown exists to protect the attempt counter rather than to track successes.
 *
 * On success `unlockedMicro` is set, which makes every LATER exchange in this session
 * push the mark forward — so the four seconds are counted from the last frame the
 * operation sent, which is what the micro's own idle timer counts from too.
 */
async function unlock(context: SessionContext, micro: "A8" | "A9"): Promise<UnlockResult> {
  lastAuthenticatedAt.set(micro, monotonicNow());
  const seedExchange = await exchange(context, micro, { kind: "security-seed" });
  if (seedExchange.kind !== "reply") {
    return { kind: "failed", stage: "security-seed", reason: describeExchangeFailure(seedExchange) };
  }
  if (seedExchange.frame.kind !== "payload") {
    return { kind: "failed", stage: "security-seed", reason: `the reply was a ${seedExchange.frame.kind} frame` };
  }
  const seedReply = decodeSecurityAccessReply(seedExchange.frame.payload);
  if (seedReply.kind === "refused") {
    return {
      kind: "refused",
      stage: "security-seed",
      negativeResponseCode: seedReply.negativeResponseCode,
      description: seedReply.description,
    };
  }
  if (seedReply.kind !== "seed") {
    return {
      kind: "failed",
      stage: "security-seed",
      reason: seedReply.kind === "unlocked" ? "the micro reports it is already unlocked" : seedReply.reason,
    };
  }

  const keyExchange = await exchange(context, micro, { kind: "security-key", key: securityKeyForSeed(seedReply.seed) });
  if (keyExchange.kind !== "reply") {
    return { kind: "failed", stage: "security-key", reason: describeExchangeFailure(keyExchange) };
  }
  if (keyExchange.frame.kind !== "payload") {
    return { kind: "failed", stage: "security-key", reason: `the reply was a ${keyExchange.frame.kind} frame` };
  }
  const keyReply = decodeSecurityAccessReply(keyExchange.frame.payload);
  if (keyReply.kind === "refused") {
    return {
      kind: "refused",
      stage: "security-key",
      negativeResponseCode: keyReply.negativeResponseCode,
      // 0x35 is the expensive one and is worth spelling out where it is seen.
      description:
        keyReply.negativeResponseCode === 0x35
          ? `${keyReply.description} — that is one of about three attempts, and the lockout clears only on a VCU power cycle`
          : keyReply.description,
    };
  }
  if (keyReply.kind !== "unlocked") {
    // A `seed` here means the micro answered `27 02` with another `67 01` — a second
    // challenge rather than an acceptance. Never observed, and named rather than
    // folded into "unrecognised" because treating it as an unlock would put a write
    // on a bus that had not authorised one.
    return {
      kind: "failed",
      stage: "security-key",
      reason:
        keyReply.kind === "seed"
          ? "the micro answered the key with another seed instead of accepting it — it is not unlocked"
          : keyReply.reason,
    };
  }
  context.unlockedMicro = micro;
  return { kind: "unlocked" };
}

type IdentifierRead = { kind: "record"; record: Uint8Array } | { kind: "failed"; reason: string };

/** One `22` read of a raw identifier, in an already-open session. Built by the READ codec. */
async function readIdentifier(
  context: SessionContext,
  micro: "A8" | "A9",
  identifier: number
): Promise<IdentifierRead> {
  const bank = identifier >> 12;
  const index = identifier & 0x0fff;
  const result = await exchange(context, micro, { kind: "read-parameter", bank, index });
  if (result.kind !== "reply") {
    return { kind: "failed", reason: describeExchangeFailure(result) };
  }
  if (result.frame.kind !== "payload") {
    return { kind: "failed", reason: `the reply was a ${result.frame.kind} frame` };
  }
  const reply = decodeParameterReply(result.frame.payload, identifierFor(bank, index));
  switch (reply.kind) {
    case "record":
      return { kind: "record", record: reply.record };
    case "refused":
      return { kind: "failed", reason: `refused with NRC ${reply.description}` };
    case "identifier-mismatch":
      return {
        kind: "failed",
        reason: `the reply answered 0x${reply.received.toString(16)}, not 0x${reply.expected.toString(16)}`,
      };
    case "unrecognised":
      return { kind: "failed", reason: reply.reason };
  }
}

type ParameterRead = { kind: "value"; value: number; rawHex: string } | { kind: "failed"; reason: string };

/** One `22` read of a named bank-1 parameter, typed the way the name table says to read it. */
async function readParameterValue(context: SessionContext, micro: "A8" | "A9", index: number): Promise<ParameterRead> {
  const outcome = await readIdentifier(context, micro, identifierFor(1, index));
  if (outcome.kind !== "record") {
    return { kind: "failed", reason: outcome.reason };
  }
  const parameter = parameterAtIndex(index);
  const interpreted = interpretRecord(outcome.record, parameter);
  if (interpreted.value === null) {
    // The typed reading is what a write is compared against, so there is no honest
    // way to proceed without one. `widthMismatch` here would mean the record is not
    // the width params.ecf claims — which is the one thing that would make a
    // read-back comparison meaningless.
    return {
      kind: "failed",
      reason: `the reply ${toHex(outcome.record)} does not match what params.ecf says this parameter's width and sign are`,
    };
  }
  return { kind: "value", value: interpreted.value, rawHex: interpreted.rawHex };
}

type ExchangeResult =
  | { kind: "reply"; frame: VcuAddressedFrame; raw: Uint8Array }
  | { kind: "timeout" }
  | { kind: "not-sent"; reason: string };

/** One VCU request. A null request means `10 81`, which the read codec builds. */
function exchange(
  context: SessionContext,
  micro: "A8" | "A9",
  request: Parameters<typeof buildWriteFrame>[1] | { kind: "read-parameter"; bank: number; index: number } | null
): Promise<ExchangeResult> {
  const frame =
    request === null
      ? buildRequestFrame(micro, { kind: "start-session" })
      : request.kind === "read-parameter"
        ? buildRequestFrame(micro, request)
        : buildWriteFrame(micro, request);
  const canIds = canIdsFor(micro);
  return exchangeRaw(context, { requestCanId: canIds.request, responseCanId: canIds.response, frame, isObd: false });
}

/** The one place anything is transmitted. */
function exchangeRaw(
  context: SessionContext,
  options: { requestCanId: number; responseCanId: number | null; frame: Uint8Array; isObd: boolean }
): Promise<ExchangeResult> {
  if (context.stopped) {
    return Promise.resolve({ kind: "not-sent", reason: context.stoppedReason ?? "session stopped" });
  }
  if (context.pending) {
    const reason = "a request was already in flight";
    console.warn(`vcu-write: ${reason} — refusing to interleave a second one`);
    return Promise.resolve({ kind: "not-sent", reason });
  }
  const data = Buffer.from(options.frame);
  return new Promise<ExchangeResult>(resolve => {
    const settle = (result: ExchangeResult): void => {
      context.pendingResponseCanId = null;
      context.pendingIsObd = false;
      if (context.unlockedMicro !== null) {
        // Pushed forward on every exchange once this session holds an unlock, so the
        // cooldown is measured from the LAST frame of the operation rather than from
        // the moment SecurityAccess began. The micro's own unlock decays on an idle
        // timer that each request re-arms, so this is the mark that tracks it. See
        // `unlockedMicro` on SessionContext for what went wrong without it.
        lastAuthenticatedAt.set(context.unlockedMicro, monotonicNow());
      }
      // Paced on the way out, so every path here is polite to the bus by default
      // rather than by a caller remembering to be.
      setTimeout(() => resolve(result), PACE_MS);
    };
    const timer = setTimeout(() => {
      context.pending = null;
      settle({ kind: "timeout" });
    }, RESPONSE_TIMEOUT_MS);
    context.pending = {
      resolve: frame =>
        settle({ kind: "reply", frame, raw: frame.kind === "payload" ? frame.payload : new Uint8Array() }),
      timer,
    };
    context.pendingResponseCanId = options.responseCanId;
    context.pendingIsObd = options.isObd;

    try {
      context.channel.send({ id: options.requestCanId, ext: false, rtr: false, data });
    } catch (err) {
      clearTimeout(timer);
      context.pending = null;
      // Loud: a bus that will not take an 8-byte frame is a much bigger problem than
      // this write, and on this Pi it usually means can0 went down under us.
      console.error("vcu-write: send failed", err);
      settle({ kind: "not-sent", reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

function stop(context: SessionContext, reason: string): void {
  context.stopped = true;
  context.stoppedReason = reason;
  context.pendingResponseCanId = null;
  const waiting = context.pending;
  if (waiting) {
    context.pending = null;
    clearTimeout(waiting.timer);
    // Settled as an empty payload, which every decoder above reports as
    // `unrecognised` and no caller reads as success. "We stopped" must never be
    // written down as "the bike answered".
    waiting.resolve({ kind: "payload", payload: new Uint8Array() });
  }
}

function describeExchangeFailure(result: Exclude<ExchangeResult, { kind: "reply" }>): string {
  return result.kind === "timeout" ? "no reply within the 300 ms window" : `never reached the bus — ${result.reason}`;
}

function describeWriteReply(reply: { kind: string; expected?: number; received?: number; reason?: string }): string {
  if (reply.kind === "identifier-mismatch") {
    return `the micro acknowledged identifier 0x${reply.received?.toString(16)}, not the 0x${reply.expected?.toString(16)} we wrote — nothing here can say what was changed`;
  }
  return reply.reason ?? reply.kind;
}
