// Primitives shared by the CAN frame decoders: the shape they return, and the byte
// readers they read fields with. Split out so decode.ts and decode-bms.ts can both
// use them without either importing the other.
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
export const i16le = (lo: number, hi: number): number => {
  const value = (hi << 8) | lo;
  return value > 32767 ? value - 65536 : value;
};
export const bit = (word: number, index: number): number => (word >>> index) & 1;

// Reads a field that isn't byte-aligned, in the bit numbering the vehicle frames
// use: bit N lives in byte N>>3 at bit N&7, least-significant bit first. 0x104
// packs its 13-bit speed and 15-bit RPM back to back that way, so neither can be
// read with a byte pair. Callers stay under 31 bits — wide enough for every field
// on the bus, and it keeps the shifts inside JS's signed 32-bit bitwise domain.
export const bitsLe = (data: Buffer, startBit: number, bitCount: number): number => {
  let value = 0;
  for (let offset = 0; offset < bitCount; offset++) {
    const absoluteBit = startBit + offset;
    value |= ((data[absoluteBit >>> 3] >>> (absoluteBit & 7)) & 1) << offset;
  }
  return value;
};
