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
export const bit = (word: number, index: number): number => (word >>> index) & 1;
