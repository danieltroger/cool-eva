import {
  activeParameterTable,
  parameterAtIndex,
  recordLengthFor,
  type VcuMicro,
  type VcuParameter,
  type VcuParameterTable,
} from "./param-table.ts";
import { identifierForIndex } from "./param-codec.ts";
import { registerAllowlistTableCheck } from "./table-gate.ts";
import { registerWritePlanVerifier } from "./write-codec.ts";

// THE ALLOWLIST. The only VCU calibration parameters this repo will ever write, the
// only values it will write into them, and the pure function that turns a request into
// bytes or into a refusal. Data and arithmetic only — no socket, no clock, no state;
// scripts/check-vcu-params.ts §14 exercises every branch below.
//
// ⚠️ An identifier not on this list is not "out of range", it is UNEXPRESSIBLE. There
// is no `writeIdentifier(id, value)` in this repo, the HTTP layer takes a NAME rather
// than a number (src/http/vcu-write.ts), and ./write-codec.ts re-checks the plan against
// this module immediately before the bytes are built. Two identifiers away from the five
// below sit `CELL_OVERVOLTAGE`, `THROTTLE_MAX_TH` and `ACTIVE_CURRENT_LIMIT`.
//
// ⚠️ Every bound below is POLICY, not a measured hardware limit; every name is a claim
// about which of Energica's 28 parameter tables the bike runs; and NONE of these five has
// ever been written by this repo, at any value. Why each entry is on the list, where each
// bound came from, and what the two table checks can and cannot see: docs/vcu-parameters.md §5.

/** How a caller may change a parameter: as a number, or as one named bit of a word. */
export type WriteControl =
  /** A whole value, bounded. `min`/`max` are in RAW counts, the same units the record carries. */
  | { kind: "number"; min: number; max: number }
  /**
   * One named bit of a config word, and nothing else.
   *
   * ⚠️ There is deliberately NO way to write the word itself. `VSM_CONFIG_1` packs
   * the PSU type (`0x0760`) and the Bluetooth variant (`0x3000`) alongside the bit
   * the owner wants, and the failure this prevents is documented rather than
   * imagined: Energica's own option file describes `OP0024` as "value 4, mask 4", and
   * another owner's tool warns in as many words that "writing the label's value over
   * the whole parameter would clear the others". Writing `4` into this word would
   * turn off fast charging, the IO extension, the PSU type and Bluetooth in one go.
   */
  | { kind: "bits"; bits: WritableBit[] };

export interface WritableBit {
  /** What a caller names it. Stable, lower-case, no spaces — it appears in URLs and in the audit record. */
  key: string;
  mask: number;
  label: string;
  /** ⚠️ Shown before the confirmation, every time. */
  caveat: string;
}

export interface WriteTarget {
  /** params.ecf's name. The primary key — a caller names this, never an identifier. */
  name: string;
  /** 1-based params.ecf index. The rest (micro, width, sign) is looked up, never restated. */
  index: number;
  control: WriteControl;
  /** What the raw count means to a human, e.g. `2300` → `230.0 Nm`. */
  unit: (raw: number) => string;
  /** Why it is on the list at all. Shown in the UI above the value. */
  purpose: string;
  /** ⚠️ Everything a reasonable person would want to know before pressing the button. */
  warnings: string[];
  /**
   * How to check the bike afterwards, beyond the read-back the write already does.
   *
   * ⚠️ Kept OUT of `warnings` on purpose, and it is not a filing tidy-up: these two
   * things are read at different moments. `warnings` is the argument against pressing
   * the button and is worth having in front of you first; this is the first thing you
   * want once you have pressed it, and standing in a garage that is a different screen.
   * public/views/vcu-write.js shows it after the write for exactly that reason.
   *
   * Null where nothing outside the read-back can confirm it — which is itself worth
   * saying rather than inventing a check.
   */
  verify: string | null;
}

/**
 * The list.
 *
 * Five entries, each one asked for by name. Adding a sixth means writing down what it
 * does, what its bounds are and why — which is the friction this file exists to
 * create.
 */
export const WRITE_TARGETS: WriteTarget[] = [
  {
    name: "MAX_DC_CHG_CURRENT",
    index: 258,
    // BYTE S per params.ecf, but Energica's own option data gives `mask=0x7F` — bit 7 is
    // RESERVED, so the value field is 0…127 whatever the sign column says. ⚠️ That is the
    // constraint on the ceiling below: a bound past 127 would be writing into the reserved
    // bit, which is not a larger current. 80 is 0x50, bit 7 clear, so the sign question
    // does not arise at any value on this list. The unit is literal amperes, unscaled.
    //
    // 80 because Energica shipped exactly that — its "Fast Charge 60 / 75 / 80 Amps"
    // options all write THIS parameter and nothing else — and 0 because turning DC
    // charging down is the safe direction. The evidence for both, and the three
    // independent 0x4B cross-checks on the broadcast side: docs/vcu-parameters.md §5.
    control: { kind: "number", min: 0, max: 80 },
    unit: raw => `${raw} A`,
    purpose:
      "The DC fast-charge current this bike advertises to a charger, in amperes. Reads 75. Energica's own 60/75/80 A options write this parameter and nothing else, so 80 is a value the factory shipped.",
    warnings: [
      "⚠️ It will probably do nothing. Across eight logged DC sessions the ceiling is the STATION, not the bike: station identity explains 84 % of the variance, the highest ever delivered is 73.2 A, and no station has offered even the 75 A already permitted.",
      "⚠️ 80 A is 1.25C for this pack. The cell datasheet allows 1.10C = 70.4 A, and only between 25 and 35 °C — and the VCU is shown 35 °C while the pack is really at 44-54 °C, so 91 % of DC charging time above 30 A is already over the cell's fast-charge ceiling. This raises the ceiling on an exposure that is already there.",
      "A dealer visit reverts it. The service tool reinstalls parameter values from Energica's server, keyed by VIN.",
    ],
    verify:
      "Free check, no charger needed: 0x625 b2 is the configured max DC current and is broadcast on a merely-awake bike. It should now read the value you wrote (0x50 for 80 A, 0x4B for 75). If it does not, the write did not take.",
  },
  {
    name: "FCHG_CURRENT_GAIN",
    index: 259,
    // WORD S per params.ecf. Reads 225 on this bike (live, 2026-08-08) and 225 in the
    // other bike's variant file too, despite that bike's ceiling being 60 A rather
    // than 75 — which is itself an argument that it does not set the ceiling.
    //
    // ⚠️ There is NO documented range for this parameter. It is not an Energica
    // option, it does not appear in the 2021 or 2024 service-tool builds by name, this
    // bike's firmware bundle ships no engineering range file, and 225 is the only value
    // anyone has ever seen. So 0…512 is this repo's policy and nothing more: wide enough to hold
    // both "unity" candidates and a doubling either side, narrow enough that a typo
    // cannot write 30000. A tight range around a number whose semantics nobody has
    // established would be false precision.
    control: { kind: "number", min: 0, max: 512 },
    unit: raw => `${raw} (raw — the unit is not known)`,
    purpose:
      "An EVSE-block scalar whose meaning has never been established. Reads 225. Absent from Energica's tooling entirely — no option, no label, no range, no code path.",
    warnings: [
      "⚠️⚠️ THE DIRECTION OF EFFECT IS UNKNOWN, and this is a genuine 50/50 rather than a gap someone forgot to close. If it is a MEASUREMENT CALIBRATION — which the name argues for — then raising it makes the bike believe it is drawing ~13 % more than it is, and it would back off SOONER, not later. If it sits in a denominator instead, it would draw more. Nothing anywhere derives which.",
      "⚠️ Third possibility, and it is not remote: the DC charge is regulated by a PID loop (CELLV_KA/KAI/KAD against CELL_TARGET_DC), and a “gain” of 225 in the EVSE block may be a controller gain in that loop. If so, 225 → 255 changes loop DYNAMICS, not the ceiling — and a badly chosen loop gain oscillates.",
      "⚠️ The arithmetic that produced 255 has been RETRACTED. “75 × 225/255 = 66.18 A” matched an observed ceiling to three figures, which is where 255 came from — but the wire request was later measured at 75 while 66.2 A flowed, and 73.2 A was delivered on another day with no parameter change. Both facts are incompatible with a fixed 88 % gate on the request. It is now treated as numerology.",
      "Change ONE parameter per charge session. With the station explaining 84 % of the variance, two changes at once cannot be told apart afterwards. Get MAX_DC_CHG_CURRENT = 80 into the bag first.",
    ],
    verify:
      "No broadcast field carries this one, so the read-back above is the only confirmation the cell took it. What it DOES is a question for the next DC session — logged, at a station you have used before, with nothing else changed.",
  },
  {
    name: "TORQUE_LIMIT",
    index: 48,
    // WORD S, 0.1 Nm per count. This bike reads 2300 = 230.0 Nm.
    //
    // The ceiling is 2760 = +20 %, and it is a POLICY bound with one piece of
    // reasoning behind it: 20 % is the same step the owner already took on
    // REGEN_TORQUE_LIMIT (500 → 600) on 2026-08-09, and there is no measured figure
    // anywhere in obd-garage/ for how much torque this motor and this pack will
    // actually deliver — so a larger number would be a guess dressed as a limit. The
    // floor is 0: reducing torque is the safe direction.
    control: { kind: "number", min: 0, max: 2760 },
    unit: raw => `${(raw / 10).toFixed(1)} Nm`,
    purpose: "The drive torque ceiling, 0.1 Nm per count. Reads 230.0 Nm.",
    warnings: [
      "⚠️ Raising this raises what the bike will deliver at full throttle, which is a change to how the motorcycle behaves under your hand. Not a bench setting.",
      "Torque may already be clipping against ACTIVE_CURRENT_LIMIT (400 A), which is NOT on this allowlist. If nothing changes, that is the likely reason.",
      "The 276.0 Nm ceiling is this repo's policy (+20 % on today's value), not a measured hardware limit.",
    ],
    verify:
      "Nothing broadcasts this, so the read-back above is the only confirmation the cell took it — a parameter sweep re-reads it later if you want it in the record. Whether it changed anything is felt at full throttle, and ACTIVE_CURRENT_LIMIT may cap it first.",
  },
  {
    name: "REGEN_TORQUE_LIMIT",
    index: 49,
    // WORD S, 0.1 Nm per count. Factory 500; this bike was set to 600 = 60.0 Nm on
    // 2026-08-09 (obd-garage/VCU_PARAM_CHANGES.md).
    //
    // 900 = 90.0 Nm, i.e. +50 % on today's value. Wider than TORQUE_LIMIT's bound
    // because regen is the gentler direction and because VCU_PARAM_CHANGES.md already
    // records the suspicion that regen clips against REGEN_CURRENT_LIMIT (142) at
    // 120 A well before torque runs out — so the interesting experiment is "does more
    // headroom change anything", and it needs room to answer no.
    control: { kind: "number", min: 0, max: 900 },
    unit: raw => `${(raw / 10).toFixed(1)} Nm`,
    purpose:
      "The regenerative braking torque ceiling, 0.1 Nm per count. Reads 60.0 Nm (raised from the factory 50.0 on 2026-08-09).",
    warnings: [
      "⚠️ REGEN_MAP0..3_TRQ (63-66) read 10/20/30/40 and are almost certainly PERCENTAGES of this limit, so raising this scales every regen map at once.",
      "Engine braking that suddenly got stronger is a handling change, felt first when you close the throttle mid-corner.",
      "It may not change anything: REGEN_CURRENT_LIMIT (142) = 120 A is unchanged and is the suspected real cap.",
    ],
    verify:
      "Nothing broadcasts this either — the read-back above is the confirmation that the cell took it. Whether it does anything shows up as regen current on the next ride: if that still tops out around 120 A, REGEN_CURRENT_LIMIT was the cap all along.",
  },
  {
    name: "VSM_CONFIG_1",
    index: 16,
    // WORD U. This bike reads 0x1113, and every set bit is accounted for:
    //   0x0001 Fast Charge · 0x0002 VCU IO Extension · 0x0010 VCU IO Ext. PRW+
    //   0x0100 PSU type TDK-600W (field mask 0x0760) · 0x1000 Bluetooth STD (field mask 0x3000)
    // Bit map from Energica's own option data (the 2024 service-tool analysis in
    // obd-garage/), decode against the live value in obd-garage/HEATED_GRIPS.md §4.2.
    //
    // ONE bit is offered. Not the word.
    control: {
      kind: "bits",
      bits: [
        {
          key: "heated-handlebars",
          mask: 0x0004,
          label: "Heated handlebars",
          caveat:
            "Energica's option OP0024 sets exactly this bit and nothing else — but activation is normally granted per-VIN on Energica's server, and the option carries a firmware floor (FW.Min.V *.042). The bit may therefore write and read back correctly and the feature still not appear, because the grip logic lives in the DASHBOARD's firmware, not the VCU's.",
        },
      ],
    },
    unit: raw => `0x${raw.toString(16).toUpperCase().padStart(4, "0")}`,
    purpose:
      "The VCU's option word. Only the heated-handlebar bit is offered here; the same word also carries the PSU type and the Bluetooth variant.",
    warnings: [
      "⚠️ The whole word is NOT writable through this repo, on purpose. A raw word write here would reconfigure the PSU type (mask 0x0760) or Bluetooth (mask 0x3000) — the failure mode another owner's tool warns about by name.",
      "⚠️ A successful write does NOT mean the feature turned on. See the bit's own note.",
      "This changes a flag, not wiring. There is no heated-grip circuit on this bike unless one was fitted.",
    ],
    verify:
      "⚠️ Config words are only read at BOOT: key-cycle the bike before judging it. The read-back above proves the word in the VCU's EEPROM changed; it says nothing about whether the dashboard offers the grips, which is a separate firmware's decision.",
  },
];

/** A write, fully decided and ready to become bytes. Only `planWrite`/`planBitWrite` produce one. */
export interface ParameterWritePlan {
  /** params.ecf's name, carried through to the audit record. */
  name: string;
  index: number;
  micro: VcuMicro;
  /** `0x1000 | index` — the CommonIdentifier that goes on the wire. */
  identifier: number;
  /** Exactly the bytes that follow the identifier: 1 for BYTE/BOOL, 2 for WORD. */
  record: Uint8Array;
  /** The value those bytes encode, read the way the table's S/U column says to read it. */
  value: number;
  /** What the bike held immediately before, as the caller read it off the bus. */
  previousValue: number;
  /** One line for a human and for the journal: `MAX_DC_CHG_CURRENT: 75 A → 80 A`. */
  description: string;
}

/** A refusal carries the reason, because every one of these is a person to be told something. */
export type WritePlanOutcome = { ok: true; plan: ParameterWritePlan } | { ok: false; reason: string };

/** The target with this name, or null. Case-insensitive, because a name arrives from a manual or a URL. */
export function writeTargetNamed(name: string): WriteTarget | null {
  const wanted = name.trim().toUpperCase();
  return WRITE_TARGETS.find(target => target.name.toUpperCase() === wanted) ?? null;
}

/** Every name on the allowlist, so a UI's list cannot drift from the codec's. */
export function writeTargetNames(): string[] {
  return WRITE_TARGETS.map(target => target.name);
}

/**
 * Plans a whole-value write.
 *
 * `previousValue` is what the caller believes the bike currently holds. It is NOT
 * decoration: ./write-session.ts re-reads the parameter off the bus and refuses the
 * write when the bike disagrees with it. That turns every write into a
 * compare-and-swap, which is what stops a page left open since yesterday writing 80
 * over a value that has since been changed by something else — and it is the same
 * discipline src/vcu/snapshot-store.ts already applies to snapshots.
 *
 * Returns a reason rather than throwing, because every rejection here is a person
 * typing into a box on a phone. ./write-codec.ts throws on the same inputs, one layer
 * later, for the cases that are bugs.
 */
export function planWrite(name: string, requestedValue: number, previousValue: number): WritePlanOutcome {
  const target = writeTargetNamed(name);
  if (!target) {
    // The refusal that matters most, and it names the whole list rather than only
    // saying no: someone probing for what is writable should learn it here, not by
    // guessing identifiers at a motorcycle's EEPROM.
    return {
      ok: false,
      reason: `${name} is not on the write allowlist. Only these may be written: ${writeTargetNames().join(", ")}`,
    };
  }
  if (target.control.kind !== "number") {
    return {
      ok: false,
      reason: `${target.name} is a config word — its bits are toggled by name, and the word itself is deliberately not writable`,
    };
  }
  if (!Number.isInteger(requestedValue)) {
    return { ok: false, reason: `${target.name} takes a whole number, not ${requestedValue}` };
  }
  if (requestedValue < target.control.min || requestedValue > target.control.max) {
    return {
      ok: false,
      reason:
        `${target.name} may be set to ${target.control.min}…${target.control.max} ` +
        `(${target.unit(target.control.min)}…${target.unit(target.control.max)}), not ${requestedValue}. ` +
        "That bound is this repo's policy, written down with its reasoning in src/vcu/write-targets.ts.",
    };
  }
  return buildPlan(target, requestedValue, previousValue);
}

/**
 * Plans a single-bit change to a config word.
 *
 * The new word is computed FROM the word the bike currently holds, and the result is
 * checked to differ from it in that one mask and nowhere else. So there is no input
 * to this function — none — that can change the PSU type or the Bluetooth variant,
 * whatever a caller sends.
 */
export function planBitWrite(name: string, bitKey: string, on: boolean, currentValue: number): WritePlanOutcome {
  const target = writeTargetNamed(name);
  if (!target) {
    return {
      ok: false,
      reason: `${name} is not on the write allowlist. Only these may be written: ${writeTargetNames().join(", ")}`,
    };
  }
  if (target.control.kind !== "bits") {
    return { ok: false, reason: `${target.name} is a value, not a bit field — write it as a number` };
  }
  const bit = target.control.bits.find(candidate => candidate.key === bitKey);
  if (!bit) {
    const offered = target.control.bits.map(candidate => candidate.key).join(", ");
    return { ok: false, reason: `${target.name} has no writable bit called “${bitKey}”. Offered: ${offered}` };
  }
  if (!Number.isInteger(currentValue) || currentValue < 0 || currentValue > 0xffff) {
    // The current word is the base every bit of the new one is copied from, so a
    // nonsense one would be written straight back into the EEPROM with one bit
    // changed. Refused rather than masked into range.
    return { ok: false, reason: `the current ${target.name} reads ${currentValue}, which is not a 16-bit word` };
  }
  const next = on ? (currentValue | bit.mask) >>> 0 : (currentValue & ~bit.mask) >>> 0;
  const changed = (next ^ currentValue) >>> 0;
  if (changed !== 0 && changed !== bit.mask) {
    // Unreachable by the arithmetic above, and kept because this is the assertion the
    // whole bit-toggle design exists to make. If it ever fires, the word is about to
    // be written with something other than the one bit that was asked for.
    throw new Error(
      `vcu-write: a ${bit.key} toggle would change mask 0x${changed.toString(16)} of ${target.name}, not only 0x${bit.mask.toString(16)}`
    );
  }
  return buildPlan(target, next, currentValue);
}

/**
 * Re-derives a bit-field plan from the word it was supposed to have been built from.
 *
 * The verifier cannot call `planBitWrite` directly — a finished plan carries the new
 * WORD, not the bit and the boolean that produced it. So this works backwards: it
 * finds which mask changed, refuses unless exactly one allowlisted bit accounts for
 * it, and then rebuilds through the normal path. A plan whose word differs from its
 * predecessor in the PSU-type field, or in two bits at once, has no bit that explains
 * it and is refused.
 */
function rebuildBitPlan(target: WriteTarget, value: number, previousValue: number): WritePlanOutcome {
  if (target.control.kind !== "bits") {
    return { ok: false, reason: `${target.name} is not a bit field` };
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    return { ok: false, reason: `${value} is not a 16-bit word` };
  }
  const changed = (value ^ previousValue) >>> 0;
  const bit = target.control.bits.find(candidate => changed === candidate.mask || changed === 0);
  if (!bit) {
    return {
      ok: false,
      reason: `writing ${value} over ${previousValue} would change mask 0x${changed.toString(16)}, which no writable bit of ${target.name} accounts for`,
    };
  }
  return planBitWrite(target.name, bit.key, (value & bit.mask) !== 0, previousValue);
}

/** Turns a checked target and a checked value into bytes. The one place a record is encoded. */
function buildPlan(target: WriteTarget, value: number, previousValue: number): WritePlanOutcome {
  const parameter = parameterFor(target);
  const width = recordLengthFor(parameter.type);
  const encoded = encodeRecord(value, width, parameter.signed);
  if (!encoded) {
    return {
      ok: false,
      reason: `${target.name} is a ${width}-byte ${parameter.signed ? "signed" : "unsigned"} record and cannot hold ${value}`,
    };
  }
  return {
    ok: true,
    plan: {
      name: target.name,
      index: target.index,
      micro: parameter.micro,
      identifier: identifierForIndex(target.index),
      record: encoded,
      value,
      previousValue,
      description: `${target.name}: ${target.unit(previousValue)} → ${target.unit(value)}`,
    },
  };
}

/**
 * A value as the record's bytes, big-endian, or null when it does not fit.
 *
 * Returns null rather than truncating. A truncated write is the worst failure this
 * module could produce: it would be accepted by the micro, read back as whatever the
 * low bytes happened to say, and leave a calibration cell holding a number nobody
 * chose.
 */
function encodeRecord(value: number, width: number, signed: boolean): Uint8Array | null {
  const bits = width * 8;
  const low = signed ? -(2 ** (bits - 1)) : 0;
  const high = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  if (!Number.isInteger(value) || value < low || value > high) {
    return null;
  }
  const unsigned = value < 0 ? value + 2 ** bits : value;
  const bytes = new Uint8Array(width);
  for (let position = width - 1; position >= 0; position -= 1) {
    bytes[position] = (unsigned >> ((width - 1 - position) * 8)) & 0xff;
  }
  return bytes;
}

/**
 * The name table's entry for a target, with the consistency check that keeps the two
 * files honest.
 *
 * The allowlist above carries an index AND a name, and they have to agree with
 * params.ecf. If they ever stop agreeing — a renumbered variant file, a typo — this
 * throws at module load rather than writing 80 into whatever now sits at index 258.
 */
function parameterFor(target: WriteTarget): VcuParameter {
  const parameter = parameterAtIndex(target.index);
  if (!parameter) {
    throw new Error(`vcu-write: the allowlist names index ${target.index}, which params.ecf does not describe`);
  }
  if (parameter.name.toUpperCase() !== target.name.toUpperCase()) {
    throw new Error(
      `vcu-write: the allowlist calls index ${target.index} “${target.name}”, params.ecf calls it “${parameter.name}” — ` +
        "one of them is wrong, and writing to the wrong calibration cell is not a risk worth taking"
    );
  }
  return parameter;
}

// Checked once, at load, for every entry — so a bad allowlist is a service that
// refuses to start rather than one that fails at the moment someone presses the
// button on a parked motorcycle. Same reasoning as param-file.ts's strict parser.
//
// ⚠️ This checks against the table this Pi currently NAMES parameters from, which is a
// default until a bike says otherwise. It is therefore a check on this repo's own
// consistency and not on any motorcycle — allowlistProblemsIn() below is the one that
// asks about the bike, and it is the one the gate consults before every write.
for (const target of WRITE_TARGETS) {
  parameterFor(target);
}

/**
 * ⚠️ Everything wrong with writing this allowlist on a bike running `bikeTable`. Empty
 * means nothing is.
 *
 * Registered with ./table-gate.ts at module load and consulted before every parameter
 * write, alongside the question of whether the bike's table is carried at all. A carried
 * table is not on its own enough: a table can be one we have, correctly identified, and
 * still call index 258 something other than `MAX_DC_CHG_CURRENT`.
 *
 * ⚠️ It compares the bike's table against the ACTIVE one rather than against the
 * allowlist alone, because the active table is what buildPlan() will encode with. Name,
 * storage type, signedness and micro all have to line up: the name is what the owner
 * asked for, and the other three are what the bytes on the wire will be.
 */
export function allowlistProblemsIn(bikeTable: VcuParameterTable): string[] {
  const problems: string[] = [];
  for (const target of WRITE_TARGETS) {
    const onBike = bikeTable.byIndex.get(target.index);
    if (!onBike) {
      problems.push(`index ${target.index} (“${target.name}”) is not in table ${bikeTable.tableType} at all`);
      continue;
    }
    if (onBike.name.toUpperCase() !== target.name.toUpperCase()) {
      problems.push(
        `index ${target.index} is “${target.name}” here and “${onBike.name}” in table ${bikeTable.tableType}`
      );
      continue;
    }
    // Cannot be null while the module-load check above holds, and checked anyway: this
    // function runs long after load, against whatever table is active by then.
    const encoding = parameterAtIndex(target.index);
    if (
      !encoding ||
      encoding.type !== onBike.type ||
      encoding.signed !== onBike.signed ||
      encoding.micro !== onBike.micro
    ) {
      problems.push(
        `${target.name} (index ${target.index}) would be encoded as ` +
          `${encoding ? `${encoding.type} ${encoding.signed ? "S" : "U"} on ${encoding.micro}` : "nothing at all"}` +
          ` from table ${activeParameterTable().tableType}, but table ${bikeTable.tableType} stores it as ` +
          `${onBike.type} ${onBike.signed ? "S" : "U"} on ${onBike.micro}`
      );
    }
  }
  return problems;
}

registerAllowlistTableCheck(allowlistProblemsIn);

/**
 * Re-derives a plan from the allowlist and says whether it matches.
 *
 * Registered with ./write-codec.ts at module load, and called by it immediately
 * before a `2E` frame is built. This is the check that makes "the codec cannot write
 * a non-allowlisted identifier" true of the CODEC rather than only of the callers
 * this repo happens to have today: a plan built by hand, deserialised from JSON, or
 * produced by a future caller that skipped this module is rejected at the last
 * possible moment.
 */
registerWritePlanVerifier(plan => {
  const target = writeTargetNamed(plan.name);
  if (!target) {
    return false;
  }
  // Re-run the SAME entry point a legitimate caller would have used, so the range
  // check and the bit-mask check are re-applied and not merely the encoding. Going
  // straight to buildPlan would accept an in-width but out-of-range value — 127 into
  // a parameter bounded at 80 encodes perfectly well as one signed byte.
  const rebuilt =
    target.control.kind === "number"
      ? planWrite(plan.name, plan.value, plan.previousValue)
      : rebuildBitPlan(target, plan.value, plan.previousValue);
  if (!rebuilt.ok) {
    return false;
  }
  const expected = rebuilt.plan;
  if (expected.identifier !== plan.identifier || expected.index !== plan.index || expected.micro !== plan.micro) {
    return false;
  }
  if (expected.record.length !== plan.record.length) {
    return false;
  }
  // Byte for byte. The value could match while the bytes did not if a plan were
  // assembled with a hand-written record, and it is the BYTES that reach the bus.
  return expected.record.every((byte, position) => byte === plan.record[position]);
});
