// The rider's own charge-current limit — CAN 0x121, opcode 0x18.
//
// The bike's TFT lets the rider pick a DC fast-charge current on the charging screen,
// anywhere from 1 A up to a ceiling. Two different numbers were being conflated:
//
//   the CEILING  VCU calibration parameter 258 MAX_DC_CHG_CURRENT, 75 on this bike.
//                Changed only with the manufacturer's service tool, which sells it as the
//                "Fast Charge 60/75/80 Amps" options — all three write this one byte.
//   the SETTING  what the rider actually dialled in, ≤ the ceiling. This file.
//
// The setting is not a calibration parameter. All 277 rows of this bike's own VCU
// parameter export were searched and there is no second charge-current entry — 258 is the
// only one, and the [EVSE] block's spare slots (EE_EVSE_DUMMY_1/2/3, EVSE_DUMMY_WORD4)
// all read 0. The same holds across all 28 of Energica's parameter tables, and none of the
// 120 telemetry infokeys is a charge-current setpoint either. So WHERE the bike keeps it is
// not known — only that 0x121 is the one place it is ever stated on this bus. Whether it
// survives a power cycle is an open question; see the event note at the bottom.
//
// ## 0x121 is a dash↔VCU command channel, not a broadcast
//
// 0x120 and 0x121 carry a request/reply pair sharing one opcode byte: 0x120 b0 is always
// 0x121 b0 | 0x80 (596 frames across 22 captures, no exception). Nine opcodes were seen,
// and only the two current-limit ones put amps in b2:
//
//   b0    what it is                       b2            b3         b4
//   0x18  DC current limit changed         amps, 1..75   1          0x4B = 75  ← this file
//   0x1A  AC current limit changed         amps, 1..15   1          0x0F = 15
//   0x16  charge stop                      1             0          0
//   0x1B  a query; the answer is in b3      0xAA          40..145    0
//   0x1D  a query; the answer is in b2      45..147       0          0
//   0x02 / 0x14 / 0x1E / 0x2C              other traffic, none of it amps
//
// The gate below is therefore load-bearing, not defensive tidiness: of the 298 captured
// 0x121 frames only 18 are ours, and 0x1D alone accounts for 204 of them and reaches
// b2 = 147, which would read as a wild charge current if the opcode were not checked.
// Worse, opcode 0x2C has been seen carrying b2 = 0x4B = 75 — the exact number a wrong
// decode would most easily be believed. 0x120 is deliberately NOT decoded — it is the
// truncated half of the pair (b3/b4 are 0 there, so it carries no ceiling), and it is
// also the id this project TRANSMITS the RTC sync on (vcu/service-actions.ts).
//
// ## b4 is the ceiling — checked here, published elsewhere
//
// b4 read 0x4B = 75 in all 18 DC events and 0x0F = 15 in all 8 AC events — exactly
// MAX_DC_CHG_CURRENT and MAX_AC_CHG_CURRENT as read from this bike's VCU. So the frame
// is self-describing, and b2 ≤ b4 is a real invariant worth gating on (it is, below).
// It is NOT emitted as a signal: 0x625 b2 carries the identical number continuously
// while this frame carries it only when the dial moves, so the ceiling belongs to the
// charge-manager decoder and the setting belongs here.
//
// ## Evidence that b2 really is the rider's setting
//
// From ~/Documents/cool-eva-archive, 10 DC sessions (0x645 present) and 8 AC ones:
//
//  • 26/26 events satisfy every structural invariant — b1 = 0xFF, b3 = 1, b2 ≥ 1,
//    b2 ≤ b4, b5-7 = 0, DLC 8, and a matching 0x120 twin within 50 ms.
//  • Opcode 0x18 fired 18/18 inside a DC session and opcode 0x1A 0/8 — the two never
//    cross, which is what says b4 is the mode's ceiling rather than a coincidence.
//  • THE CURRENT OBEYS IT. Whenever the rider dialled DOWN below what was flowing, the
//    measured DC current (0x615 b2) settled on the commanded value EXACTLY, 9 times out
//    of 9, in 0.31-2.25 s. 2026-08-09 walks 1 → 5 → 10 → 15 → 20 → 35 A and the current
//    lands on each one in turn.
//  • Over the 15 plateaus that follow an event — 53 268 measured-current samples — the
//    delivered current NEVER ONCE exceeded the commanded setpoint. 100.000 %.
//
// Dialling UP is not obeyed the same way, and that is the point of having the signal:
// set 75 and the current stops at 66, 73, 53 or 36 depending on the session. Something
// else is binding (station envelope, VCU pack-temperature derate — see
// obd-garage/DC_CHARGE_LIMITS.md). So this signal answers "did I cap it myself?", which
// is exactly the question that was unanswerable while the two numbers were conflated.
//
// The AC twin (0x1A) is decoded far enough to be rejected here, and deliberately emits
// nothing: `charge_limit_a` already carries the AC setting continuously off 0x10A b7 ÷ 7.
// The 0x1A events are what CONFIRM that ÷ 7 scale — on 2026-08-08 23:49:59 a commanded
// 9 A put 0x10A b7 at 63 within 0.09 s, and 8 A put it at 56 — so the two agree to the
// amp and there is no reason to log the same number twice.
//
// ⚠️ THIS FRAME IS AN EVENT. It fires when the rider moves the dial and at no other time
// — 5 of the 10 captured DC sessions contain no 0x121 setpoint event at all, because the
// dial was never touched. Nothing rebroadcasts the value, and it is not mirrored anywhere
// on the bus: every byte and 16-bit pair of every id was scanned across three known
// plateaus and the only field tracking the setting was 0x615 b2, the MEASURED current.
// On AC there is a continuous echo (0x10A b7); on DC that byte reads 0 for the whole
// session (1300/1300 frames checked). Consequences worth knowing before relying on this:
//
//   • The value is the LAST SETTING SEEN, not a poll. After a service restart it is
//     absent until the rider next touches the dial.
//   • Its dashboard tile greys out 8 s after arriving, like waypoint_seq and for the
//     same reason. That is not a bug and must not be papered over by re-asserting it on
//     a timer — record() refreshing liveState is how "this signal stopped arriving"
//     stays honest everywhere else (see the STREAM_IDS note in decode.ts).
//   • Whether the setting survives a power cycle is UNKNOWN and not answerable from this
//     bus, because the bike never announces it at session start. Issue #51 carries the
//     on-bike check.

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
