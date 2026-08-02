// Primitives shared by the frame decoders: the shape they return, and the byte
// readers they read fields with. Split out so decode.ts and decode-bms.ts can both
// use them without either importing the other. `DecodedValue` is the app's single
// declaration of that shape — gps/decode.ts imports it from here too, and the BLE
// path through ble/protocol.ts re-exports it, so there is only one to keep in step.
//
// BE = big-endian pair, LE = little-endian pair.

export interface DecodedValue {
  key: string;
  value: number;
}

export const signedByte = (byte: number): number => (byte > 127 ? byte - 256 : byte);
export const u16be = (hi: number, lo: number): number => (hi << 8) | lo;
export const i16be = (hi: number, lo: number): number => {
  const value = (hi << 8) | lo;
  return value > 32767 ? value - 65536 : value;
};
export const u16le = (lo: number, hi: number): number => (hi << 8) | lo;
// Same two's-complement conversion as i16be with the bytes the other way round, so
// there is only one place to be wrong about the sign bit.
export const i16le = (lo: number, hi: number): number => i16be(hi, lo);
export const bit = (word: number, index: number): number => (word >>> index) & 1;

// Reads a field that does not start or end on a byte boundary, in the bit numbering the
// vehicle (non-BMS) frames use: bit N is byte N>>3, bit N&7, least-significant bit
// first. 0x104 packs a 13-bit speed and a 15-bit rpm back to back, so neither can be
// read as a byte pair. Callers stay under 31 bits, which keeps every shift inside JS's
// signed 32-bit bitwise domain.
export function bitFieldLe(data: Buffer, startBit: number, bitCount: number): number {
  let value = 0;
  for (let offset = 0; offset < bitCount; offset++) {
    const absoluteBit = startBit + offset;
    value |= ((data[absoluteBit >>> 3] >>> (absoluteBit & 7)) & 1) << offset;
  }
  return value;
}
