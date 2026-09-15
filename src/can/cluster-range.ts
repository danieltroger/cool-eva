import { type DecodedValue, u16le } from "./frame.ts";

// CAN 0x412 — the instrument cluster's range estimate, 2 Hz.
//
// Only b2-b3 is decoded. b0 is a state byte, b1 moves at the frame rate, and b6 is
// an unidentified quantity whose source and divisor are known but whose meaning is
// not; b4/b5 have been constant in everything measured. Why b6 is NOT shipped even
// under the standing "decode everything" rule, and the identification of b2-b3:
// docs/can-0x412.md.

export const CLUSTER_RANGE_CAN_ID = 0x412;

/** Decodes one 0x412 frame. Pure: bytes in, values out. */
export function decodeClusterRangeFrame(data: Buffer): DecodedValue[] {
  if (data.length < 8) {
    return [];
  }
  return [{ key: "range_can_km", value: u16le(data[2], data[3]) }];
}
