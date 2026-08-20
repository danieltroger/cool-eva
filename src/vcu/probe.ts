import type { RawChannel } from "socketcan";
import { createVcuKwpClient, type VcuProbeOutcome } from "./kwp-client.ts";
import { identifierFor, interpretRecord, type VcuTarget } from "./param-codec.ts";
import { CALIBRATION_BANK, parameterAtIndex } from "./param-table.ts";

// Read ONE identifier off ONE target, on demand, from the dashboard. It exists for what the
// 277-parameter sweep cannot reach: the identifier is `(bank << 12) | index`, and **bank 2
// is live data** — the running values, not the stored settings — which nothing here has
// ever read.
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
}

export interface VcuProbeOptions extends VcuProbeRequest {
  /** The service's already-started channel. Never reconfigured, never stopped here. */
  channel: RawChannel;
}

export interface RunningProbe {
  /** Feed CAN frames here; true when consumed. The reply id depends on the target, so the client decides. */
  handleFrame: (id: number, data: Buffer) => boolean;
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
    handleFrame: (id, data) => client.handleFrame(id, data),
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
  const base = {
    target: outcome.target,
    bank: outcome.bank,
    index: outcome.index,
    identifier: outcome.identifier,
    status: outcome.status,
    name: parameter?.name ?? null,
    section: parameter?.section ?? null,
  };
  if (outcome.status !== "read") {
    return { ...base, rawHex: null, unsigned: null, signed: null, value: null, note: describeFailure(outcome) };
  }
  const interpreted = interpretRecord(outcome.record, parameter ?? null);
  return {
    ...base,
    rawHex: interpreted.rawHex,
    unsigned: interpreted.unsigned,
    signed: interpreted.signed,
    value: interpreted.value,
    note: probeNote(outcome.record.length, parameter !== null, interpreted.widthMismatch),
  };
}

function probeNote(recordLength: number, named: boolean, widthMismatch: boolean): string | null {
  if (widthMismatch) {
    return `the reply is ${recordLength} byte(s), which contradicts the name table — value withheld, raw kept`;
  }
  if (named) {
    return null;
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
    case "multi-frame":
      return `the reply was a ${outcome.totalLength}-byte multi-frame transfer, which nothing here assembles`;
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
