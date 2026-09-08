import { describeNegativeResponseCode } from "../diagnostics/obd-dtc.ts";
import { evaluateTableGate } from "./table-gate.ts";
import type { TableTypeReport } from "./snapshot.ts";
import type { ParameterWritePlan } from "./write-targets.ts";

// Pure codec for the three services that CHANGE something in a VCU micro:
// SecurityAccess, WriteDataByCommonIdentifier and StartRoutineByLocalIdentifier.
// Requests in, bytes out; bytes in, outcomes out. No socket, no clock, no state —
// ./write-session.ts is the only part that touches a bus. ./param-codec.ts's read-only
// guarantee is deliberately untouched by this file existing: its union still has three
// members and there is still nowhere in it to put a value.
//
// Four things a caller cannot do. Each is enforced by the closed union AND re-checked on
// the way out, and each is argued in full in docs/vcu-parameters.md §6:
//
//  • ⚠️ Name an IDENTIFIER. `write-parameter` takes a plan; only ./write-targets.ts's
//    allowlist makes one, and `assertPlanIsAllowed` re-derives it here, last thing
//    before the bus.
//  • ⚠️ Name a ROUTINE ID. `start-routine` takes a NAME, so `0xFB` — one digit from the
//    service point, and the routine that WIPES BATTERY STATISTICS — is unreachable
//    because nothing in this repo gives it a name. Do not give it one.
//  • ⚠️ Write before the BIKE has named its parameter table. An index only MEANS a
//    parameter relative to a table; see `assertTableTypeConfirmed`.
//  • ⚠️ Emit a service outside WRITE_SERVICES. 0x11 ECUReset, 0x2F InputOutputControl —
//    the factory tool's actuator-test channel, which drives the pump, fan, horn and
//    lights directly — 0x3B, 0x3D and 0x34/0x36/0x37 are absent and must stay absent.
//
// ✅ Proven on-bike 2026-08-27/28: this file's `2E` write legs have driven the A8 light-threshold
// parameters (through write-session.ts), read back and logged. The five RESEARCHED parameters in
// docs/vcu-parameters.md §5 (charge/torque/regen/VSM) stay unwritten — the lights are generated targets.

/** Everything this codebase is permitted to ask a VCU micro to DO. Closed on purpose — see the header. */
export type VcuWriteRequest =
  /** `27 01` SecurityAccess, requestSeed. Level 1 is the only level anything here knows. */
  | { kind: "security-seed" }
  /** `27 02` SecurityAccess, sendKey. The key is derived from the seed, never supplied by a caller. */
  | { kind: "security-key"; key: number }
  /**
   * `2E [hi] [lo] [value…]` WriteDataByCommonIdentifier.
   *
   * ⚠️ Takes a PLAN, not an identifier and a value. A plan can only come out of
   * ./write-targets.ts, which is where the allowlist and the ranges live — so
   * "which parameter" and "what value" are decided by a pure, checked function
   * before this file ever sees them, and re-checked here on the way out.
   *
   * ⚠️ And it takes the EVIDENCE that the bike runs the table those names come from,
   * rather than a caller's assurance that it does. `tableType` is the report a sweep
   * produced (./snapshot.ts's `reportTableType`), or null when no sweep on this Pi has
   * produced one; either way the verdict is re-derived here. See
   * `assertTableTypeConfirmed`.
   */
  | { kind: "write-parameter"; plan: ParameterWritePlan; tableType: TableTypeReport | null }
  /**
   * `31 [id]` StartRoutineByLocalIdentifier, no parameters.
   *
   * ⚠️⚠️ The routine is named, never numbered. `0xFB` — one digit from the service
   * point, and the routine that WIPES BATTERY STATISTICS — has no name here and so
   * cannot be expressed. Do not add one.
   */
  | { kind: "start-routine"; routine: ServiceRoutineName };

/**
 * The routines this repo will start, by name.
 *
 * One member today. SERVICE_RESET.md §3 lists two siblings on consecutive ids —
 * `0xFB` Reset Battery Statistics (A8) and `0xFA` Learn Key (A9) — and NEITHER is
 * here, which is the entire mechanism protecting against a fat-fingered `31 FB`:
 * there is no number to mistype, because there is no number.
 */
export type ServiceRoutineName = "set-service-point";

const SERVICE_SECURITY_ACCESS = 0x27;
const SERVICE_WRITE_BY_COMMON_IDENTIFIER = 0x2e;
const SERVICE_START_ROUTINE_BY_LOCAL_IDENTIFIER = 0x31;

const SECURITY_ACCESS_REQUEST_SEED = 0x01;
const SECURITY_ACCESS_SEND_KEY = 0x02;

/**
 * Routine local identifiers, by name. The ONLY table in this repo that maps a name
 * to a routine byte, and it has one row.
 *
 * `0xFC` is Set Service Point on A8: it takes no parameters and the firmware stamps
 * the CURRENT RTC time and odometer into the last-service block itself
 * (SERVICE_RESET.md §2/§3). That is why it is irreversible and why the clock has to
 * be right before it runs.
 */
const ROUTINE_IDS: Record<ServiceRoutineName, number> = { "set-service-point": 0xfc };

/**
 * Which micro owns each routine.
 *
 * On the wire this is only an address byte, but getting it wrong is not harmless:
 * SERVICE_RESET.md §7 records that `0xFC` also equals `RoutinesID.VCUCheckSum` in
 * the FLASHING enum, which is a different ECU and session. "Don't send `31 FC` to
 * A9 expecting a service reset" is a direct quote, so the micro is pinned here
 * rather than left to a caller.
 */
export const ROUTINE_MICROS: Record<ServiceRoutineName, "A8" | "A9"> = { "set-service-point": "A8" };

/**
 * Belt and braces behind the closed union, exactly as param-codec.ts keeps for
 * reads: every service byte this module may emit, checked on the way out.
 *
 * ⚠️ Never add to this set: 0x11 ECUReset, 0x2F InputOutputControl (the factory
 * tool's actuator-test channel — it drives the pump, fan, horn and lights live),
 * 0x3B WriteDataByLocalIdentifier, 0x3D WriteMemoryByAddress, 0x34 RequestDownload,
 * 0x14 ClearDiagnosticInformation. Each is a different kind of irreversible.
 */
const WRITE_SERVICES: ReadonlySet<number> = new Set([
  SERVICE_SECURITY_ACCESS,
  SERVICE_WRITE_BY_COMMON_IDENTIFIER,
  SERVICE_START_ROUTINE_BY_LOCAL_IDENTIFIER,
]);

/**
 * The constant in the VCU seed→key algorithm, `0xC1A0BABE`.
 *
 * DIAG_ADDRESSES.md §8 records the same algorithm as `− 0x3E5F4542`; the two sum to
 * 2^32, so subtracting one is adding the other mod 2^32 and there is no conflict to
 * resolve. `BABE` is an Energica easter egg, not a coincidence.
 */
const SECURITY_KEY_OFFSET = 0xc1a0babe;

const NEGATIVE_RESPONSE_SERVICE = 0x7f;
const POSITIVE_RESPONSE_OFFSET = 0x40;

/** Largest single-frame payload under extended addressing: 8 bytes − 1 address − 1 PCI. */
const MAX_SINGLE_FRAME_PAYLOAD = 6;

/**
 * Turns a seed into its key: swap each adjacent bit pair of the 32-bit seed, then add
 * `0xC1A0BABE` mod 2^32. Both seed and key travel big-endian. ✅ Four real captured
 * seed/key pairs satisfy it; provenance in docs/vcu-parameters.md §6.
 *
 * ⚠️ `>>> 0` rather than `>> 0` throughout, and the addition done in double precision
 * before the modulo, because JavaScript's bitwise operators work on SIGNED 32-bit
 * integers: a seed with bit 30 set makes `(seed & 0x55555555) << 1` come out negative,
 * and `+` would then be subtracting. That is a wrong key, and a wrong key costs one of
 * the ~3 attempts before the micro locks out until a power cycle.
 *
 * ⚠️ THIS IS THE VCU FAMILY'S ALGORITHM AND ONLY THE VCU FAMILY'S — A8 and A9. The
 * dashboard and the charge manager each use a different one, so pointing this function at
 * either produces a wrong key and spends an attempt on an ECU nobody here has unlocked.
 */
export function securityKeyForSeed(seed: number): number {
  const value = seed >>> 0;
  const swapped = (((value & 0xaaaaaaaa) >>> 1) | ((value & 0x55555555) << 1)) >>> 0;
  return (swapped + SECURITY_KEY_OFFSET) % 2 ** 32;
}

/**
 * Builds the 8-byte CAN frame for one write-class request. Zero-padded, like every
 * other frame on this bus.
 *
 * Throws rather than returning an error value, exactly as param-codec.ts's builder
 * does: by the time anything reaches here the allowlist has already turned a
 * person's input into a plan, so a bad argument is a bug in this repo. The two
 * assertions at the top are the ones that must never be removed.
 */
export function buildWriteFrame(target: "A8" | "A9", request: VcuWriteRequest): Uint8Array {
  const payload = encodeWritePayload(request);
  if (!WRITE_SERVICES.has(payload[0])) {
    // Unreachable through the union above, which is exactly why it is here.
    throw new Error(`vcu-write: refusing to transmit service 0x${payload[0].toString(16)} — not a write-class service`);
  }
  if (payload.length > MAX_SINGLE_FRAME_PAYLOAD) {
    // A WORD write is 5 bytes and a key send is 5, so nothing on the allowlist can
    // reach this. It stays because the next parameter someone adds might be wider,
    // and a silently truncated write to a calibration EEPROM is the worst outcome
    // this file has: it would look like a success and leave a different number in
    // the cell. Nothing here assembles a multi-frame request, on purpose.
    throw new Error(`vcu-write: payload of ${payload.length} bytes does not fit one frame — multi-frame is not built`);
  }
  const frame = new Uint8Array(8);
  frame[0] = target === "A8" ? 0xa8 : 0xa9;
  frame[1] = payload.length;
  frame.set(payload, 2);
  return frame;
}

function encodeWritePayload(request: VcuWriteRequest): Uint8Array {
  switch (request.kind) {
    case "security-seed":
      return Uint8Array.from([SERVICE_SECURITY_ACCESS, SECURITY_ACCESS_REQUEST_SEED]);
    case "security-key": {
      const key = request.key >>> 0;
      return Uint8Array.from([
        SERVICE_SECURITY_ACCESS,
        SECURITY_ACCESS_SEND_KEY,
        (key >>> 24) & 0xff,
        (key >>> 16) & 0xff,
        (key >>> 8) & 0xff,
        key & 0xff,
      ]);
    }
    case "write-parameter": {
      const plan = request.plan;
      // Re-checked HERE, against the allowlist, rather than trusted because the type
      // says `ParameterWritePlan`. TypeScript's guarantee ends at the process
      // boundary and this is the last code before the bus: a plan assembled by hand,
      // deserialised from JSON, or built by a future caller that skipped
      // ./write-targets.ts is refused at the point where it would otherwise become
      // eight bytes on a motorcycle's calibration EEPROM.
      assertPlanIsAllowed(plan);
      // And the table the plan's NAME is a claim about, on the same terms. The
      // allowlist check above proves the bytes are the ones write-targets.ts would
      // have produced for this name; it cannot prove the name belongs to this index on
      // this bike, because that is what the parameter table says and the table is an
      // assumption until the bike confirms it.
      assertTableTypeConfirmed(request.plan, request.tableType);
      return Uint8Array.from([
        SERVICE_WRITE_BY_COMMON_IDENTIFIER,
        plan.identifier >> 8,
        plan.identifier & 0xff,
        ...plan.record,
      ]);
    }
    case "start-routine": {
      const id = ROUTINE_IDS[request.routine];
      if (id === undefined) {
        // ⚠️ The most important throw in this file. Without it a routine name the
        // table does not carry produces `Uint8Array.from([0x31, undefined])`, which
        // JavaScript quietly turns into `31 00` — a request to start routine ZERO on
        // a VCU, silently, instead of an error. The union makes an unnamed routine
        // unexpressible in TypeScript; this makes it unreachable at runtime too,
        // which is the half that survives a cast and a JSON boundary.
        throw new Error(`vcu-write: no routine is named ${JSON.stringify(request.routine)} — refusing to invent an id`);
      }
      return Uint8Array.from([SERVICE_START_ROUTINE_BY_LOCAL_IDENTIFIER, id]);
    }
    default:
      // Unreachable while the union stays closed, and TypeScript proves it at compile
      // time. It exists for the version of this file where someone widens the union
      // and forgets a branch — falling through would return `undefined` and crash
      // three frames away instead of saying what actually went wrong.
      throw new Error(`vcu-write: unknown request kind ${JSON.stringify(request)}`);
  }
}

/** How a SecurityAccess exchange came out. */
export type SecurityAccessReply =
  /** `67 01 <4-byte seed>` — the micro's challenge. */
  | { kind: "seed"; seed: number }
  /**
   * `67 02 …` — the key was accepted. The capture shows a trailing `0x34` byte after
   * the sub-function; it is echoed back here rather than asserted, because one
   * capture is not enough to call a byte mandatory.
   */
  | { kind: "unlocked"; trailing: number | null }
  /** The micro said no, by name. `0x35` invalidKey is the one that counts toward the lockout. */
  | { kind: "refused"; negativeResponseCode: number; description: string }
  | { kind: "unrecognised"; reason: string };

/** Decodes one reply to `27 01` or `27 02`. Pure. */
export function decodeSecurityAccessReply(payload: Uint8Array): SecurityAccessReply {
  if (payload.length === 0) {
    return { kind: "unrecognised", reason: "empty payload" };
  }
  if (payload[0] === NEGATIVE_RESPONSE_SERVICE) {
    if (payload.length < 3) {
      return { kind: "unrecognised", reason: "negative response without a service and a code" };
    }
    return {
      kind: "refused",
      negativeResponseCode: payload[2],
      description: describeNegativeResponseCode(payload[2]),
    };
  }
  if (payload[0] !== SERVICE_SECURITY_ACCESS + POSITIVE_RESPONSE_OFFSET) {
    return { kind: "unrecognised", reason: `reply names service 0x${payload[0].toString(16)}, not 0x67` };
  }
  if (payload.length < 2) {
    return { kind: "unrecognised", reason: "positive reply without a sub-function" };
  }
  if (payload[1] === SECURITY_ACCESS_REQUEST_SEED) {
    if (payload.length < 6) {
      return { kind: "unrecognised", reason: `seed reply carries ${payload.length - 2} byte(s), not 4` };
    }
    // Big-endian, per the four captured pairs. `>>> 0` because a seed with the top
    // bit set is negative under `<<` — the same trap securityKeyForSeed guards.
    return { kind: "seed", seed: ((payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5]) >>> 0 };
  }
  if (payload[1] === SECURITY_ACCESS_SEND_KEY) {
    return { kind: "unlocked", trailing: payload.length > 2 ? payload[2] : null };
  }
  return { kind: "unrecognised", reason: `reply names sub-function 0x${payload[1].toString(16)}, not 01 or 02` };
}

/** How a `2E` write came out, as far as the reply alone can say. */
export type ParameterWriteReply =
  /**
   * `6E <hi> <lo>` — accepted, with the identifier echoed.
   *
   * ⚠️ "Accepted" is the whole of what this means. The positive reply NEVER carries
   * the written value (DIAG_ADDRESSES.md §9.2), so it is not evidence that the cell
   * now holds what was sent. That is what the read-back in ./write-session.ts is
   * for, and why there is no path here that reports success without one.
   */
  | { kind: "accepted"; identifier: number }
  /** A well-formed acceptance of a DIFFERENT identifier — kept apart, for the reason the read codec keeps it apart. */
  | { kind: "identifier-mismatch"; expected: number; received: number }
  /** The micro said no, by name. `0x33` securityAccessDenied means the unlock went stale. */
  | { kind: "refused"; negativeResponseCode: number; description: string }
  | { kind: "unrecognised"; reason: string };

/** Decodes one reply to `2E`, against the identifier that was written. Pure. */
export function decodeParameterWriteReply(payload: Uint8Array, expectedIdentifier: number): ParameterWriteReply {
  if (payload.length === 0) {
    return { kind: "unrecognised", reason: "empty payload" };
  }
  if (payload[0] === NEGATIVE_RESPONSE_SERVICE) {
    if (payload.length < 3) {
      return { kind: "unrecognised", reason: "negative response without a service and a code" };
    }
    return {
      kind: "refused",
      negativeResponseCode: payload[2],
      description: describeNegativeResponseCode(payload[2]),
    };
  }
  if (payload[0] !== SERVICE_WRITE_BY_COMMON_IDENTIFIER + POSITIVE_RESPONSE_OFFSET) {
    return { kind: "unrecognised", reason: `reply names service 0x${payload[0].toString(16)}, not 0x6E` };
  }
  if (payload.length < 3) {
    return { kind: "unrecognised", reason: "positive reply without a full identifier echo" };
  }
  const received = (payload[1] << 8) | payload[2];
  if (received !== expectedIdentifier) {
    return { kind: "identifier-mismatch", expected: expectedIdentifier, received };
  }
  return { kind: "accepted", identifier: received };
}

/** How a `31` routine came out. */
export type RoutineReply =
  /** `71 <id>` — started, with the routine id echoed. */
  | { kind: "started"; routine: number }
  /** A `71` echoing a routine we did not start. Loud rather than counted as success. */
  | { kind: "routine-mismatch"; expected: number; received: number }
  | { kind: "refused"; negativeResponseCode: number; description: string }
  | { kind: "unrecognised"; reason: string };

/**
 * Decodes one reply to `31`, against the routine that was started. Pure.
 *
 * ⚠️ The expected shape is INFERRED. SERVICE_RESET.md §3 says so in as many words —
 * the service tool only checks its own `Completed_ACK`, and the positive-response bytes were
 * never logged. So an unexpected shape is reported as `unrecognised` and the caller
 * must treat that as "we do not know whether it ran", never as success. The service
 * point is irreversible; guessing in the optimistic direction is the one thing that
 * cannot be undone afterwards.
 */
export function decodeRoutineReply(payload: Uint8Array, routine: ServiceRoutineName): RoutineReply {
  const expected = ROUTINE_IDS[routine];
  if (payload.length === 0) {
    return { kind: "unrecognised", reason: "empty payload" };
  }
  if (payload[0] === NEGATIVE_RESPONSE_SERVICE) {
    if (payload.length < 3) {
      return { kind: "unrecognised", reason: "negative response without a service and a code" };
    }
    return {
      kind: "refused",
      negativeResponseCode: payload[2],
      description: describeNegativeResponseCode(payload[2]),
    };
  }
  if (payload[0] !== SERVICE_START_ROUTINE_BY_LOCAL_IDENTIFIER + POSITIVE_RESPONSE_OFFSET) {
    return { kind: "unrecognised", reason: `reply names service 0x${payload[0].toString(16)}, not 0x71` };
  }
  if (payload.length < 2) {
    return { kind: "unrecognised", reason: "positive reply without the routine id echoed back" };
  }
  if (payload[1] !== expected) {
    return { kind: "routine-mismatch", expected, received: payload[1] };
  }
  return { kind: "started", routine: payload[1] };
}

/** The routine byte a name maps to. Exported for the checks and for the audit record, never to choose one. */
export function routineIdFor(routine: ServiceRoutineName): number {
  return ROUTINE_IDS[routine];
}

/**
 * The last gate before a plan becomes bytes.
 *
 * Imported lazily-shaped (a function call rather than a module-level constant) only
 * so this file and ./write-targets.ts can refer to each other's types without a
 * cycle at value level. What it does is the point: it re-derives the plan from the
 * allowlist and refuses one that does not match, so the ONLY writes this codec can
 * emit are the ones write-targets.ts would have produced itself.
 */
function assertPlanIsAllowed(plan: ParameterWritePlan): void {
  if (!isAllowedPlan(plan)) {
    throw new Error(
      `vcu-write: refusing to encode a write to identifier 0x${plan.identifier.toString(16)} — ` +
        "it is not on the allowlist in src/vcu/write-targets.ts, or its bytes do not match what that module would produce"
    );
  }
}

/**
 * The other last gate: has this bike said which parameter table it runs?
 *
 * ⚠️ `2E 11 02 50` is a well-formed write of 80 to CommonIdentifier 0x1102 whatever table
 * the VCU runs — the micro takes it, echoes `6E 11 02`, and a read-back returns 80. What
 * changes with the table is which PARAMETER 0x1102 IS, and routing and record width are
 * invariant across all 28 of Energica's tables: no malformed frame, no NRC and no
 * read-back in that sequence can notice. The write succeeds and is wrong.
 *
 * Enforced HERE and not only where the UI can see it: `curl` can reach /vcu-write, and a
 * `TableTypeReport` is a plain object that could be forged — so ./table-gate.ts re-derives
 * the verdict from the raw words the bike sent. It throws because ./write-runner.ts has
 * already declined with a sentence a person can act on, so reaching this line is a bug.
 * Which ids differ, and why reads are NOT gated: docs/vcu-parameters.md §4.
 */
function assertTableTypeConfirmed(plan: ParameterWritePlan, report: TableTypeReport | null): void {
  const verdict = evaluateTableGate(report);
  if (!verdict.writesAllowed) {
    throw new Error(
      `vcu-write: refusing to encode a parameter write — the VCU's parameter table is ${verdict.state}. ` +
        `${verdict.reason} ${verdict.remedy}`
    );
  }
  // ⚠️ The gate above only asks whether the CURATED five mean the same thing on this
  // bike. They are identical in all 28 carried tables, so it passes everywhere — while
  // 26 of the 28 put a different parameter at the index of at least one of the other
  // 264. This asks about the plan in hand, and it is here as well as in
  // ./write-runner.ts because the runner can be bypassed and this cannot: nothing
  // reaches the bus except through buildWriteFrame.
  const problem = planTableProblem(plan, report);
  if (problem) {
    throw new Error(`vcu-write: refusing to encode a write to ${plan.name} — ${problem}`);
  }
}

/**
 * Set once at module load by ./write-targets.ts, for the same circular-import reason as
 * `isAllowedPlan` below. ⚠️ The stub REFUSES rather than permits: a build where
 * write-targets.ts never loaded must write nothing, not everything.
 */
let planTableProblem: (plan: ParameterWritePlan, report: TableTypeReport | null) => string | null = () =>
  "write-targets.ts was never loaded, so no table check could run";

/** Called once, by ./write-targets.ts at module load. Not part of the public surface. */
export function registerWritePlanTableCheck(
  check: (plan: ParameterWritePlan, report: TableTypeReport | null) => string | null
): void {
  planTableProblem = check;
}

/**
 * Set once at module load by ./write-targets.ts.
 *
 * A function reference rather than a direct import because the two modules would
 * otherwise import each other (this one needs the plan TYPE, that one needs the
 * frame builder) — and a type-only import cannot carry a runtime check. Left as a
 * throwing stub rather than a permissive default: a build where write-targets.ts
 * was never loaded must refuse every write, not allow every write.
 */
let isAllowedPlan: (plan: ParameterWritePlan) => boolean = () => false;

/** Called once, by ./write-targets.ts at module load. Not part of the public surface. */
export function registerWritePlanVerifier(verifier: (plan: ParameterWritePlan) => boolean): void {
  isAllowedPlan = verifier;
}
