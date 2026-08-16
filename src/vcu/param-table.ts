// The VCU's parameter NAME table — what each bank-1 calibration identifier is
// called, how wide it is, and which micro answers for it. This module is pure
// data plus a parser; nothing here touches a bus.
//
// ── Provenance ───────────────────────────────────────────────────────────────
// PARAMETER_FILE below is `VCU/params.ecf` from Energica's own tooling, copied in
// verbatim on 2026-08-09 apart from stripped trailing whitespace. It is COPIED
// rather than read from disk at runtime on purpose: the original lives in one
// owner's iCloud folder, that path exists on exactly one laptop, and this repo is
// meant to be usable by other Energica owners. Keeping it as the literal file
// text (rather than 277 hand-typed object literals) means it can still be diffed
// against the original, and a name stays greppable.
//
// ── ⚠️ WHICH TABLE THIS IS: 16407, and the embedded text is 16406 ────────────
// Energica ships 28 different parameter tables and the VCU says which one it is
// running, in parameter 276 `TABLE_TYPE_uC`. **This bike reports 16407** (`0x4017`).
// That is measured, not inferred: obd-garage/kwp_scan_raw.txt line 233 reads
//
//     A9 B1 0114 2 4017
//
// — identifier `0x0114` = index 276, a 2-byte record holding `0x4017` = 16407, off
// this bike's A9 on 2026-06-14. `TABLE_TYPE = (family << 12) | revision`, so that is
// family 4, revision `0x017`; see decodeTableType() below.
//
// **The file text at the bottom of this module is table 16406, one revision older**,
// because `params.ecf` came off a different bike (see the value warning below — that
// bike's own 276/277 read 16406, which is why the last two rows say so). Compared
// across all 277 ids — name, storage type, signedness and micro — 16406 and 16407
// differ at **exactly one id, and only in its name**:
//
//     249 (A8, WORD signed):  16406 calls it LM_TYPE · 16407 calls it R_BRAKE_POPUP
//
// So the embedded text is kept as the carrier of the `[SECTION]` headings and the
// other bike's values — neither of which Energica's own bundles contain at all,
// their `vehicleValue` being null in all 28 — and id 249 is corrected on top of it
// by TABLE_16407_CORRECTIONS below. Swapping wholesale to a 16407 bundle would buy
// one name and lose both of those.
//
// Established offline on 2026-08-16 from Energica's EMSuite 2024 build, whose 28
// parameter tables are ZIP archives stored as .NET resources named `_<TABLE_TYPE>`;
// obd-garage/PARAM_TABLES.md carries the extraction method and the full 28-table
// comparison. Independently re-derived here against the same 28 tables as exported
// by another owner's tool, which agrees id for id.
//
// ⚠️ **Still pending: the A8's own copy.** Parameter 277 `TABLE_TYPE_uS` lives on the
// A8, no A8 dump exists, and **249 is an A8 parameter** — so the one id where the two
// tables disagree sits on the micro whose table type has never been read. The two
// micros hold separate EEPROMs. On the `params.ecf` bike they agreed, which is why
// 16407 is the working assumption for both, but that is one sample from another bike.
// The read is one frame, read-only, no SecurityAccess: `22 11 15` to the A8 in a
// `10 81` session. A sweep already does it — see checkTableType(), which is what
// makes the answer arrive as a shout rather than as silence.
//
// ⚠️⚠️ THE VALUES IN IT ARE NOT THIS BIKE'S. ⚠️⚠️
// The file came off a DIFFERENT Energica — `MODEL` 8452 where this bike reads 358,
// `CELL_COUNT` 80 where this bike reads 81. Of the 233 parameters the A9 serves,
// **21 read differently on this bike**, including `MAX_DC_CHG_CURRENT` (60 in the
// file, 75 here). That is why the field is called `otherBikeValue` and not
// `value`, `defaultValue` or anything else a caller could render as a reading. The
// only honest use for it is as a comparison column explicitly labelled as another
// bike's, which is how obd-garage/DIAG_ADDRESSES.md presents it. Use this table
// for names, widths and routing; get values from the bike.
//
// ── Why the index column is an address ───────────────────────────────────────
// `CommonIdentifier = (bank << 12) | id`, and bank 1 is EEPROM Calibration
// Parameters, so parameter *n* is read with `22 [0x10|hi] [lo]`. Established in
// obd-garage/DIAG_ADDRESSES.md §4 and confirmed live on both micros 2026-08-08:
// 23 parameters read in `10 81` sessions, all 23 echoing the identifier back with
// a correctly-sized record.
//
// Re-checked in full on 2026-08-09 against the stored 2026-06-14 A9 dump
// (obd-garage/kwp_scan_raw.txt), which is what scripts/check-vcu-params.ts
// reproduces:
//   • the file assigns exactly 233 indices to the A9, and the dump holds exactly
//     233 bank-1 records — the two index SETS are identical, with no id in one
//     that is missing from the other;
//   • the TYPE column predicted the record length for all 233 (BYTE/BOOL → 1,
//     WORD → 2), zero mismatches;
//   • 212 of 233 values are byte-identical to the file and the 21 that differ all
//     differ as variant tuning, never as an off-by-one — an off-by-one index would
//     scramble the magic numbers (40000, 3600, 3300), and none of them moved.
//   • the S/U column is real: signed parameters holding negative values in the
//     file (e.g. `TH_LOW_B_L_TEMP` −25) match the bike's two's-complement bytes.
//
// ── ⚠️ Routing: trust the µC column, not a range ─────────────────────────────
// A parameter must be requested from the micro that owns it or it simply does not
// answer. DIAG_ADDRESSES.md §4 summarises the split as "223–256 and 266–277 on the
// A8, the rest on A9". The first range is right and the SECOND ONE IS NOT:
// **274 `EEPROM_VERSION_uC` and 276 `TABLE_TYPE_uC` are A9**, sitting between A8
// entries. The A8 set is 223–256, 266–273, 275 and 277 — 44 indices, which is the
// count that section's own consistency check quotes. The `_uC`/`_uS` suffixes are
// the giveaway: the control micro's copy of a pair lives on the control micro.
// Hence: never derive routing from an index range, always read `micro`.
//
// (CAN_MAP.md logs 45 records for A8 bank 1 against these 44. The 45th is
// unidentified — this variant's file may simply not name it. A sweep reads the
// whole table and nothing beyond it, so going looking would mean adding the index
// here; an identifier with no table entry reads back as raw bytes rather than
// failing, which is what makes that safe to try.)
//
// ── ⚠️ Names are NOT unique ──────────────────────────────────────────────────
// Four names appear twice — `VSM_DUMMY_WORD8`/`9`/`10`/`11` at indices 11-14 and
// again at 22-25 — and two of those pairs disagree about their own width (13 is a
// signed BYTE, 24 a WORD). So "read the parameter called X" can be an ambiguous
// question, and parametersNamed() returns an ARRAY rather than picking one. A
// caller that silently took the first match would answer a question it was never
// asked. All four are `_DUMMY_` placeholders, so this is unlikely to matter in
// practice; it is handled anyway because the failure would be silent.

/** How the parameter is stored, which is also how many bytes its record is. */
export type ParameterStorageType = "BYTE" | "WORD" | "BOOL";

/** Which VCU micro serves the parameter. A7 exists but answers no read at all. */
export type VcuMicro = "A8" | "A9";

export interface VcuParameter {
  /** 1-based row in params.ecf, and the low half of the KWP identifier. */
  index: number;
  /** `0x1000 | index` — bank 1 (EEPROM calibration) plus the index. */
  identifier: number;
  name: string;
  type: ParameterStorageType;
  /** The S/U column: true ⇒ the record is two's-complement. */
  signed: boolean;
  /** Authoritative. Requesting from the other micro gets silence. */
  micro: VcuMicro;
  /** The `[SECTION]` heading it sat under, e.g. "EVSE". Grouping only. */
  section: string;
  /**
   * The value the OTHER bike's file carries. NOT this bike's, NOT a default, and
   * never to be shown without saying whose it is — see the header. Kept because it
   * is the comparison that established the index→identifier mapping in the first
   * place, and because a live value that suddenly matches a variant it never
   * matched before is worth noticing.
   */
  otherBikeValue: number;
}

/** Bank 1 = EEPROM Calibration Parameters. Bank 0 refuses with NRC 0x12; bank 2 is live data. */
export const CALIBRATION_BANK = 1;

/** Record length in bytes, straight off the TYPE column. A reply of any other length is a mismatch worth shouting about. */
export function recordLengthFor(type: ParameterStorageType): number {
  return type === "WORD" ? 2 : 1;
}

/**
 * The whole difference between the embedded 16406 text and this bike's 16407.
 *
 * One entry, and it is a rename with nothing else attached: id 249 is a signed WORD
 * on the A8 in both tables, at the same identifier, in the same `[LIGHTS]` block.
 * Which is precisely why it was worth correcting rather than shrugging at — a write
 * aimed at "LM_TYPE" would have gone to the right micro with the right width, been
 * accepted, and read back exactly as sent. It would simply have been a different
 * parameter. Nothing in this repo has ever read or written id 249 (the allowlist in
 * ./write-targets.ts holds 16, 48, 49, 258 and 259, all identical in both tables, and
 * there is no A8 dump), so this corrects a hazard rather than a mistake.
 *
 * `wasCalled` is not decoration. If someone re-copies `params.ecf` from a bike on a
 * different table, or Energica ships a 16408, the row this correction lands on will
 * not be the row it was written for — and applyTable16407Corrections() throws at
 * module load instead of quietly renaming whatever now sits at 249.
 *
 * Above PARAMETER_TABLE rather than down with the helpers because a `const` is not
 * hoisted the way a function declaration is, and PARAMETER_TABLE is built at load.
 */
export const TABLE_16407_CORRECTIONS: { index: number; wasCalled: string; isCalled: string }[] = [
  { index: 249, wasCalled: "LM_TYPE", isCalled: "R_BRAKE_POPUP" },
];

/**
 * Every parameter the name table knows, in file order — as THIS BIKE's table 16407.
 *
 * Parsed once at module load from the embedded file text, which is table 16406, and
 * then corrected to 16407 (see the header, and TABLE_16407_CORRECTIONS). The parse is
 * kept separate from the correction on purpose: parseParameterFile() stays a plain
 * reader of `params.ecf` text, so the embedded copy can still be diffed against the
 * original file, and the one place this repo departs from that file is a named,
 * greppable, self-checking step rather than an edit hidden in 294 lines of data.
 *
 * The parser is strict and throws on anything it does not fully understand, so a bad
 * edit to the table below fails immediately and visibly rather than silently dropping
 * a row — which would turn a named parameter into an "unknown identifier" much later
 * and much quieter.
 */
export const PARAMETER_TABLE: VcuParameter[] = applyTable16407Corrections(parseParameterFile(PARAMETER_FILE_TEXT()));

const BY_INDEX = new Map(PARAMETER_TABLE.map(parameter => [parameter.index, parameter]));

const BY_NAME = groupByName(PARAMETER_TABLE);

/** The parameter at a given index, or null if the table does not describe it (an index outside 1…277). */
export function parameterAtIndex(index: number): VcuParameter | null {
  return BY_INDEX.get(index) ?? null;
}

/**
 * Every parameter with this name, case-insensitively — an ARRAY because four names
 * are not unique (see the header). Empty when the name is unknown.
 */
export function parametersNamed(name: string): VcuParameter[] {
  return BY_NAME.get(name.trim().toUpperCase()) ?? [];
}

/** Names that describe more than one index, so callers can warn about them once. */
export function ambiguousParameterNames(): string[] {
  return [...BY_NAME.entries()].filter(([, matches]) => matches.length > 1).map(([name]) => name);
}

// ── The table type: how the bike says which of the 28 tables it is running ───
// Every claim this module makes about a name is only as good as the assumption that
// the bike runs table 16407. The bike is willing to be asked — so ask it, and say so
// loudly when the answer is not the one everything here was built on. That is the
// durable half of the 2026-08-16 correction; id 249 is only today's instance of it.

/** `TABLE_TYPE` decomposed. Energica packs it as `(family << 12) | revision`. */
export interface VcuTableType {
  /** The raw 16-bit word, e.g. 16407. */
  raw: number;
  /** The high nibble. A vehicle-line tag: 1, 2, 3, 4, 5, 6 and 15 all exist. */
  family: number;
  /** The low 12 bits. Revisions `0x005`…`0x017` exist; this bike is `0x017`. */
  revision: number;
}

/**
 * The table this module's names describe: **16407**, read off this bike's A9 on
 * 2026-06-14. Everything in PARAMETER_TABLE is a claim about a bike running this.
 */
export const EXPECTED_TABLE_TYPE = 0x4017;

/**
 * The table the embedded `params.ecf` text is, before TABLE_16407_CORRECTIONS: 16406,
 * the previous revision, off another bike. Exported so a mismatch message can name
 * what the data would have been had the correction not been applied.
 */
export const EMBEDDED_TABLE_TYPE = 0x4016;

/**
 * 16407's content-identical twin. Family 4 revision `0x017` and family 1 revision
 * `0x017` are byte-for-byte the same 277 parameters, so a bike reporting either is
 * described correctly by this module. Only the vehicle-line nibble differs, and
 * nothing here reads it.
 */
const TABLE_TYPE_TWIN = 0x1017;

/** Indices 276 `TABLE_TYPE_uC` (A9) and 277 `TABLE_TYPE_uS` (A8) — the two micros' own copies. */
export const TABLE_TYPE_INDICES: readonly number[] = [276, 277];

/** Splits a raw `TABLE_TYPE` word into its family and revision halves. */
export function decodeTableType(raw: number): VcuTableType {
  return { raw, family: (raw >> 12) & 0xf, revision: raw & 0xfff };
}

/** `16407 (0x4017 — family 4, revision 0x017)`. The form every message below uses. */
export function describeTableType(raw: number): string {
  const decoded = decodeTableType(raw);
  const hex = `0x${raw.toString(16).toUpperCase().padStart(4, "0")}`;
  return `${raw} (${hex} — family ${decoded.family}, revision 0x${decoded.revision.toString(16).toUpperCase().padStart(3, "0")})`;
}

/** What a `TABLE_TYPE` reading means for the names in this module. */
export interface TableTypeVerdict {
  index: number;
  /** 276 is the A9's copy, 277 the A8's. Which one disagrees matters — see `matches`. */
  micro: VcuMicro;
  value: number;
  /** True when this module's names describe the table the bike just named. */
  matches: boolean;
  /** One line, ready to log or render. Loud when `matches` is false. */
  message: string;
}

/**
 * Judges a `TABLE_TYPE` reading against the table this module actually encodes.
 *
 * Returns null for any index that is not 276 or 277, so a caller can run it over a
 * whole snapshot without knowing which rows to pick out.
 *
 * ⚠️ A mismatch is not cosmetic. Routing (`id → micro`) and record width
 * (`id → datatype`) are invariant across all 28 of Energica's tables, so a wrong
 * table still reads and still writes the right number of bytes to the right micro —
 * it just believes the wrong NAME for them. 151 of 278 ids carry a different name in
 * at least one other table. That is exactly the failure this function exists to make
 * audible: a write aimed at a name would land on whatever id this table happens to
 * give it, succeed, and read back cleanly.
 */
export function checkTableType(index: number, value: number): TableTypeVerdict | null {
  const parameter = parameterAtIndex(index);
  if (!parameter || !TABLE_TYPE_INDICES.includes(index)) {
    return null;
  }
  const matches = value === EXPECTED_TABLE_TYPE || value === TABLE_TYPE_TWIN;
  const identity = `${parameter.name} (${index}, ${parameter.micro})`;
  if (matches) {
    return {
      index,
      micro: parameter.micro,
      value,
      matches: true,
      message: `${identity} = ${describeTableType(value)} — the table src/vcu/param-table.ts encodes`,
    };
  }
  // ⚠️ Id 249 lives on the A8, so this sentence must not tell a reader looking at 276
  // — the A9's copy — that 249 is LM_TYPE. The whole reason the two micros get
  // separate verdicts is that they can disagree, and a diagnostic meant to be pasted
  // verbatim into a bug report is the last place to get the disputed id backwards.
  const wasEmbedded =
    value === EMBEDDED_TABLE_TYPE
      ? " That is the table params.ecf came from. Its one disputed id is 249, which is LM_TYPE there and " +
        "R_BRAKE_POPUP in 16407" +
        (parameter.micro === "A8"
          ? " — and 249 lives on the A8, so it is this micro's."
          : " — but 249 lives on the A8, so read 277 before concluding anything about it.")
      : "";
  return {
    index,
    micro: parameter.micro,
    value,
    matches: false,
    message:
      `*** ${identity} = ${describeTableType(value)}, but src/vcu/param-table.ts encodes ` +
      `${describeTableType(EXPECTED_TABLE_TYPE)}. *** Every parameter NAME this software shows for the ` +
      `${parameter.micro} may be wrong — routing and record widths are the same across all of Energica's ` +
      `tables, so a wrong name still reads and still writes cleanly.${wasEmbedded} ` +
      "Do not write anything by name until this is resolved; see obd-garage/PARAM_TABLES.md.",
  };
}

function groupByName(parameters: VcuParameter[]): Map<string, VcuParameter[]> {
  const grouped = new Map<string, VcuParameter[]>();
  for (const parameter of parameters) {
    const key = parameter.name.toUpperCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.push(parameter);
    } else {
      grouped.set(key, [parameter]);
    }
  }
  return grouped;
}

/**
 * Turns the parsed 16406 file text into this bike's 16407.
 *
 * Throws rather than skipping a correction it cannot place. A silently-unapplied
 * rename is the same class of failure as the one it exists to prevent: everything
 * would keep working, and one parameter would keep the wrong name.
 */
function applyTable16407Corrections(parameters: VcuParameter[]): VcuParameter[] {
  // Checked before the map, because the map can only catch a row that EXISTS and is
  // named something unexpected. A correction whose index has no row at all would
  // simply never run — the file gets shorter or renumbered, the rename lands nowhere,
  // and PARAMETER_TABLE is plain 16406 again with nothing said. That is the same
  // silent-wrong-name failure this whole module exists to prevent.
  for (const correction of TABLE_16407_CORRECTIONS) {
    if (!parameters.some(parameter => parameter.index === correction.index)) {
      throw new Error(
        `param-table: the 16407 correction for index ${correction.index} (“${correction.wasCalled}” → ` +
          `“${correction.isCalled}”) has no row to land on — the embedded params.ecf does not describe that ` +
          "index, and skipping the correction would leave the name silently uncorrected"
      );
    }
  }
  return parameters.map(parameter => {
    const correction = TABLE_16407_CORRECTIONS.find(candidate => candidate.index === parameter.index);
    if (!correction) {
      return parameter;
    }
    if (parameter.name.toUpperCase() !== correction.wasCalled.toUpperCase()) {
      throw new Error(
        `param-table: the 16407 correction expects index ${correction.index} to be called ` +
          `“${correction.wasCalled}” in the embedded file, but it is called “${parameter.name}” — ` +
          "the embedded params.ecf is not the table this correction was derived against, so renaming " +
          "it to “" +
          correction.isCalled +
          "” would be a guess"
      );
    }
    return { ...parameter, name: correction.isCalled };
  });
}

/**
 * Parses the embedded file. Exported so scripts/check-vcu-params.ts can point it at
 * a fresh copy of params.ecf and prove the two still agree.
 *
 * ⚠️ Returns the file AS WRITTEN — table 16406 — not this bike's table. PARAMETER_TABLE
 * is this function's output with applyTable16407Corrections() on top; anything wanting
 * the names the bike actually uses wants PARAMETER_TABLE.
 *
 * Format, one parameter per line, whitespace-separated:
 *   <index> <NAME> <BYTE|WORD|BOOL> <S|U> <A8|A9> <value>
 * `[SECTION]` headings group them and carry no data. Blank lines are skipped.
 * Anything else throws, naming the line.
 */
export function parseParameterFile(text: string): VcuParameter[] {
  const parameters: VcuParameter[] = [];
  let section = "";
  let lineNumber = 0;
  for (const rawLine of text.split("\n")) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) {
        throw new Error(`param-table: line ${lineNumber} looks like a section but does not close: ${line}`);
      }
      // "[DRIVE_BY_WIRE 1/2]" appears twice and contains a space, so the heading is
      // taken whole rather than tokenised.
      section = line.slice(1, -1).trim();
      continue;
    }
    parameters.push(parseParameterLine(line, section, lineNumber));
  }
  return parameters;
}

function parseParameterLine(line: string, section: string, lineNumber: number): VcuParameter {
  const columns = line.split(/\s+/);
  if (columns.length !== 6) {
    throw new Error(`param-table: line ${lineNumber} has ${columns.length} columns, expected 6: ${line}`);
  }
  const [indexText, name, type, sign, micro, valueText] = columns;
  const index = Number(indexText);
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`param-table: line ${lineNumber} has a non-index in column 1: ${indexText}`);
  }
  if (type !== "BYTE" && type !== "WORD" && type !== "BOOL") {
    throw new Error(`param-table: line ${lineNumber} has an unknown type ${type}`);
  }
  if (sign !== "S" && sign !== "U") {
    throw new Error(`param-table: line ${lineNumber} has an unknown sign column ${sign}`);
  }
  if (micro !== "A8" && micro !== "A9") {
    throw new Error(`param-table: line ${lineNumber} names an unknown micro ${micro}`);
  }
  const otherBikeValue = Number(valueText);
  if (!Number.isFinite(otherBikeValue)) {
    throw new Error(`param-table: line ${lineNumber} has a non-numeric value ${valueText}`);
  }
  if (section.length === 0) {
    throw new Error(`param-table: line ${lineNumber} sits before any [SECTION] heading`);
  }
  return {
    index,
    identifier: (CALIBRATION_BANK << 12) | index,
    name,
    type,
    signed: sign === "S",
    micro,
    section,
    otherBikeValue,
  };
}

/**
 * `VCU/params.ecf`, verbatim. A function rather than a top-level const purely so it
 * can sit at the bottom of the file: 294 lines of data above the code would bury
 * everything, and CLAUDE.md wants the substance at the top.
 */
function PARAMETER_FILE_TEXT(): string {
  return `
[VSM]
1 VSM_DUMMY_WORD1 BYTE S A9 0
2 VSM_DUMMY_WORD2 BYTE S A9 0
3 VSM_DUMMY_WORD3 BYTE S A9 0
4 VSM_DUMMY_WORD4 WORD U A9 0
5 VSM_DUMMY_WORD5 WORD U A9 0
6 CHARGE_RESTART_HOLDOFF BYTE U A9 20
7 INLET_LOCK_DEVICE BOOL U A9 1
8 DC_DC_OVER_CURRENT WORD U A9 40000
9 VSM_DUMMY_WORD6 WORD U A9 0
10 VSM_DUMMY_WORD7 WORD U A9 0
11 VSM_DUMMY_WORD8 WORD U A9 0
12 VSM_DUMMY_WORD9 WORD U A9 0
13 VSM_DUMMY_WORD10 BYTE S A9 0
14 VSM_DUMMY_WORD11 BYTE U A9 0
15 MODEL WORD U A9 8452
16 VSM_CONFIG_1 WORD U A9 0
17 VSM_DUMMY_WORD12 WORD U A9 0
18 INNACTIVITY_TIMEOUT WORD U A9 3600
19 VARIANT_CODING WORD U A9 0
20 DRIVE_OVER_TEMP WORD U A9 82
21 MOTOR_OVER_TEMP WORD U A9 125
22 VSM_DUMMY_WORD8 WORD U A9 0
23 VSM_DUMMY_WORD9 WORD U A9 0
24 VSM_DUMMY_WORD10 WORD U A9 0
25 VSM_DUMMY_WORD11 WORD U A9 0
26 DSB_NIGHT_TH WORD U A9 0
27 DSB_DAY_TH WORD U A9 0
[FAN]
28 CHARGER_FAN_ON_TH BYTE U A9 55
29 CHARGER_FAN_FULL_TH BYTE U A9 75
30 CHARGER_OVERTEMP_TH BYTE U A9 90
31 FAN_MAX_CURR_TH WORD U A9 3300
32 FAN_MIN_CURR_TH WORD U A9 20
33 FAN_MIN_DUTY BYTE U A9 20
34 FAN_CFG WORD U A9 1
35 FAN_DUMMY_WORD2 WORD U A9 0
36 FAN_DUMMY_WORD3 WORD U A9 0
37 FAN_DUMMY_WORD4 WORD U A9 0
[DRIVE_BY_WIRE 1/2]
38 TOLERANCE WORD S A9 50
39 INTERTRACK_ERROR WORD S A9 50
40 ZERO WORD S A9 75
41 TOP WORD S A9 75
42 THROTTLE_MODE BYTE U A9 3
43 THROTTLE_INVERTED BOOL U A9 1
44 ZERO_SWITCH_TYPE BOOL U A9 0
45 THROTTLE_MIN_TH WORD S A9 700
46 THROTTLE_MAX_TH WORD S A9 3100
47 MOTOR_CURR_CALIBRATION BYTE U A9 100
48 TORQUE_LIMIT WORD S A9 2300
49 REGEN_TORQUE_LIMIT WORD S A9 500
50 DEAD_ZONE WORD U A9 30
51 MAP0_PWR WORD U A9 1250
52 MAP0_TORQUE WORD U A9 1580
53 MAP1_PWR WORD U A9 1450
54 MAP1_TORQUE WORD U A9 1950
55 MAP2_PWR WORD U A9 550
56 MAP2_TORQUE WORD U A9 1100
57 MAP3_PWR WORD U A9 1200
58 MAP3_TORQUE WORD U A9 900
59 MAP0_THROTTLE_CURVE BYTE U A9 0
60 MAP1_THROTTLE_CURVE BYTE U A9 0
61 MAP2_THROTTLE_CURVE BYTE U A9 0
62 MAP3_THROTTLE_CURVE BYTE U A9 0
63 REGEN_MAP0_TRQ BYTE U A9 10
64 REGEN_MAP1_TRQ BYTE U A9 23
65 REGEN_MAP2_TRQ BYTE U A9 35
66 REGEN_MAP3_TRQ BYTE U A9 45
67 REVERSE_TORQUE_LIMIT WORD S A9 600
68 REVERSE_TORQUE_SLEWRATE_LIMIT WORD S A9 200
69 REVERSE_MAX_SPD WORD S A9 45
[RESS]
70 CELL_COUNT WORD U A9 80
71 CELL_TYPE WORD U A9 01
72 TH_HIGH_B_H_TEMP WORD S A9 60
73 TH_LOW_B_L_TEMP WORD S A9 -25
74 TH_LOW_CHGBTEMP WORD S A9 -10
75 BATTERY_TRICKLECHG_T WORD S A9 0
76 CELL_UNDERVOLTAGE WORD U A9 3000
77 CELL_UNDERVOLTAGE_WARN WORD U A9 3200
78 CELL_OVERVOLTAGE WORD U A9 4200
79 CELL_TARGET_AC WORD U A9 4150
80 CELL_TARGET_DC WORD U A9 4150
81 CELL_NOMINAL WORD U A9 3650
82 CELL_REST WORD U A9 3950
83 CHG_OVERSHOOT_AC WORD U A9 15
84 CHG_OVERSHOOT_DC WORD U A9 15
85 BALANCING_WINDOW_AC WORD U A9 20
86 BALANCING_WINDOW_DC WORD U A9 30
87 HIGH_PACK_V_DELTA WORD S A9 50
88 LOW_PACK_V_DELTA WORD S A9 -50
89 BATTERY_UNBALANCE WORD U A9 100
90 SOC_VALIDATION_TH WORD U A9 10
91 CELLV_LCA WORD S A9 -350
92 CELLV_HCA WORD S A9 0
93 PACK_LPA WORD S A9 -350
94 CELLV_KA WORD S A9 75
95 CELLV_KAI WORD S A9 200
96 CELLV_KAD WORD S A9 100
97 PACKV_KA WORD S A9 75
98 PACKV_KAI WORD S A9 125
99 PACKV_KAD WORD S A9 30
100 TARGET_AC WORD U A9 70
101 TARGET_DC WORD U A9 70
102 CHG_OVERVOLTAGE  WORD U A9 4175
103 RESS_DUMMY_WORD34 WORD U A9 0
104 RESS_DUMMY_WORD35 WORD U A9 0
105 RESS_DUMMY_WORD36 WORD U A9 0
106 RESS_DUMMY_WORD37 WORD U A9 0
107 RESS_DUMMY_WORD38 WORD U A9 0
108 RESS_DUMMY_WORD39 WORD U A9 0
109 RESS_DUMMY_WORD40 WORD U A9 0
110 RESS_DUMMY_WORD41 WORD U A9 0
111 RESS_DUMMY_WORD42 WORD U A9 0
112 RESS_DUMMY_WORD43 WORD U A9 0
113 RESS_DUMMY_WORD44 WORD U A9 0
114 RESS_DUMMY_WORD45 WORD U A9 0
115 RESS_DUMMY_WORD46 WORD U A9 0
116 RESS_DUMMY_WORD47 WORD U A9 0
117 RESS_DUMMY_WORD48 WORD U A9 0
118 RESS_DUMMY_WORD49 WORD U A9 0
119 RESS_DUMMY_WORD50 WORD U A9 0
[DRIVE_BY_WIRE 1/2]
120 ThrottleCurve1_1 WORD U A9 0
121 ThrottleCurve1_2 WORD U A9 180
122 ThrottleCurve1_3 WORD U A9 340
123 ThrottleCurve1_4 WORD U A9 475
124 ThrottleCurve1_5 WORD U A9 590
125 ThrottleCurve1_6 WORD U A9 685
126 ThrottleCurve1_7 WORD U A9 770
127 ThrottleCurve1_8 WORD U A9 840
128 ThrottleCurve1_9 WORD U A9 900
129 ThrottleCurve1_10 WORD U A9 950
130 ThrottleCurve1_11 WORD U A9 1000
131 ThrottleCurve2_1 WORD U A9 0
132 ThrottleCurve2_2 WORD U A9 40
133 ThrottleCurve2_3 WORD U A9 90
134 ThrottleCurve2_4 WORD U A9 155
135 ThrottleCurve2_5 WORD U A9 225
136 ThrottleCurve2_6 WORD U A9 310
137 ThrottleCurve2_7 WORD U A9 410
138 ThrottleCurve2_8 WORD U A9 530
139 ThrottleCurve2_9 WORD U A9 670
140 ThrottleCurve2_10 WORD U A9 820
141 ThrottleCurve2_11 WORD U A9 1000
142 REGEN_CURRENT_LIMIT WORD S A9 1200
143 ACTIVE_CURRENT_LIMIT WORD S A9 4000
144 SPEED_LIMIT_SPORT WORD S A9 200
145 SPEED_LIMIT WORD S A9 177
146 SPEED_LIMIT_ECO WORD S A9 85
147 DBW_CONFIG WORD U A9 511
148 HALL_THROTTLE_ZERO_TH WORD S A9 100
149 BACKUP_MODE_TRQ WORD S A9 250
150 DBW_CONFIG_2 WORD S A9 3
151 DIGITAL_BRAKE WORD S A9 0
152 WSS_CAL0_1 WORD S A9 0
153 WSS_CAL2_3 WORD S A9 0
154 MOTOR_MAX_SPD WORD S A9 11750
155 MOTOR_TYPE WORD S A9 1
156 NT_SPD_MT_1_2 WORD S A9 400
157 NT_SPD_MT_3 WORD S A9 400
158 NT_SPD_TH WORD S A9 30
159 NT_TRQ_MT_1_2 WORD S A9 450
160 NT_TRQ_MT_3 WORD S A9 550
161 CRUISE_KD WORD S A9 0
162 CRUISE_KI WORD S A9 600
163 CRUISE_KIP WORD S A9 3000
[AIR_TEMP]
164 AIRTEMP_READOUT_LOW_TH WORD U A9 1240
165 AIRTEMP_READOUT_HIGH_TH WORD U A9 4070
166 NTC_CALIBRATION_TPOINTS_0 WORD S A9 800
167 NTC_CALIBRATION_TPOINTS_1 WORD S A9 600
168 NTC_CALIBRATION_TPOINTS_2 WORD S A9 500
169 NTC_CALIBRATION_TPOINTS_3 WORD S A9 400
170 NTC_CALIBRATION_TPOINTS_4 WORD S A9 350
171 NTC_CALIBRATION_TPOINTS_5 WORD S A9 300
172 NTC_CALIBRATION_TPOINTS_6 WORD S A9 250
173 NTC_CALIBRATION_TPOINTS_7 WORD S A9 200
174 NTC_CALIBRATION_TPOINTS_8 WORD S A9 150
175 NTC_CALIBRATION_TPOINTS_9 WORD S A9 100
176 NTC_CALIBRATION_TPOINTS_10 WORD S A9 50
177 NTC_CALIBRATION_TPOINTS_11 WORD S A9 0
178 NTC_CALIBRATION_TPOINTS_12 WORD S A9 -50
179 NTC_CALIBRATION_TPOINTS_13 WORD S A9 -100
180 NTC_CALIBRATION_TPOINTS_14 WORD S A9 -150
181 NTC_CALIBRATION_TPOINTS_15 WORD S A9 -250
182 NTC_CALIBRATION_TPOINTS_16 WORD S A9 -400
183 NTC_CALIBRATION_CPOINTS_0 WORD U A9 1253
184 NTC_CALIBRATION_CPOINTS_1 WORD U A9 1910
185 NTC_CALIBRATION_CPOINTS_2 WORD U A9 2288
186 NTC_CALIBRATION_CPOINTS_3 WORD U A9 2670
187 NTC_CALIBRATION_CPOINTS_4 WORD U A9 2854
188 NTC_CALIBRATION_CPOINTS_5 WORD U A9 3028
189 NTC_CALIBRATION_CPOINTS_6 WORD U A9 3190
190 NTC_CALIBRATION_CPOINTS_7 WORD U A9 3338
191 NTC_CALIBRATION_CPOINTS_8 WORD U A9 3470
192 NTC_CALIBRATION_CPOINTS_9 WORD U A9 3586
193 NTC_CALIBRATION_CPOINTS_10 WORD U A9 3685
194 NTC_CALIBRATION_CPOINTS_11 WORD U A9 3770
195 NTC_CALIBRATION_CPOINTS_12 WORD U A9 3841
196 NTC_CALIBRATION_CPOINTS_13 WORD U A9 3899
197 NTC_CALIBRATION_CPOINTS_14 WORD U A9 3945
198 NTC_CALIBRATION_CPOINTS_15 WORD U A9 4012
199 NTC_CALIBRATION_CPOINTS_16 WORD U A9 4048
200 AIR_TEMP_DUMMY_WORD1 WORD S A9 0
201 AIR_TEMP_DUMMY_WORD2 WORD S A9 0
[LIMP_MODE]
202 LIMP_SOC BYTE U A9 2
203 LIMP_PACK_I WORD S A9 400
204 LIMP_MIN_CELL WORD S A9 3100
205 LIMP_MIN_CELL_LOADED WORD S A9 3000
206 LIMPCURRENT_ACT_LIMIT WORD S A9 250
207 LIMPCURRENT_REG_LIMIT WORD S A9 200
208 LIMP_B_TEMP BYTE S A9 55
209 LIMP_B_FREEZE BYTE S A9 -27
210 LIMP_MOTOR_T BYTE U A9 125
211 LIMP_PACK_V WORD S A9 2400
212 CVM_CURRENT_LEVEL WORD S A9 100
213 RES_MEAS_C_STEP WORD S A9 300
214 LIMP_DRIVE_T BYTE U A9 72
215 LIMPCURRENT_ACT_LIMIT_HIGH WORD S A9 4000
216 LIMPCURRENT_REG_LIMIT_HIGH WORD S A9 1200
217 LIMP_DUMMY_WORD3 WORD S A9 0
218 LIMP_DUMMY_WORD4 WORD S A9 0
219 LIMP_DUMMY_WORD5 WORD S A9 0
220 LIMP_DUMMY_WORD6 WORD S A9 0
221 LIMP_DUMMY_WORD7 WORD S A9 0
222 VCU_ORIENTATION WORD U A9 0
[HORN]
223 HORN_MIN_CURRENT_TH WORD U A8 600
224 HORN_MAX_CURRENT_TH WORD U A8 3500
225 HORN_DUMMY_WORD1 WORD S A8 0
226 HORN_DUMMY_WORD2 WORD S A8 0
[WATER_PUMP]
227 WATER_PUMP_ON_TH BYTE U A8 35
228 WATER_PUMP_OVERTEMP_TH BYTE U A8 80
229 WATER_PUMP_OFF_TH BYTE U A8 30
230 WATER_PUMP_MAX_CURR_TH WORD U A8 2500
231 WATER_PUMP_MIN_CURR_TH WORD U A8 400
232 WATER_PUMP_INITIAL_TEST BOOL U A8 1
233 PUMP_DUMMY_WORD1 WORD S A8 0
234 PUMP_DUMMY_WORD2 WORD S A8 0
[BLINKER]
235 INDICATOR_MIN_CURR_TH WORD U A8 200
236 INDICATOR_MAX_CURR_TH WORD U A8 500
237 INDICATORLIGHTS_INITIAL_TEST BOOL U A8 0
238 BLINKER_DUMMY_WORD1 WORD U A8 0
239 BLINKER_DUMMY_WORD2 WORD U A8 0
[LIGHTS]
240 BEAM_MAX_CURR_TH WORD U A8 7500
241 BEAM_HILO_CURR_TH WORD U A8 3750
242 BEAM_MIN_CURR_TH WORD U A8 1500
243 POSLIGHTS_MIN_CURR_TH WORD U A8 50
244 POSLIGHTS_MAX_CURR_TH WORD U A8 300
245 STOPLIGHTS_MIN_CURR_TH WORD U A8 50
246 STOPLIGHTS_MAX_CURR_TH WORD U A8 300
247 STOPLIGHTS_INITIAL_TEST BOOL U A8 1
248 CHARGE_POSLIGHTS BOOL U A8 1
249 LM_TYPE WORD S A8 0
250 EBRAKE_LIGHT_TH WORD S A8 270
251 RPOSLIGHTS_MIN_CURR_TH WORD S A8 15
252 RPOSLIGHTS_MAX_CURR_TH WORD S A8 500
[SPEED_ODO]
253 SPEED_ODO_FRONTWHEEL_C WORD U A8 1852
254 SPEED_ODO_REARWHEEL_C WORD U A8 1983
255 SPEED_ODO_FINALGEAR WORD U A8 4140
256 SPEED_ODO_PRIMARYGEAR WORD U A8 18268
[EVSE]
257 MAX_AC_CHG_CURRENT BYTE S A9 15
258 MAX_DC_CHG_CURRENT BYTE S A9 60
259 FCHG_CURRENT_GAIN WORD S A9 225
260 EE_EVSE_DUMMY_1 WORD S A9 0
261 MAX_C_TEMP BYTE S A9 105
262 EE_EVSE_DUMMY_2 WORD S A9 0
263 EE_EVSE_DUMMY_3 WORD S A9 0
264 CHARGER_TYPE WORD S A9 0
265 EVSE_DUMMY_WORD4 WORD S A9 0
[FUEL_ECONOMY]
266 FUELECONOMY_DUMMY_WORD1 WORD S A8 0
267 FUELECONOMY_DUMMY_WORD2 WORD S A8 0
268 FUELECONOMY_DUMMY_WORD3 WORD S A8 0
269 FUELECONOMY_DUMMY_WORD4 WORD S A8 0
[SAFETY_HL]
270 SAFETYHL_DUMMY_WORD1 WORD S A8 0
271 SAFETYHL_DUMMY_WORD2 WORD S A8 0
272 SAFETYHL_DUMMY_WORD3 WORD S A8 0
273 SAFETYHL_DUMMY_WORD4 WORD S A8 0
[EEPROM]
274 EEPROM_VERSION_uC WORD U A9 0
275 EEPROM_VERSION_uS WORD U A8 0
[SAFETY]
276 TABLE_TYPE_uC WORD U A9 16406
277 TABLE_TYPE_uS WORD U A8 16406
`;
}
