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

// ✅ `P_12V` is the one channel whose scale is nailed independently: 12704 over the lap against
// the bike's own engineering menu showing 12.78 V. Millivolts — and that fixes the shape of the
// whole frame, since a PSU monitor reporting one rail in mV reports all of them that way.
//
// ✅ `P_I12` IS the 12 V load current: high beam, blinker and brake light each show up as a
// step in the right direction and a plausible size (+1788, +1030 and +693 mA, i.e. 21/12/8 W).
// 🟡 The mA SCALE itself is inference — a different constant would move all three steps
// together and still look plausible, so a clamp meter on the 12 V feed is what would settle it.
//
// ❓ `P_12VLP` reads ~9.03 V, which is not 12 V whatever "LP" stands for. Logged because it is
// a direct read of PSU health, but do NOT read the name as a promise about what it feeds.

// ⚠️ `P_TEMP` (b6-7) is deliberately NOT decoded: the vendor's own `f(x)=x*0.1 °C` gives 390 °C
// on this bike. ×0.01 would be plausible — and "plausible" is not a decode, on exactly the kind
// of number that gets believed. The refutation is recorded so nobody implements the dictionary
// equation: docs/can-decode-findings.md § "0x501 — PSU_MONITOR".
