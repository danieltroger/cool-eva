// The PSU / DC-DC converter's monitor frame, CAN 0x501 `PSU_MONITOR` at 10 Hz.
//
// This was CAN_MAP.md's "best remaining stimulus target" — *"four narrow channels with two
// constant separators"*. There are no separators: it is four little-endian 16-bit channels
// whose high bytes barely move, and Energica's `FramesDB.ParsePSU_MONITOR` names all four
// (the 2024 service-tool analysis in obd-garage/, §`0x501` `PSU_MONITOR`):
//
//   b0-1 LE u16  P_12V     the 12 V rail
//   b2-3 LE u16  P_12VLP   a second, lower rail
//   b4-5 LE u16  P_I12     12 V load current
//   b6-7 LE s16  P_TEMP    left undecoded — see the bottom of this file
//
// Re-derived from this bike's own 2026-08-02 garage lap on 2026-08-16 (4088 frames of 0x501
// in `~/Documents/cool-eva-archive/ride-2026-08-02.log`).

import { type DecodedValue, u16le } from "./frame.ts";

export const PSU_CAN_ID = 0x501;

/** Decodes one 0x501 frame. Pure: bytes in, values out. */
export function decodePsuFrame(data: Buffer): DecodedValue[] {
  if (data.length < 6) return [];
  return [
    { key: "psu_12v_mv", value: u16le(data[0], data[1]) },
    { key: "psu_12v_lowpower_mv", value: u16le(data[2], data[3]) },
    { key: "psu_12v_load_ma", value: u16le(data[4], data[5]) },
  ];
}

// ✅ `P_12V` is the one channel whose scale is nailed independently: it read 12704 over the
// lap (range 12700-12764) against the bike's own engineering menu showing 12.78 V. Millivolts,
// and that is what fixes the shape of the frame — a PSU monitor reporting one rail in mV is
// reporting all of them in the units its siblings imply.
//
// ✅ `P_I12` IS the 12 V load current. Every consumer that switched during the lap shows up as
// a step in the right direction and a sane size, measured here by splitting the 0x501 frames on
// the matching 0x102 bit:
//     high beam (0x102 b0 bit6)   +1788 mA   (n = 13 on / 4075 off)
//     left blinker (b2 bit2)      +1030 mA   (n = 26)
//     brake light  (b2 bits 5/6)   +693 mA   (n = 140)
// Three separate loads, three separate steps, all positive, all of a plausible size for LED
// lighting (21 W / 12 W / 8 W at 12.7 V). Nothing else in the frame does that.
//
// 🟡 The mA SCALE, though, is inference — the manufacturer's dictionary states units for only
// 120 of its 245 signals and this is not one of them. It rests on two things: the sibling rail
// in the same frame being proven millivolts, and the resulting wattages being right for this
// bike's lighting. A different constant would move all three steps together and still look
// plausible, so a clamp meter on the 12 V feed is what would settle it. The full-scale argument
// is worth having too: at mA a u16 tops out at 65.5 A, which is the right order for a
// motorcycle DC-DC; at 0.1 mA it would top out at 6.5 A, below the 10.56 A already measured.
//
// ❓ `P_12VLP` — millivolts by the same argument as `P_12V`, but it reads 9008-9055 mV, i.e.
// ~9.03 V, which is not 12 V whatever "LP" stands for. Logged because it is a direct read of
// PSU health and a rail that drifts is worth seeing; do NOT read the name as a promise about
// what it feeds. It is rock steady across the whole lap, so a real move in it means something.
//
// ⚠️ `P_TEMP` (b6-7) is deliberately NOT decoded. The service tool's dictionary equation for it
// is `f(x)=x*0.1 °C`; the field reads 3900-4000 raw with only five distinct values across 4088
// frames, so that would be 390 °C. It looks like an ADC count (×0.01 would give 39.0-40.0 °C,
// which is at least plausible, and 0x503 b4-5 sits in a 43-46 °C band correlating with it at
// r = +0.945) — but "plausible" is not a decode, and a temperature is exactly the kind of number
// that gets believed. Recording the refutation of the documented equation so nobody implements
// it from the dictionary.
