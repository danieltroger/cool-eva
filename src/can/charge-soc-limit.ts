// The bike's own "stop charging at N %" setting — dash command 0x2C on the 0x120/0x121 command
// channel. 0 means no limit. Nothing broadcasts this value: it appears only when the rider
// confirms the menu item, or when we ask for it, so it is an EVENT like the charge setpoint.
//
// ⚠️ It shares id 0x121 with the charge-current command (./charge-setpoint.ts) and is a different
// opcode with a different layout — b3/b4 are ZERO here, where the current-limit frames put a flag
// and a ceiling. That decoder's `b3 === 1` gate is exactly why 0x2C was invisible until now.
//
// Captured pairs, the enter-press correlation, and the on-bike read-back that settled the
// encoding: docs/dash-command-0x2c-charge-limit.md.

import type { DecodedValue } from "./frame.ts";

export const CHARGE_SOC_LIMIT_CAN_ID = 0x121;

/** b0 of the reply. The request-twin form (`| 0x80`) rides on 0x120 — ./charge-soc-command.ts. */
export const CHARGE_SOC_LIMIT_OPCODE = 0x2c;

/** b1 on this whole channel, opcode regardless — a separator, not data. */
const SEPARATOR_BYTE = 0xff;

/** The only range a percentage can occupy. A frame outside it is not this message. */
const MAX_PERCENT = 100;

/**
 * Decodes one 0x121 frame, emitting only for the charge-limit opcode. Pure.
 *
 * Returns nothing for every other opcode on this id, which is the normal case — 0x2C is 3 of the
 * 269 frames on 0x121 in the whole capture archive.
 */
export function decodeChargeSocLimitFrame(data: Buffer): DecodedValue[] {
  if (data.length !== 8 || data[0] !== CHARGE_SOC_LIMIT_OPCODE || data[1] !== SEPARATOR_BYTE) {
    return [];
  }
  // ⚠️ b3-b7 are gated to zero on MEASUREMENT, not on the analogy with 0x18. The three archived
  // dash frames and the four live replies read on 2026-09-19 all carry `2C FF <pct> 00 00 00 00 00`
  // — so unlike 0x18's `3c 01 4b` (which reads as value/min/max, or as flag/ceiling; the archive
  // cannot separate the two), 0x2C states no range at all. A tail in use would mark a different
  // layout on a command id that carries nine opcodes, and showing a fabricated percentage next to
  // "stop charging at" is worse than showing nothing.
  //
  // ⚠️ The price is the direction it fails in: firmware that starts carrying a range here makes
  // this signal go SILENT rather than wrong. If it stops appearing after an update, look here.
  if (data[3] !== 0 || data[4] !== 0 || data[5] !== 0 || data[6] !== 0 || data[7] !== 0) {
    return [];
  }
  const percent = data[2];
  // 0 is LEGAL and means "no limit" — the opposite of ./charge-setpoint.ts, where b2 ≥ 1 because a
  // zero current is the stop command rather than a setting. Only the upper bound is a real gate.
  if (percent > MAX_PERCENT) {
    return [];
  }
  return [{ key: "charge_soc_limit_pct", value: percent }];
}
