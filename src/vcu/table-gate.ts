import {
  KNOWN_TABLE_TYPES,
  TABLE_TYPE_INDICES,
  activeParameterTable,
  checkTableType,
  contentTwinsOf,
  describeTableType,
  parameterAtIndex,
  parameterTableFor,
  type VcuParameterTable,
} from "./param-table.ts";
import type { TableTypeReport } from "./snapshot.ts";

// Does this Pi know what this bike's parameter indices are CALLED — and may a parameter
// write go ahead on the strength of it? Pure: a table-type report in, a verdict out, so
// every branch is exercisable from a laptop (scripts/check-vcu-params.ts §14b) rather than
// first discovered against a motorcycle's calibration EEPROM.
//
// ⚠️ A parameter is addressed BY INDEX, and what an index means comes from the table.
// Routing and record width are invariant across all 28 of Energica's tables, so a write
// aimed at a name under the WRONG table still goes to the right micro with the right number
// of bytes: the micro accepts it, the read-back agrees, the audit journal records a success
// — and a different parameter has changed. 151 of 278 ids are named differently somewhere.
//
// ⚠️ READS ARE DELIBERATELY NOT GATED, AND MUST NOT BE. A read under the wrong table prints
// a name next to a number and nothing on the bike moves — and a read is the only way OUT of
// here, so a gate that blocked it would be a gate nobody could ever open.
//
// The five refusal states, and why each gets its own sentence: docs/vcu-parameters.md §4.

/** What a table-type report means for writing by index. Fail-closed: only one of these permits. */
export type TableGateState =
  /** Every `TABLE_TYPE` index named the same table, this software carries it, and the allowlist resolves in it. */
  | "confirmed"
  /** ⚠️ A micro named a table this software does not carry. No read fixes this; an extraction does. */
  | "mismatched"
  /** ⚠️ The two micros named different tables. A finding about the bike, not something to average. */
  | "split"
  /** ⚠️ The table is carried, but an allowlisted parameter is not that index's name in it. */
  | "unwritable"
  /** ⚠️ A micro answered with a record whose width contradicts the table, so it named nothing. */
  | "unusable"
  /** Nothing has confirmed one or both micros. One read each clears it. */
  | "unread";

export interface TableGateVerdict {
  state: TableGateState;
  /** ⚠️ True for `confirmed` and nothing else. Every other state refuses. */
  writesAllowed: boolean;
  /**
   * ⚠️ True when reading the bike again cannot change this verdict.
   *
   * The dashboard branches on THIS rather than on the state string, so a state added
   * here cannot quietly start rendering as "nobody has asked yet" with an amber badge and
   * an instruction that leads nowhere. `mismatched`, `split` and `unwritable` all need a
   * change to this Pi's source or data; `unusable` and `unread` are answered by asking
   * again.
   */
  noReadWillHelp: boolean;
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
  /**
   * The `TABLE_TYPE` indices with no usable reading naming a carried table.
   *
   * ⚠️ Empty is NOT the same as permitted. `split` and `unwritable` both have both
   * micros answered and both refuse: what is missing there is agreement, not a reading.
   * `writesAllowed` is the only field that says whether a write may proceed.
   */
  outstanding: number[];
  /**
   * The table the bike named, when EVERY usable reading agreed on one this software
   * carries. Null otherwise — including when one micro named a carried table and the
   * other named something we do not have, which is a bike we cannot name in one piece.
   *
   * The same value ../vcu/snapshot.ts's `TableTypeReport.tableType` holds for the same
   * snapshot, on purpose.
   */
  tableType: number | null;
}

/**
 * Judges a table-type report for the purposes of writing.
 *
 * `null` means no snapshot on this Pi holds a usable table-type reading at all — no
 * sweep has run, or the file that would carry it could not be read. Both come out as
 * `unread` naming both micros, which is exactly what is true in either case.
 *
 * ⚠️ THE VERDICT IS RE-DERIVED, NEVER TRUSTED. `report.confirmed`, `report.tableType` and
 * each verdict's `recognised` are computed somewhere else, and a boolean survives a JSON
 * boundary, a hand-written object literal and a cast while the reasoning behind it does
 * not. So the only thing read out of the report to make the ALLOW/REFUSE decision is each
 * verdict's raw `value` — the word the bike actually sent — and checkTableType() is run
 * over it again here. That is the same treatment ./write-codec.ts gives a write plan, for
 * the same reason: this function is called from the codec, one layer before the bytes.
 */
export function evaluateTableGate(report: TableTypeReport | null): TableGateVerdict {
  const named = new Map<number, number>();
  const answeredWrongly = new Map<number, number>();
  for (const verdict of report?.verdicts ?? []) {
    // checkTableType returns null for any index that is not 276 or 277, so a report
    // carrying a verdict for some other parameter cannot vote here at all.
    const rechecked = checkTableType(verdict.index, verdict.value);
    if (rechecked?.recognised === true) {
      named.set(verdict.index, verdict.value);
    } else if (rechecked) {
      answeredWrongly.set(verdict.index, verdict.value);
    }
  }
  const outstanding = TABLE_TYPE_INDICES.filter(index => !named.has(index));
  const values = [...named.values()];
  // ⚠️ A micro that answered with a table we do not carry VETOES the answer rather than
  // being ignored while the other micro speaks for the whole VCU — the same rule
  // ../vcu/snapshot.ts's agreedTableType() applies, deliberately, so that the two
  // functions reading the same evidence cannot reach different conclusions about which
  // table this bike is on. It changes nothing about what is permitted (a wrongly
  // answered index is already in `outstanding`, which shuts the `confirmed` branch); it
  // stops `tableType` reporting one micro's table on a bike where the other disagreed.
  const agreed =
    answeredWrongly.size === 0 && values.length > 0 && values.every(value => sameTable(value, values[0]))
      ? values[0]
      : null;

  if (outstanding.length === 0 && agreed !== null) {
    const table = parameterTableFor(agreed);
    // Cannot be null — `agreed` came from checkTableType()'s own recognition — but the
    // gate is the wrong place to assume that, so it is checked and it refuses.
    const problems = table ? allowlistProblemsIn(table) : ["the table could not be rebuilt at all"];
    if (problems.length === 0) {
      return {
        state: "confirmed",
        writesAllowed: true,
        noReadWillHelp: false,
        reason: `Both micros name ${describeTableType(agreed)}, which is a table this software carries.`,
        remedy: "",
        outstanding: [],
        tableType: agreed,
      };
    }
    return {
      state: "unwritable",
      writesAllowed: false,
      noReadWillHelp: true,
      reason:
        `Both micros name ${describeTableType(agreed)}, which this software carries — but ${problems.length} of ` +
        `the parameters on the write allowlist do not mean there what they mean here: ${problems.join("; ")}.`,
      remedy:
        "⚠️ No read clears this and the bike is not at fault. src/vcu/write-targets.ts pairs each writable " +
        "parameter with an INDEX, and on this bike's table that index is a different parameter. Writing anyway " +
        "would send the value to the right micro with the right width and change the wrong calibration cell. The " +
        "allowlist needs an entry that is correct for this table before any of it can be offered here.",
      // Empty: both micros answered and both named this table. Nothing is outstanding —
      // what is wrong is the allowlist, and listing the two indices here would send
      // someone off to read a parameter that has already answered twice.
      outstanding: [],
      tableType: agreed,
    };
  }

  // ⚠️ `report.unusable` is consulted for WORDING only, never to permit anything —
  // every index reaching this point has already failed the re-derivation above. A
  // report that lied about which indices were unusable would change which blocking
  // sentence someone reads and nothing else.
  const mismatched = outstanding.filter(index => answeredWrongly.has(index));
  const unusable = outstanding.filter(index => !answeredWrongly.has(index) && (report?.unusable ?? []).includes(index));
  const unread = outstanding.filter(index => !answeredWrongly.has(index) && !unusable.includes(index));
  const split = agreed === null && values.length > 1;

  // Worst first, in the same order ./snapshot.ts ranks its own lines: micros that named
  // different tables, then one that named a table we do not carry, then one whose reply
  // was malformed, then one nobody asked. The state is the worst of them, because that is
  // the one whose remedy is hardest.
  const state: TableGateState = split
    ? "split"
    : mismatched.length > 0
      ? "mismatched"
      : unusable.length > 0
        ? "unusable"
        : "unread";
  const reasons = [
    ...(split ? [describeSplit(named)] : []),
    ...mismatched.map(index => describeMismatch(index, answeredWrongly.get(index) ?? 0)),
    ...unusable.map(describeUnusable),
    ...unread.map(describeUnread),
  ];
  const remedies = [
    // ONE sentence however many micros disagree. The reasons above are per-micro because
    // they carry different findings (which table each named); the remedy is the same
    // paragraph either way, and printing it twice is how a warning gets skimmed past.
    ...(split ? [SPLIT_REMEDY] : []),
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
    noReadWillHelp: split || mismatched.length > 0,
    reason: reasons.join(" "),
    remedy: remedies.join(" "),
    outstanding,
    tableType: agreed,
  };
}

/**
 * Registers the check that the write allowlist means the same thing on the bike's table
 * as it does on the one this Pi is naming parameters from.
 *
 * ⚠️ A function reference rather than an import because ./write-targets.ts already
 * imports ./write-codec.ts, which imports this module — the same cycle ./write-codec.ts's
 * `registerWritePlanVerifier` solves, solved the same way. Left as a REFUSING stub rather
 * than a permissive one: a build where write-targets.ts was never loaded must block every
 * write, not wave every write through.
 */
export function registerAllowlistTableCheck(check: (table: VcuParameterTable) => string[]): void {
  allowlistProblemsIn = check;
}

let allowlistProblemsIn: (table: VcuParameterTable) => string[] = () => [
  "src/vcu/write-targets.ts has not registered its allowlist with this gate, so nothing here can say whether the " +
    "parameters it would write are the ones this bike's table gives those indices",
];

/** True when two `TABLE_TYPE` words describe byte-identical tables — 4119 and 16407, for instance. */
function sameTable(left: number, right: number): boolean {
  return left === right || contentTwinsOf(left).includes(right);
}

/**
 * One line for a micro that named a table this software does not carry.
 *
 * Delegates the sentence to checkTableType(), which already writes it — including the
 * part about `RegenFade` and what a wrong name costs. A second phrasing of the same
 * finding here would be a second thing to keep true.
 */
function describeMismatch(index: number, value: number): string {
  return checkTableType(index, value)?.message ?? `${identify(index)} named ${describeTableType(value)}.`;
}

function describeMismatchRemedy(indices: number[]): string {
  const who = indices.map(identify).join(" and ");
  return (
    `⚠️ No read clears ${who} — the bike answered, and the answer is the problem. Writing by index means ` +
    "trusting this software's name for that index, and on the table it named the name may belong to a different " +
    "parameter entirely. ✅ This is fixable by you and does not need a code change: run " +
    "`node --experimental-strip-types scripts/extract-vcu-tables.ts <the exe>` against your own Energica " +
    "service-tool install — its main executable, the dealer application itself — commit the diff to " +
    "src/vcu/table-catalog.data.ts and this gate opens. README.md, " +
    `"Adding your bike's VCU parameter table", is the walkthrough. Carried today: ${KNOWN_TABLE_TYPES.join(", ")}.`
  );
}

function describeSplit(named: Map<number, number>): string {
  const who = [...named.entries()].map(([index, value]) => `${identify(index)} says ${describeTableType(value)}`);
  return (
    `*** The two micros name DIFFERENT parameter tables: ${who.join(", and ")}. *** Both are carried, so this is ` +
    "not a gap in this software — it is a claim about the bike. They hold separate EEPROMs and are asked " +
    "separately, so they can genuinely have been flashed with different tables."
  );
}

const SPLIT_REMEDY =
  "⚠️ No read clears this either, and picking one micro's answer is exactly the wrong move: half the ids would " +
  "then be named out of a table that does not describe them. Nothing here holds one table per micro today, and " +
  "adding that is a deliberate change to src/vcu/param-table.ts rather than something to bodge at the write " +
  "button. Reading is unaffected, and both tables are carried, so the parameter page can be read under either. " +
  "Please open an issue quoting both numbers — a genuinely split VCU is worth knowing about, and how far apart " +
  "the two tables actually are decides how much work supporting it is.";

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
    `names are ${describeTableType(activeParameterTable().tableType)}'s, which is what is being shown. The two ` +
    "micros hold separate EEPROMs and are asked separately; one answering is not confirmation of the other."
  );
}

/**
 * The read that clears a micro, spelled out to the frame — and, just as importantly, to
 * the thing that RECORDS it. Which micro, which index, what the request is on the wire,
 * that it changes nothing and needs no SecurityAccess, and where to do it so the answer
 * survives. A refusal that stopped at "the table type is not confirmed" would be a refusal
 * nobody could act on, and the honest end of that road is the gate being switched off.
 *
 * ⚠️⚠️ SEEING THE ANSWER AND RECORDING IT ARE DIFFERENT ACTS. The gate is fed from the last
 * SWEEP's snapshot; a one-identifier probe performs precisely this read and returns it in
 * an HTTP response that nothing persists. An earlier wording conflated the two and sent
 * someone back to a button still amber with the identical message. The full account, and
 * why this no longer says what the answer SHOULD be: docs/vcu-parameters.md §4.
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
    "read-only, no SecurityAccess, one frame. Any of the tables this software carries is a good answer " +
    `(${KNOWN_TABLE_TYPES.join(", ")}); anything else is answered by the remedy above. ` +
    "⚠️ It has to be RECORDED, not merely seen: this gate reads the last parameter sweep's snapshot, so run " +
    `Service mode → read the parameters and let it finish. ${sweepOrderCaveatFor(index)} ` +
    `The /vcu-probe endpoint shows the same answer in one frame — ` +
    `curl -X POST -H 'X-Cool-Eva: service-mode' '<pi>/vcu-probe?target=${micro}&bank=1&index=${index}' — ` +
    "but it stores nothing, so it cannot open this gate."
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
