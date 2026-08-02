// GPS on CAN id 0x410. The Connectivity Hub puts its BLE telemetry framing on the
// bus verbatim — the same 8-byte records, byte 0 = message type, byte 1 = sub-index
// — so the shared decoder in src/gps/decode.ts reads them unchanged.
//
// Measured over 40 s parked (2026-08-02): 72 × `1A 00`, 72 × `1A 01`, 72 × `1A FE`
// (~1.8 Hz each), 73 × `00 FF` seed heartbeat, plus the vehicle-status (02) and
// odometer (04) replies our own BLE client asks for every 10 s. The hub keeps
// seeding on CAN even while an authorised BLE session is up, which says this is
// its own unconditional broadcast rather than a mirror of the BLE link.
//
// The decoder instance lives here rather than in decode.ts because a fix is split
// over three sub-frames and therefore needs state across them, while decode.ts is
// deliberately stateless. One instance is correct: one hub, one bus.

import { GpsMessageDecoder } from "../gps/decode.ts";
import type { DecodedValue } from "./frame.ts";

export const GPS_CAN_ID = 0x410;

const busGpsDecoder = new GpsMessageDecoder();

/** Non-GPS frames on 0x410 (seed, vehicle status, odometer) decode to nothing. */
export function decodeGpsCanFrame(data: Buffer): DecodedValue[] {
  return busGpsDecoder.decode(data);
}
