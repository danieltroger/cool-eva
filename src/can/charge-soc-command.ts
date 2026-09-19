// Building the SOC charge-limit request — the TRANSMIT counterpart to ./charge-soc-limit.ts,
// which only decodes the reply. Dash command 0x2C on the 0x120/0x121 command channel.
//
// ⚠️ ONE FRAME, on 0x120, and that is the whole protocol. The 0x121 the dash's own menu confirm
// appears to pair with is very likely the BIKE's answer, not a second half we should send:
// injecting a 0x121 spoofs a VCU→dash reply, which is the mechanism behind "the display moved and
// the setpoint did not". Writes on this channel commit on 0x120 alone — proven for the stop
// command, for LPR mode (scripts/lpr-mode.ts, on-bike 2026-08-27), and for this id on 2026-09-19.
//
// Bit 7 of b0 is the direction: SET writes, CLEAR reads. The read is what proves a commit, because
// the VCU answers it with its stored value rather than an echo of the request.
// docs/dash-command-0x2c-charge-limit.md.

import { CHARGE_REQUEST_CAN_ID, REQUEST_TWIN_BIT, SEPARATOR_BYTE, type ChargeFrame } from "./charge-command.ts";
import { CHARGE_SOC_LIMIT_OPCODE, MAX_SOC_LIMIT_PCT } from "./charge-soc-limit.ts";

/**
 * Packs a "stop charging at `percent` %" command into the one frame the bike commits on. Pure.
 *
 * Throws rather than emit a frame outside the range the bike's own menu uses: a percentage byte
 * above 100 is not a percentage, and what a VCU does with one is unknown on a bike we cannot
 * attach a debugger to. `percent = 0` is accepted here because it is a value the dash itself
 * writes ("no limit"); the endpoint above makes the caller confirm that one separately, since it
 * removes the battery protection rather than moving it.
 */
export function buildChargeSocLimitWrite(percent: number): ChargeFrame[] {
  if (!Number.isInteger(percent)) {
    throw new Error(`charge-soc-command: the limit must be a whole percent, got ${percent}`);
  }
  if (percent < 0 || percent > MAX_SOC_LIMIT_PCT) {
    throw new Error(`charge-soc-command: ${percent} % is outside the 0…${MAX_SOC_LIMIT_PCT} this command carries`);
  }
  const request = new Uint8Array(8);
  request[0] = CHARGE_SOC_LIMIT_OPCODE | REQUEST_TWIN_BIT;
  request[1] = SEPARATOR_BYTE;
  request[2] = percent;
  return [{ id: CHARGE_REQUEST_CAN_ID, data: request }];
}

/**
 * Packs the READ request. Pure. Bit 7 is forced clear, which is what makes this non-mutating:
 * two reads of 0x2C on 2026-09-19 returned the same 80 either side of a second, and the reply
 * carried 0x50 where the request carried 0 — so it is the VCU's stored value, not an echo.
 */
export function buildChargeSocLimitRead(): ChargeFrame[] {
  const request = new Uint8Array(8);
  // ⚠️ NOT `| REQUEST_TWIN_BIT`. Setting bit 7 here turns every read-back into a write of
  // whatever b2 happens to hold — which is 0, "no limit". check-charge-soc-limit.ts §2.
  request[0] = CHARGE_SOC_LIMIT_OPCODE;
  request[1] = SEPARATOR_BYTE;
  return [{ id: CHARGE_REQUEST_CAN_ID, data: request }];
}
