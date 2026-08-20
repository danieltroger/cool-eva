// The rider's own charge-current limit — CAN 0x121, opcode 0x18. What the rider dialled in
// on the bike's charging screen, as against the CEILING it runs up to (VCU parameter 258
// MAX_DC_CHG_CURRENT, 75 here, published off 0x625 b2). Those two were being conflated, and
// nothing else on this bus states the setting: it is in no parameter table and no infokey.
//
// 0x121 is a dash↔VCU command channel, not a broadcast — nine opcodes share the id, and only
// 0x18 (DC) and 0x1A (AC) put amps in b2. ⚠️ The opcode gate below is load-bearing, not
// defensive tidiness: 0x1D alone is 204 of the 298 captured frames and reaches b2 = 147,
// and 0x2C has been seen carrying b2 = 0x4B = 75 — the exact number a wrong decode would
// most easily be believed. 0x120, the request twin, is deliberately not decoded: it carries
// no ceiling, and it is the id this project transmits the RTC sync on (vcu/service-actions.ts).
//
// ✅ That b2 is the rider's setting rather than a measurement is settled by the current
// obeying it: dialled DOWN, the measured DC current lands on the commanded value exactly,
// 9 of 9, and across 53 268 samples on the following plateaus the delivered current never
// once exceeded it. Dialling UP is NOT obeyed — set 75 and it stops at 36-73 depending on
// the session — which is precisely why the signal is worth having: it answers "did I cap it
// myself?". The AC twin emits nothing (charge_limit_a already carries it off 0x10A b7 ÷ 7,
// a scale these very events confirm to the amp).
//
// ⚠️ THIS FRAME IS AN EVENT — it fires when the dial moves and at no other time; 5 of 10
// captured DC sessions contain none at all. So the value is the LAST SETTING SEEN, not a
// poll: it is absent after a restart until the dial is next touched, and its tile greys out
// 8 s after arriving. That is honest and must not be papered over with a timer. ❓ Whether
// the setting survives a power cycle is not answerable from this bus; issue #51 has the check.
//
// Opcode table, session-by-session evidence and the log-on-change trap that bites this
// signal alone: docs/can-decode-findings.md § "0x121 — the rider's own charge-current limit".

import type { DecodedValue } from "./frame.ts";

export const CHARGE_SETPOINT_CAN_ID = 0x121;

/** Opcode for "the DC charge-current limit changed". See the table above. */
const DC_CURRENT_LIMIT_OPCODE = 0x18;

/**
 * Decodes one 0x121 frame, emitting only for the DC current-limit opcode. Pure.
 *
 * Returns nothing for the other eight opcodes on this id, which is the normal case:
 * they outnumber this one roughly 16 to 1.
 */
export function decodeChargeSetpointFrame(data: Buffer): DecodedValue[] {
  // ALL SIX structural invariants from the header are gated, not a subset, because this
  // is a COMMAND frame whose byte layout is chosen by the opcode. A future 0x18 meaning
  // something else would more plausibly show up as a changed length or a non-zero tail
  // than as a changed b1, and decoding it anyway would put a fabricated amp figure on a
  // charging screen. Every captured frame on both ids is DLC 8, and b5-7 are zero on every
  // opcode but 0x14 — which is precisely the point: a tail in use marks a different layout.
  //
  // ⚠️ The price of that strictness is the direction it fails in: a firmware update that
  // starts using b5-7, or shortens the frame, makes this signal go SILENT rather than
  // wrong. If it ever stops appearing after an update, look here first.
  if (data.length !== 8 || data[5] !== 0 || data[6] !== 0 || data[7] !== 0) {
    return [];
  }
  // b1 is 0xFF in all 596 captured frames of both ids, opcode regardless — a separator.
  if (data[0] !== DC_CURRENT_LIMIT_OPCODE || data[1] !== 0xff) {
    return [];
  }
  // b3 = 1 means "a limit is in force", and ONLY the two limit-change opcodes ever set
  // it: the charge stop sends b3 = 0, as do 0x02/0x1D/0x1E/0x2C. The other two are not 0
  // but are not 1 either — 0x1B answers a query in this byte (40..145) and 0x14 reads 138
  // — so this is a genuine second discriminator rather than a restatement of the opcode.
  if (data[3] !== 1) {
    return [];
  }
  const selected = data[2];
  const ceiling = data[4];
  // 1 ≤ b2 ≤ b4 held in every captured event. A frame that breaks it is not this message,
  // and passing it through would put a setting on the dashboard contradicting the ceiling
  // drawn next to it — the one reading worse than showing nothing at all. A zero ceiling
  // needs no clause of its own: b2 is ≥ 1 by here, so b2 > b4 already catches it.
  if (selected < 1 || selected > ceiling) {
    return [];
  }
  // b4 is deliberately NOT emitted, only used as the guard above. It is the same number
  // as 0x625 b2, which the charge manager broadcasts at 10 Hz for the whole time the bike
  // is awake — a strictly better source for a value that never changes, where this one
  // arrives only when the dial moves. See the "ceiling" note at the top.
  return [{ key: "dc_charge_limit_selected_a", value: selected }];
}
