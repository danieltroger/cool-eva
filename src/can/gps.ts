// GPS on CAN id 0x410. The Connectivity Hub puts its BLE telemetry framing on the
// bus verbatim — the same 8-byte records, byte 0 = message type, byte 1 = sub-index
// — so the shared decoder in src/gps/decode.ts reads them unchanged.
//
// Measured over 40 s parked (2026-08-02): 72 × `1A 00`, 72 × `1A 01`, 72 × `1A FE`
// (~1.8 Hz each), 73 × `00 FF` seed heartbeat, plus the vehicle-status (02) and
// odometer (04) replies our own BLE client asks for every 10 s.
//
// This is the hub's own broadcast, not a mirror of whatever it happens to be
// sending a connected phone: with the cool-eva service stopped and therefore no
// BLE session at all, 30 s of the same capture still carried 58 × `1A 00`, 58 ×
// `1A 01`, 58 × `1A FE` and 59 × `00 FF`. Position on CAN does not depend on the
// Bluetooth link being up, which is the whole point of reading it here.
//
// The decoder instance lives here rather than in decode.ts because a fix is split
// over three sub-frames and therefore needs state across them, while decode.ts is
// deliberately stateless. One instance is correct: one hub, one bus.

import { GpsMessageDecoder } from "../gps/decode.ts";
import type { DecodedValue } from "./frame.ts";

export const GPS_CAN_ID = 0x410;

let busGpsDecoder = new GpsMessageDecoder();

/**
 * How many suppressed fixes we have already complained about, so a hub that has
 * genuinely stopped sending a coordinate sub-frame says so once rather than at
 * 1.8 Hz. Reset with the decoder.
 */
let reportedSuppressedFixes = 0;

/**
 * A handful at the start of a stream is normal — the first time sub-frame can
 * arrive before either coordinate one. A hub that is really only sending half a
 * position keeps climbing past this within seconds.
 */
const SUPPRESSED_FIX_COMPLAINT_THRESHOLD = 20;

/** Non-GPS frames on 0x410 (seed, vehicle status, odometer) decode to nothing. */
export function decodeGpsCanFrame(data: Buffer): DecodedValue[] {
  const values = busGpsDecoder.decode(data);
  // The decoder is pure and cannot complain for itself, so the transport does it.
  // Before 2026-08-16 this condition had no symptom at all: a missing coordinate
  // sub-frame was silently filled in from the last one, which is how rides.db
  // ended up with single-sample position jumps of 21 km.
  if (busGpsDecoder.suppressedFixes - reportedSuppressedFixes >= SUPPRESSED_FIX_COMPLAINT_THRESHOLD) {
    reportedSuppressedFixes = busGpsDecoder.suppressedFixes;
    console.warn(
      `gps: ${busGpsDecoder.suppressedFixes} fixes suppressed — the hub is sending time but not both ` +
        "coordinate sub-frames, so position is being withheld rather than blended from a stale half"
    );
  }
  return values;
}

/**
 * Drops the latched half-fix. Nothing in the running service calls this — one hub,
 * one bus, one decoder for the life of the process. It exists so replaying two
 * captures through decodeFrame() in one process starts the second from a clean
 * slate, instead of the first capture's latched coordinates and fix carrying over
 * and making the "no stale position" guard look like it held when it never ran.
 */
export function resetGpsCanDecoder(): void {
  busGpsDecoder = new GpsMessageDecoder();
  reportedSuppressedFixes = 0;
}
