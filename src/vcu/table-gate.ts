import {
  EXPECTED_TABLE_TYPE,
  TABLE_TYPE_INDICES,
  checkTableType,
  describeTableType,
  parameterAtIndex,
} from "./param-table.ts";
import type { TableTypeReport } from "./snapshot.ts";

// Does anything on this Pi actually know which of Energica's 28 parameter tables
// this bike runs — and may a parameter write go ahead on the strength of it?
//
// Pure: a table-type report in, a verdict out. No socket, no clock, no file. Same
// split as ./service-gate.ts and for the same reason — every branch below is
// exercisable from a laptop (scripts/check-vcu-params.ts §14b) rather than first
// discovered against a motorcycle's calibration EEPROM.
//
// ── ⚠️ Why a WRITE needs this and a read does not ───────────────────────────
// A parameter is addressed BY INDEX, and what an index means comes from the table.
// Routing (id → micro) and record width (id → datatype) are invariant across all 28
// of Energica's tables, so a write aimed at a name under the wrong table still goes
// to the right micro with the right number of bytes: the micro accepts it, the
// read-back agrees, the audit journal records a success — and a different parameter
// has changed. 151 of 278 ids carry a different name in at least one other table.
// There is no NRC, no reply shape and no read-back that can report this, which makes
// it precisely the silent-wrong-answer failure this repo spends its effort on
// everywhere else.
//
// A READ under the wrong table is wrong in a way that can be survived: it prints a
// name next to a number and nothing on the bike moves. It is also the only way out of
// here, because the remedy IS a read. So reads are deliberately not gated, and must
// not be — a gate that blocked the read that opens it would be a gate nobody could
// ever open.
//
// ── Fail closed, but say WHICH closed ───────────────────────────────────────
// "The bike named a table this software does not encode" and "nobody has ever asked
// the bike" both have to block. They need different sentences, because the remedies
// do not overlap at all:
//
//   mismatched → no read will help. This software does not carry that bike's table;
//                the fix is a change to ./param-table.ts, and until then nothing here
//                should write by name at all.
//   unusable   → the micro answered with a record the width column forbids, so it
//                named no table AND the framing of the whole sweep is in question.
//                Re-reading is worth doing, but the fault is not "unasked".
//   unread     → one read clears it, and this module names exactly which one.
//
// Collapsing those into a single "writes are blocked" would send someone hunting for
// a software bug when the answer was one frame, or the other way round.
//
// ── ⚠️ Where this bike stands, 2026-08-16 ───────────────────────────────────
// `unread`, and that is the correct verdict rather than a gap. 276 `TABLE_TYPE_uC`
// was read off the A9 on 2026-06-14 and says 16407; 277 `TABLE_TYPE_uS` on the A8 has
// never been read by anyone. The two micros hold separate EEPROMs, and id 249 — the
// one id where 16406 and 16407 disagree — is an A8 parameter. So the micro whose
// answer is outstanding is the micro the disagreement lives on. The gate is therefore
// shut today, on purpose, and `remedy` below is the way through it.

/** What a table-type report means for writing by index. Fail-closed: only one of these permits. */
export type TableGateState =
  /** Every `TABLE_TYPE` index named a table this software encodes. The only state that writes. */
  | "confirmed"
  /** ⚠️ A micro named a table this software does not encode. No read fixes this. */
  | "mismatched"
  /** ⚠️ A micro answered with a record whose width contradicts the table, so it named nothing. */
  | "unusable"
  /** Nothing has confirmed one or both micros. One read each clears it. */
  | "unread";

export interface TableGateVerdict {
  state: TableGateState;
  /** ⚠️ True for `confirmed` and nothing else. Every other state refuses. */
  writesAllowed: boolean;
  /** What is the case, in the words the page shows. Never empty. */
  reason: string;
  /**
   * ⚠️ How to open the gate — the exact read, or why no read will.
   *
   * Never empty for a blocked state, and that is the point of the field existing
   * separately from `reason`: a gate that refuses without saying how to satisfy it is
   * a gate that gets worked around or switched off.
   */
  remedy: string;
  /** The `TABLE_TYPE` indices nothing has confirmed. Empty only when `confirmed`. */
  outstanding: number[];
}

/**
 * Judges a table-type report for the purposes of writing.
 *
 * `null` means no snapshot on this Pi holds a usable table-type reading at all — no
 * sweep has run, or the file that would carry it could not be read. Both come out as
 * `unread` naming both micros, which is exactly what is true in either case.
 *
 * ⚠️ THE VERDICT IS RE-DERIVED, NEVER TRUSTED. `report.confirmed` and each verdict's
 * `matches` are booleans computed somewhere else, and a boolean survives a JSON
 * boundary, a hand-written object literal and a cast while the reasoning behind it
 * does not. So the only thing read out of the report to make the ALLOW/REFUSE
 * decision is each verdict's raw `value` — the word the bike actually sent — and
 * checkTableType() is run over it again here. That is the same treatment
 * ./write-codec.ts gives a write plan, for the same reason: this function is called
 * from the codec, one layer before the bytes.
 */
export function evaluateTableGate(report: TableTypeReport | null): TableGateVerdict {
  const confirmedIndices = new Set<number>();
  const answeredWrongly = new Map<number, number>();
  for (const verdict of report?.verdicts ?? []) {
    // checkTableType returns null for any index that is not 276 or 277, so a report
    // carrying a verdict for some other parameter cannot vote here at all.
    const rechecked = checkTableType(verdict.index, verdict.value);
    if (rechecked?.matches === true) {
      confirmedIndices.add(verdict.index);
    } else if (rechecked) {
      answeredWrongly.set(verdict.index, verdict.value);
    }
  }
  const outstanding = TABLE_TYPE_INDICES.filter(index => !confirmedIndices.has(index));
  if (outstanding.length === 0) {
    return {
      state: "confirmed",
      writesAllowed: true,
      reason: `Both micros name ${describeTableType(EXPECTED_TABLE_TYPE)}, which is the table src/vcu/param-table.ts encodes.`,
      remedy: "",
      outstanding: [],
    };
  }

  // ⚠️ `report.unusable` is consulted for WORDING only, never to permit anything —
  // every index reaching this point has already failed the re-derivation above. A
  // report that lied about which indices were unusable would change which blocking
  // sentence someone reads and nothing else.
  const mismatched = outstanding.filter(index => answeredWrongly.has(index));
  const unusable = outstanding.filter(index => !answeredWrongly.has(index) && (report?.unusable ?? []).includes(index));
  const unread = outstanding.filter(index => !answeredWrongly.has(index) && !unusable.includes(index));

  // Worst first, in the same order ./snapshot.ts ranks its own lines: a micro that
  // named the wrong table, then one whose reply was malformed, then one nobody asked.
  // The state is the worst of them, because that is the one whose remedy is hardest.
  const state: TableGateState = mismatched.length > 0 ? "mismatched" : unusable.length > 0 ? "unusable" : "unread";
  const reasons = [
    ...mismatched.map(index => describeMismatch(index, answeredWrongly.get(index) ?? 0)),
    ...unusable.map(describeUnusable),
    ...unread.map(describeUnread),
  ];
  const remedies = [
    // ONE sentence however many micros disagree. The reasons above are per-micro
    // because they carry different findings (which table each named, and which of them
    // owns the disputed id 249); the remedy is the same paragraph either way, and
    // printing it twice is how a warning gets skimmed past.
    ...(mismatched.length > 0 ? [describeMismatchRemedy(mismatched)] : []),
    // A malformed reply and an unasked micro are both answered by asking again — the
    // difference is that one of them has already answered once, which is a fact about
    // the framing rather than about anyone's diligence. Same instruction, and
    // describeUnusable() above is what stops it reading as "you forgot".
    ...[...unusable, ...unread].map(readInstructionFor),
  ];
  return {
    state,
    writesAllowed: false,
    reason: reasons.join(" "),
    remedy: remedies.join(" "),
    outstanding,
  };
}

/**
 * One line for a micro that named a table this software does not encode.
 *
 * Delegates the sentence to checkTableType(), which already writes it — including the
 * part about id 249 living on the A8, which is the detail a reader looking at the A9's
 * copy would otherwise get backwards. A second phrasing of the same finding here would
 * be a second thing to keep true.
 */
function describeMismatch(index: number, value: number): string {
  return checkTableType(index, value)?.message ?? `${identify(index)} named ${describeTableType(value)}.`;
}

function describeMismatchRemedy(indices: number[]): string {
  const who = indices.map(identify).join(" and ");
  return (
    `⚠️ No read clears ${who} — the bike answered, and the answer is the problem. Writing by index means ` +
    "trusting this software's name for that index, and on the table it named the name may belong to a different " +
    "parameter entirely. The fix is to teach src/vcu/param-table.ts that table (see obd-garage/PARAM_TABLES.md, " +
    "which carries all 28 and how they were extracted), not to read anything again."
  );
}

function describeUnusable(index: number): string {
  return (
    `${identify(index)} answered with a record whose width contradicts the name table, so it named no table. ` +
    "That is not the same as unread — it replied — and a wrong-width record here puts the framing of every other " +
    "value in that sweep in question too."
  );
}

function describeUnread(index: number): string {
  const parameter = parameterAtIndex(index);
  return (
    `${identify(index)} has never been read, so nothing confirms the ${parameter?.micro ?? "micro"}'s parameter ` +
    `names are ${describeTableType(EXPECTED_TABLE_TYPE)}'s. The two micros hold separate EEPROMs and are asked ` +
    "separately; one answering is not confirmation of the other."
  );
}

/**
 * The read that clears a micro, spelled out to the frame — and, just as importantly,
 * spelled out to the thing that RECORDS it.
 *
 * ⚠️ This sentence is why the gate is worth having rather than merely being safe. All
 * of it earns its place for somebody standing next to a parked motorcycle: which
 * micro, which index, what the request is on the wire, that it changes nothing and
 * needs no SecurityAccess, what a good answer looks like, and where to do it so the
 * answer survives. A refusal that stopped at "the table type is not confirmed" would be
 * a refusal nobody could act on, and the honest end of that road is the gate being
 * switched off.
 *
 * ⚠️⚠️ SEEING THE ANSWER AND RECORDING IT ARE DIFFERENT ACTS, and an earlier version of
 * this sentence conflated them — which made it worse than saying nothing. This gate is
 * fed from the last SWEEP's snapshot (`latest.json`, written by ./snapshot-store.ts's
 * writeSnapshot, called from exactly one place: the end of a sweep). "Probe one
 * identifier" performs precisely this read and returns it in an HTTP response that
 * nothing persists — so someone who followed the old wording saw `0x4017` on screen,
 * went back, and found the button still amber with the identical message and nothing
 * to explain why. The probe is still named here, because it IS the one-frame way to
 * find out what the bike says; it is now named as what it is.
 */
function readInstructionFor(index: number): string {
  const parameter = parameterAtIndex(index);
  const micro = parameter?.micro ?? "the owning micro";
  // Straight off the name table's own identifier, so this cannot drift from what the
  // sweep or the probe would actually send: `0x1000 | index`, big-endian, service 0x22.
  const identifier = parameter?.identifier ?? 0;
  const request = `22 ${byteHex(identifier >> 8)} ${byteHex(identifier & 0xff)}`;
  return (
    `Read parameter ${index} ${parameter?.name ?? "?"} on the ${micro} — ${request} in a 10 81 session: ` +
    `read-only, no SecurityAccess, one frame, and it should answer ${describeTableType(EXPECTED_TABLE_TYPE)}. ` +
    "⚠️ It has to be RECORDED, not merely seen: this gate reads the last parameter sweep's snapshot, so run " +
    `Service mode → read the parameters and let it finish. ${sweepOrderCaveatFor(index)} ` +
    `“Probe one identifier” (target ${micro}, bank 1, index ${index}) shows the same answer in one frame and is ` +
    "the quickest way to find out what the bike says — but it stores nothing, so it cannot open this gate."
  );
}

/**
 * ⚠️ How likely a cut-short sweep is to have reached this index — which is not the same
 * answer for the two micros, and 277 has the unlucky one.
 *
 * ../vcu/sweep.ts reads A9 first and A8 second (`MICROS`), each in ascending index
 * order. The table runs 1…277, 277 is an A8 parameter, so `TABLE_TYPE_uS` is the very
 * last thing a sweep asks about — and a run the safety gate cuts short is exactly the
 * run that will not have got there. 276 sits in the A9 pass and is reached far earlier.
 * Saying "the A8 is swept last" under 276 would be true and irrelevant, so it is not
 * said there.
 */
function sweepOrderCaveatFor(index: number): string {
  return parameterAtIndex(index)?.micro === "A8"
    ? `The A8 is swept second and ${index} is at the very end of it, so a sweep the safety gate cut short is ` +
        "unlikely to have reached it — check it says it finished."
    : `A sweep reaches ${index} partway through the A9, which is the half it does first.`;
}

/** `TABLE_TYPE_uS (277, A8)`. The identity every sentence above opens with. */
function identify(index: number): string {
  const parameter = parameterAtIndex(index);
  return parameter ? `${parameter.name} (${index}, ${parameter.micro})` : `parameter ${index}`;
}

function byteHex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}
