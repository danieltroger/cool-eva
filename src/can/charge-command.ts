// Building the rider's charge-current command — the TRANSMIT counterpart to charge-setpoint.ts,
// which only decodes it. CAN 0x121, the dash↔VCU command channel: opcode 0x18 sets the DC limit
// and 0x1A the AC limit, both putting amps in b2. The byte layout, the b1 = 0xFF separator, the
// b3 = 1 "limit in force" flag and the 1 ≤ b2 ≤ b4 ceiling relation are all lifted verbatim from
// the decode gate in charge-setpoint.ts, so a frame this builds is one decodeChargeSetpointFrame
// would accept — which is the round-trip the check below rests on.
//
// Setting the current is a PAIR, the exact mirror of the stop below: the 0x121 alone moves only
// the dash's DISPLAYED (pending) value, and the 0x120 request-twin (opcode | 0x80) COMMITS it.
// Proven on-bike 2026-09-03 — a 0x121-only inject left charge_limit_a (0x10A, the committed
// setpoint) unmoved while the dash showed the new number; injecting the 0x120+0x121 pair the dash
// itself sends committed it with no key and no dial. So buildChargeCurrentCommand emits BOTH, the
// 0x120 first (~5 ms ahead, as the dash sends them). The field layout: b2 = amps 1:1 for AC (dash
// sent 1a ff 01/02/03 01 0f … for 1/2/3 A), and the AC ceiling in b4 is 0x0f = 15 — the pilot/cable
// rating, NOT ac_supply_limit_a (31), likely charger-specific, so echo the dash's last b4; a wrong
// one makes the VCU reject and fall back to ~10 A. The DC ceiling stays the static 75
// (fast_dc_limit_max_a). The 0x120 twin's tail differs from the 0x121: b3=0/b4=0, not b3=1/b4=ceiling.
// See docs/can-0x121-charge-command.md.
//
// Stopping a charge is a DIFFERENT command, cracked 2026-08-25 by a whole-bus capture of the
// rider's two-press Mode stop: the dash puts a PAIR on the bus — 0x120 `96 ff 01 …` AND 0x121
// `16 ff 01 …` (0x96 = 0x16 | 0x80, the 0x120 request-twin carrying the same opcode with the
// high bit set). But an isolation test that same day settled which half commits: injecting ONLY
// the 0x120 request-twin ENDS the charge on-bike, while injecting only the 0x121 half merely
// armed the "interruption in progress" prompt and never completed. So the commit rides on 0x120;
// the 0x121 companion is redundant, and buildChargeStopCommand emits the single 0x120 frame. See
// docs/can-0x121-charge-command.md § "0x120 ALONE commits".

export const CHARGE_COMMAND_CAN_ID = 0x121;

/** The request-twin id of 0x121. The captured two-press stop put a frame on BOTH at once. */
export const CHARGE_REQUEST_CAN_ID = 0x120;

/** b0 opcodes that carry a current in b2. See charge-setpoint.ts for the other seven on this id. */
const DC_CURRENT_LIMIT_OPCODE = 0x18;
const AC_CURRENT_LIMIT_OPCODE = 0x1a;

/** b1 in all 596 captured frames of both ids, opcode regardless — a separator, not data. */
const SEPARATOR_BYTE = 0xff;

/** b3 = 1 means "a limit is in force"; only the two current-limit opcodes ever set it. */
const LIMIT_IN_FORCE = 1;

/**
 * The high bit that turns a 0x121 command opcode into its 0x120 request-twin — the frame that
 * COMMITS the action on this channel. Both the current-limit pair and the stop pair use it:
 * `0x1A → 0x9A`, `0x16 → 0x96`. docs/can-0x121-charge-command.md.
 */
const REQUEST_TWIN_BIT = 0x80;

/**
 * The stop-charging opcode (b0) as it rides on the 0x120 request-twin: the base `0x16` ORed with
 * REQUEST_TWIN_BIT (`0x96`). b2 = 1, b1 = 0xFF, b3 = 0 (NOT a limit-in-force frame), tail zero.
 * The 0x121 twin (`0x16`) is what the dash pairs with it, but 0x120 alone commits the stop.
 */
const STOP_OPCODE = 0x16;
const STOP_ARG_BYTE = 1;

export type ChargeMode = "ac" | "dc";

/** One frame of a multi-frame command: the id it rides on and its 8 payload bytes. */
export interface ChargeFrame {
  id: number;
  data: Uint8Array;
}

/**
 * Packs a charge-current-limit command into the two frames the dash sends. Pure.
 *
 * Returns the 0x120 request-twin (the COMMIT) FIRST, then the 0x121 command — the order and the
 * pair the dash itself emits ~5 ms apart. The 0x121 alone only moves the dash's pending display;
 * without the 0x120 twin the setpoint never commits (proven on-bike 2026-09-03, see the header).
 *
 * `selectedAmps` is what to ask for; `ceilingAmps` is the b4 the 0x121 pairs with it (the
 * configured maximum — 75 for DC). Both are whole amps. Throws rather than emit a frame the
 * VCU's own decode would reject: 1 ≤ selected ≤ ceiling ≤ 255, which is the exact relation
 * charge-setpoint.ts gates on. A zero request is not "off" — that is the stop command, a
 * different opcode this builder does not make.
 */
export function buildChargeCurrentCommand(mode: ChargeMode, selectedAmps: number, ceilingAmps: number): ChargeFrame[] {
  if (!Number.isInteger(selectedAmps) || !Number.isInteger(ceilingAmps)) {
    throw new Error(`charge-command: amps must be whole numbers, got selected=${selectedAmps} ceiling=${ceilingAmps}`);
  }
  if (ceilingAmps < 1 || ceilingAmps > 255) {
    throw new Error(`charge-command: ceiling ${ceilingAmps} A is outside the 1…255 this frame's byte can hold`);
  }
  if (selectedAmps < 1 || selectedAmps > ceilingAmps) {
    // Below 1 or above the ceiling is a frame the VCU decode drops (charge-setpoint.ts §b2/b4),
    // so sending it could only either do nothing or, worse, be read as some other opcode's layout.
    throw new Error(`charge-command: ${selectedAmps} A must be between 1 and the ceiling ${ceilingAmps} A`);
  }
  const opcode = mode === "dc" ? DC_CURRENT_LIMIT_OPCODE : AC_CURRENT_LIMIT_OPCODE;
  // The 0x120 commit twin: opcode | 0x80, amps in b2, and b3/b4/tail all zero — its layout differs
  // from the 0x121 command, so it is built by hand rather than by flipping a bit on the command.
  const commit = new Uint8Array(8);
  commit[0] = opcode | REQUEST_TWIN_BIT;
  commit[1] = SEPARATOR_BYTE;
  commit[2] = selectedAmps;
  // The 0x121 command: b3 = limit-in-force, b4 = ceiling, b5-7 zero (a tail in use marks a
  // different opcode's layout — charge-setpoint.ts).
  const command = new Uint8Array(8);
  command[0] = opcode;
  command[1] = SEPARATOR_BYTE;
  command[2] = selectedAmps;
  command[3] = LIMIT_IN_FORCE;
  command[4] = ceilingAmps;
  return [
    { id: CHARGE_REQUEST_CAN_ID, data: commit },
    { id: CHARGE_COMMAND_CAN_ID, data: command },
  ];
}

/**
 * Builds the frame that stops an active charge. Pure. Source-agnostic — the SAME frame ends both
 * AC and DC sessions (it emulates the Mode button, which does not care how the bike is charging).
 *
 * It is the single 0x120 request-twin `96 ff 01 …`. The dash pairs it with a 0x121 `16 ff 01 …`,
 * but an on-bike isolation test (2026-08-25) proved the 0x120 half ALONE completes the stop, while
 * 0x121 alone only armed the "interruption in progress" prompt — so the commit is the 0x120 frame.
 * Returns an array of one to match sendChargeStopCommand's multi-frame transmit loop.
 */
export function buildChargeStopCommand(): ChargeFrame[] {
  const request = new Uint8Array(8);
  request[0] = STOP_OPCODE | REQUEST_TWIN_BIT;
  request[1] = SEPARATOR_BYTE;
  request[2] = STOP_ARG_BYTE;
  return [{ id: CHARGE_REQUEST_CAN_ID, data: request }];
}

export interface DecodedChargeCommand {
  mode: ChargeMode;
  selectedAmps: number;
  ceilingAmps: number;
}

/**
 * Unpacks a 0x121 current-limit command back to its fields, or null if the frame is not one.
 *
 * Exists to check buildChargeCurrentCommand in both directions — a builder checked only against
 * its own output proves nothing — and to read a captured 0x121 command without the bit shuffling.
 * The gate mirrors charge-setpoint.ts exactly so "builds a frame the bike accepts" is a real claim.
 */
export function decodeChargeCurrentCommand(frame: Uint8Array): DecodedChargeCommand | null {
  if (frame.length !== 8 || frame[1] !== SEPARATOR_BYTE || frame[3] !== LIMIT_IN_FORCE) {
    return null;
  }
  if (frame[5] !== 0 || frame[6] !== 0 || frame[7] !== 0) {
    return null;
  }
  let mode: ChargeMode;
  if (frame[0] === DC_CURRENT_LIMIT_OPCODE) {
    mode = "dc";
  } else if (frame[0] === AC_CURRENT_LIMIT_OPCODE) {
    mode = "ac";
  } else {
    return null;
  }
  const selectedAmps = frame[2];
  const ceilingAmps = frame[4];
  if (selectedAmps < 1 || selectedAmps > ceilingAmps) {
    return null;
  }
  return { mode, selectedAmps, ceilingAmps };
}
