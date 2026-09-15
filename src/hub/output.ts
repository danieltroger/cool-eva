// Connectivity-Hub message type 3 — the drive triple, shared by both transports.
//
// The same 8-byte record arrives over BLE (../ble/protocol.ts) and on CAN 0x410
// (../can/hub-output.ts), so the unpacking lives here once rather than twice. Only
// the arithmetic is shared: the two callers map it onto different signal keys,
// because this project keeps a CAN-sourced value and its BLE twin comparable
// rather than merged.
//
// ⚠️ The INSTRUMENT CLUSTER builds this record, not the hub — it is synthesised
// from the cluster's own variables rather than forwarded (docs/can-0x410.md), so
// the hub is the BLE transport for it and not its author.

import { i16le, u16le } from "../can/frame.ts";
import { FRAME_SIZE } from "../gps/decode.ts";

export const HUB_OUTPUT_TYPE = 3;

export interface HubOutput {
  /**
   * b2-b3. NOT `speed_can_kmh`: a different divisor, ~+4.3 %. docs/can-0x410.md.
   *
   * Only the CAN caller logs it, as `dash_speed_kmh`. The BLE caller decodes it and
   * drops it on purpose — one producer writing one key down two transports is the
   * thing this project keeps apart, and BLE already has no key for it.
   */
  speedKmh: number;
  torqueNm: number;
  /** Torque × rpm. The rpm itself has no reader, so it stays a local below. */
  powerKw: number;
}

/**
 * Is this one of type 3's records? Sub-index 0xFF is the only one it uses.
 *
 * ⚠️ The LENGTH test belongs here, not in a caller. A predicate shared by both transports
 * carries it — `isDiagnosticsMessage` and `GpsMessageDecoder.decode` both do — while the
 * BLE-only ones (`isSeedFrame`) omit it, because the reassembler upstream has already
 * re-sliced to FRAME_SIZE. On CAN nothing guarantees that, and a short frame read without
 * this yields NaN out of decodeHubOutput.
 */
export function isHubOutputFrame(frame: Uint8Array): boolean {
  return frame.length >= FRAME_SIZE && frame[0] === HUB_OUTPUT_TYPE && frame[1] === 0xff;
}

/**
 * Unpacks one type-3 record. Pure — bytes in, values out.
 *
 * ⚠️ `revolutionsPerMinute` is read SIGNED although the cluster zero-extends its own
 * copy. That is deliberate and is not an oversight to tidy up: the authority for the
 * hub's wire protocol is the Android app's CommParser, which reads it signed, and the
 * cluster's choice of `lhz` over `lha` at 0x62648 decides the type of a local, not of
 * the byte on the bus. The two agree on every value the bike can produce — rpm peaks
 * near 6 900 against a 32 768 sign boundary.
 */
export function decodeHubOutput(frame: Uint8Array): HubOutput {
  const revolutionsPerMinute = i16le(frame[4], frame[5]);
  const torqueNm = i16le(frame[6], frame[7]);
  return {
    speedKmh: u16le(frame[2], frame[3]),
    torqueNm,
    powerKw: (torqueNm * 2 * Math.PI * revolutionsPerMinute) / 60000,
  };
}
