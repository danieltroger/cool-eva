import type { RawChannel } from "socketcan";
import type { ArrivalLatency, FrameArrival } from "../can/frame-arrival.ts";
import { describeFirmwareRow, firmwareRowFor, type A8FirmwareRow } from "./a8-firmware-rows.ts";
import { createVcuKwpClient, type VcuProbeOutcome } from "./kwp-client.ts";
import {
  describeWidthMismatch,
  identifierFor,
  interpretRecord,
  type RecordEncoding,
  type VcuTarget,
} from "./param-codec.ts";
import { CALIBRATION_BANK, parameterAtIndex } from "./param-table.ts";
import { note } from "./snapshot.ts";

// Read ONE identifier off ONE target, on demand, from the dashboard. It exists for what the
// sweep cannot reach — which since #219 is no longer "everything outside params.ecf": the
// sweep now reads 302 identifiers, the 25 A8 firmware rows included. What is still only
// reachable here is the identifier space itself, `(bank << 12) | index`, and **bank 2 is
// live data** — the running values, not the stored settings.
//
// ⚠️ WHAT THIS WIDENS, PRECISELY. Before it, no HTTP input named a service, an identifier
// or a value; now an identifier and a target are caller-supplied. The request union in
// ./param-codec.ts still has THREE members and still throws on any service byte outside the
// read-only set, and there is still nowhere in it to put a VALUE. The line held is "which
// thing is read" versus "what is done to it": widening the first is recoverable, widening
// the second is not. docs/vcu-parameters.md §9.
//
// ⚠️ The charge-manager target `A4` on 0x7C3/0x7E3 was offered here for part of 2026-08-16
// and removed: `0x7E3` is DashboardV2's request id, so a probe on that pair could have been
// questioning the DASHBOARD while the page said "charge manager". See the note above
// `VcuTarget` in ./param-codec.ts for where it actually lives.
//
// One read, not a session: a probe opens a session, asks once and stops, bounded by two
// reply windows — so the safety gate's 200 ms watchdog can end it mid-flight.

/** What to ask for. Every field is caller-supplied, which is the point and also the risk. */
export interface VcuProbeRequest {
  target: VcuTarget;
  /** 0…15. Bank 1 is the calibration EEPROM the name table describes; bank 2 is live data. */
  bank: number;
  /** 0…4095 — the low 12 bits of the identifier. */
  index: number;
}

/** What came back, in the shape the page renders. */
export interface VcuProbeReading extends VcuProbeRequest {
  /** `(bank << 12) | index`, so the page can show the identifier that actually went out. */
  identifier: number;
  status: VcuProbeOutcome["status"];
  /**
   * What the name table calls this, or null. Only ever non-null for a bank-1 index
   * inside 1…277 — the table describes the VCU's calibration bank and nothing else,
   * so a bank-2 read or a charge-manager read is always unnamed here. That is not a
   * gap to fill in later with a guess: it is the honest state of what is known.
   *
   * ⚠️ Still null for the 25 A8 bank-1 identifiers ./a8-firmware-rows.ts describes. They
   * are not `params.ecf` names and must not read as if they were; what they add is a
   * width for the reply to be checked against, and a sentence in `note`.
   */
  name: string | null;
  section: string | null;
  /** Exactly what the bike sent, or null if it sent nothing. */
  rawHex: string | null;
  /** Big-endian unsigned reading of those bytes. */
  unsigned: number | null;
  /**
   * The same bytes as two's complement.
   *
   * BOTH readings are returned, always, and neither is called "the value" unless the
   * name table says which one is right. For anything outside bank 1 nothing here
   * knows the width or the sign, so offering one number would be inventing the half
   * of the answer that was not read off the bus.
   */
  signed: number | null;
  /** The typed value per the table's S/U column. Null wherever the table has no opinion. */
  value: number | null;
  /** Why a non-`read` outcome is not a value, or what is unusual about one that is. */
  note: string | null;
  /**
   * How late our flow control was, in ms, or null when the reply needed none.
   *
   * ⚠️ Null is the ORDINARY case and means "no First Frame arrived", not "not measured":
   * a reply that fits one frame is never answered. It is non-null exactly for the wide
   * records this probe exists to reach, and it is the first number to look at when one
   * comes back `stalled` — ../can/obd-dtc.ts measured 4/12 transfers completing at 0 ms
   * of added delay and 1/12 at 40 ms. `known: false` means the kernel gave no stamp or
   * the clock stepped.
   */
  flowControlLatency: ArrivalLatency | null;
}

export interface VcuProbeOptions extends VcuProbeRequest {
  /** The service's already-started channel. Never reconfigured, never stopped here. */
  channel: RawChannel;
}

export interface RunningProbe {
  /**
   * Feed CAN frames here; true when consumed. The reply id depends on the target, so the
   * client decides.
   *
   * ⚠️ `arrival` is the KERNEL's stamp (../can/frame-arrival.ts). It was dropped here
   * until a read could answer a First Frame; now that one can, dropping it would leave
   * `flowControlLatency` on the reading below permanently `known: false` — measured by
   * the transport and thrown away one call short of the page that wants it.
   */
  handleFrame: (id: number, data: Buffer, arrival?: FrameArrival | null) => boolean;
  /** Stops it. The in-flight request settles as `not-sent` — our doing, never the bike's. */
  abort: (reason: string) => void;
  finished: Promise<VcuProbeReading>;
}

/** Largest index a 12-bit identifier half can hold. */
const MAX_INDEX = 0x0fff;

/** Largest bank a 4-bit identifier half can hold. */
const MAX_BANK = 0xf;

/**
 * The targets a probe may address, in the order the page offers them.
 *
 * The two VCU micros, and nothing else. See the header for why the charge manager is
 * not here — briefly: the id pair it was given belongs to the dashboard.
 */
export const PROBE_TARGETS: VcuTarget[] = ["A9", "A8"];

export function startProbe(options: VcuProbeOptions): RunningProbe {
  const client = createVcuKwpClient(options.channel);
  const finished = client
    .probe(options.target, options.bank, options.index)
    .then(outcome => describeProbe(outcome))
    .finally(() => client.stop());
  return {
    handleFrame: (id, data, arrival) => client.handleFrame(id, data, arrival),
    abort: () => client.stop(),
    finished,
  };
}

/**
 * Turns one outcome into the row the page shows. Pure.
 *
 * Kept apart from the transport for the same reason ./snapshot.ts is: what a reply
 * MEANS is a question about the name table and the bytes, and it can be exercised
 * against captured records with no bus in the loop.
 */
export function describeProbe(outcome: VcuProbeOutcome): VcuProbeReading {
  // The name table describes bank 1 on the VCU micros and nothing else, so it is
  // consulted only there. Looking up a bank-2 index in it would attach a calibration
  // parameter's name and sign to a live-data reading that has neither — a wrong
  // answer that looks more informative than the right one.
  //
  // The target no longer needs excluding here: every target a probe can name is now a
  // VCU micro (PROBE_TARGETS), so bank 1 is always this table's bank. If another ECU
  // is ever added, this condition has to grow a target check back.
  const parameter = outcome.bank === CALIBRATION_BANK ? parameterAtIndex(outcome.index) : null;
  // ⚠️ The target and the bank are both part of this lookup, not just the index: A8 bank 1
  // index 1000 is the service date's low word, and A9 bank 1 or A8 bank 2 at the same index
  // is neither. A probe can name any of them from a phone.
  const firmware = parameter ? null : firmwareRowFor(outcome.target, outcome.bank, outcome.index);
  const base = {
    target: outcome.target,
    bank: outcome.bank,
    index: outcome.index,
    identifier: outcome.identifier,
    status: outcome.status,
    name: parameter?.name ?? null,
    section: parameter?.section ?? null,
    flowControlLatency: outcome.flowControlLatency,
  };
  if (outcome.status !== "read") {
    return {
      ...base,
      rawHex: null,
      unsigned: null,
      signed: null,
      value: null,
      note: note(describeFailure(outcome), firmware && describeFirmwareRow(firmware)),
    };
  }
  const encoding = parameter ?? firmware;
  const interpreted = interpretRecord(outcome.record, encoding);
  return {
    ...base,
    rawHex: interpreted.rawHex,
    unsigned: interpreted.unsigned,
    signed: interpreted.signed,
    value: interpreted.value,
    note: probeNote(outcome.record.length, parameter !== null, encoding, firmware, interpreted.widthMismatch),
  };
}

function probeNote(
  recordLength: number,
  named: boolean,
  encoding: RecordEncoding | null,
  firmware: A8FirmwareRow | null,
  widthMismatch: boolean
): string | null {
  const known = firmware ? describeFirmwareRow(firmware) : null;
  if (widthMismatch && encoding) {
    // ⚠️ The SAME sentence ./snapshot.ts puts on a row, out of ./param-codec.ts, because it
    // has to name which width the reply contradicts and the two sources carry very
    // different weight. docs/vcu-parameters.md §2.
    return note(describeWidthMismatch(recordLength, encoding), known);
  }
  if (named) {
    return null;
  }
  if (known) {
    return known;
  }
  // Not an error, and said plainly rather than left as a silent null: the whole
  // point of probing is to reach identifiers nothing here describes.
  return "nothing in the name table describes this identifier — the bytes are real, their width and sign are not known";
}

function describeFailure(outcome: VcuProbeOutcome): string {
  switch (outcome.status) {
    case "refused":
      return `refused with NRC ${outcome.description} — the ECU is there and will not serve this identifier`;
    case "no-response":
      return "a session was open and this identifier got silence — not the same claim as “no such identifier”";
    case "no-session":
      return `${outcome.reason} — either nothing is at this address, or it is asleep`;
    case "stalled":
      return `${outcome.reason} — not the same claim as silence`;
    case "abandoned":
      return `the reply was discarded rather than decoded: ${outcome.reason}`;
    case "unrecognised":
      return outcome.reason;
    case "not-sent":
      return `never asked — ${outcome.reason}`;
    default:
      return outcome.status;
  }
}

/**
 * Validates what a caller asked for. Pure, and the only place a probe request is
 * checked.
 *
 * Returns a reason rather than throwing, because every one of these is a person
 * typing into a box on a phone, not a bug in this repo — and the page shows the
 * reason. `identifierFor` would throw on the same inputs; this catches them one
 * layer earlier so a typo is a message instead of a 500.
 */
export function parseProbeRequest(raw: {
  target: string | null;
  bank: string | null;
  index: string | null;
}): { ok: true; request: VcuProbeRequest } | { ok: false; reason: string } {
  const target = PROBE_TARGETS.find(candidate => candidate === raw.target?.toUpperCase());
  if (!target) {
    return { ok: false, reason: `target must be one of ${PROBE_TARGETS.join(", ")}, not ${raw.target ?? "(nothing)"}` };
  }
  const bank = parseNumber(raw.bank);
  if (bank === null || bank < 0 || bank > MAX_BANK) {
    return { ok: false, reason: `bank must be a whole number 0…${MAX_BANK}, not ${raw.bank ?? "(nothing)"}` };
  }
  const index = parseNumber(raw.index);
  if (index === null || index < 0 || index > MAX_INDEX) {
    return { ok: false, reason: `index must be a whole number 0…${MAX_INDEX}, not ${raw.index ?? "(nothing)"}` };
  }
  // Proves the pair really does make an identifier, using the same function the
  // encoder uses, so the page can never be told a request is valid that the codec
  // would then refuse.
  identifierFor(bank, index);
  return { ok: true, request: { target, bank, index } };
}

/** `0x1F` and `31` both, because an index copied out of a hex dump is the common case. */
function parseNumber(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const text = raw.trim();
  const value = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  return Number.isInteger(value) ? value : null;
}
