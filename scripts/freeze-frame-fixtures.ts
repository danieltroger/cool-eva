import { parseHexFrame } from "./captured-dtc-transfer.ts";

// Freeze-frame transfers for scripts/check-freeze-frame.ts. Data only — nothing
// here talks to a bus.
//
// ── ⚠️ THESE ARE CONSTRUCTED, NOT CAPTURED. THE NAME OF THE FILE SAYS SO. ───
// scripts/captured-dtc-transfer.ts holds a REAL 2026-08-04 candump, byte for byte, and
// that is why the checks built on it prove something about the bike. This file cannot
// make that claim. The REAL `0x17` payloads are now in scripts/captured-freeze-frames.ts
// — all 29 of them — and the note that used to stand here, saying none had ever been
// recorded, was wrong: it searched `7C0`, which carries only requests. Replies are on
// `7E0`. What survives here is two complete transfers whose values are INVENTED to reach
// decode paths no capture does — a zero-current open circuit, a negative int16 and int8,
// the ×0.1 scaling, the `(X/2)-40` air temperature — plus the malformed shapes the bike
// never sent: a refusal, a wrong-component answer, a short CF mid-transfer. The second
// group is checked frame by frame rather than replayed as transfers.
//
// The two invented frames below also DISAGREE with the real ones, which is worth knowing
// before trusting them for anything else: component 44 really answered 18 bytes with
// status 0x07, not 17 with 0x05, and component 4 answered status 0x25, not 0x2D.
// Both are also a byte SHORT — 17 and 16 against the real 18 and 17 — because they were
// built with no trailing byte, the one part of the layout no constructed fixture could
// have guessed. That is the concrete form of the warning above: these frames satisfy
// every assertion about a layout that turned out to be missing a field.
//
// So what the check verifies is INTERNAL CONSISTENCY: that the decoder reproduces the
// layout src/diagnostics/freeze-frame.ts documents, applies Energica's own scalings to
// Energica's own field widths, and rejects the malformed shapes. ⚠️ IF THE LAYOUT IS
// WRONG, EVERY ASSERTION HERE STILL PASSES and the bike still tells us something
// different. That is the honest limit of this fixture, and it is why `trailingHex`
// exists.
//
// How these were built, which two faults were chosen and why the invented VALUES are
// the ones they are: docs/diagnostics-and-checks.md §11.3.

/**
 * Component 44 symptom 0 — `P0A07`, water pump open circuit, per
 * src/diagnostics/dtc-table.ts. This bike's own standing fault: the coolant pump
 * is wired to the heated-grip output, so the VCU's pump driver sits open.
 *
 * Fields are infokeys [1, 47, 58, 61, 62, 63, 11] = 12 bytes, so 17 bytes of
 * payload. `ai_WaterPumpCurrent_In` reads 0 mA, which is exactly what that open
 * driver measures and is the whole reason to want this frame: the VCU's own
 * open-circuit threshold is 400 mA and a healthy pump draws 750–1150 mA.
 *
 * Status `0x05` — symptom 0 in the high nibble, activity 2 (memory / freeze
 * frame), stored, and the lamp bit CLEAR, because dtc-table.ts records P0A07 as
 * not lighting the MIL. A fixture whose flags contradicted the table would be a
 * small lie that the check would then happily enforce.
 */
export const FREEZE_FRAME_P0A07_COMPONENT = 44;
export const FREEZE_FRAME_P0A07_FRAMES = [
  "F1 10 11 57 01 00 2C 05",
  "F1 20 03 00 00 00 02 01",
  "F1 21 9C 01 95 01 8E 6C",
];

/**
 * Component 4 symptom 2 — `P0514`, the code the lamp is on for.
 *
 * Fields are infokeys [1, 2, 6, 7, 8, 9, 10, 11] = 11 bytes, so 16 of payload.
 * Motor stopped, pack at 345.2 V drawing 1.8 A, one pack sensor at −1 °C against
 * the other at 24 °C — a spread that is itself consistent with the fault.
 */
export const FREEZE_FRAME_P0514_COMPONENT = 4;
export const FREEZE_FRAME_P0514_FRAMES = [
  "F1 10 10 57 01 00 04 2D",
  "F1 20 02 00 00 0D 7C FF",
  "F1 21 EE 18 FF 57 6E 00",
];

/**
 * What the P0514 frame must decode to, field by field.
 *
 * Written out rather than recomputed from the same table the decoder reads, so
 * the check compares against numbers a human wrote down. Deriving the expectation
 * from `INFOKEY_TABLE` would make the assertion pass for any consistent-but-wrong
 * reading of the same table — which is the failure mode worth guarding against
 * when the fixture is constructed rather than captured.
 */
export const FREEZE_FRAME_P0514_EXPECTED: readonly { name: string; raw: number; value: number; unit: string }[] = [
  { name: "VEHICLE_SUBSTATE", raw: 2, value: 2, unit: "" },
  { name: "D_MOTOR_SPD", raw: 0, value: 0, unit: "rpm" },
  { name: "B_PACK_V", raw: 3452, value: 345.2, unit: "V" },
  // Negative int16, then scaled. Reading this unsigned gives 6551.8 V.
  { name: "B_PACK_I", raw: -18, value: -1.8, unit: "A" },
  { name: "B_H_TEMP", raw: 24, value: 24, unit: "°C" },
  // Negative int8. Reading this unsigned gives 255 °C.
  { name: "B_L_TEMP", raw: -1, value: -1, unit: "°C" },
  { name: "B_SOC", raw: 87, value: 87, unit: "%" },
  // (X/2)-40 — the one field whose equation uses a capital X.
  { name: "V_AIR_TEMP", raw: 110, value: 15, unit: "°C" },
];

/**
 * A refusal. `7F 17 31` — requestOutOfRange, which is what a component with no
 * stored freeze frame would plausibly answer. Must decode as a refusal, never as
 * an empty frame: "no freeze frame" and "the micro would not say" are different
 * claims, the same distinction src/diagnostics/stored-codes.ts exists to protect.
 */
export const FREEZE_FRAME_REFUSAL_FRAME = "F1 03 7F 17 31";

/**
 * A frame answering component 4 when component 44 was asked about. Must be
 * reported as a mismatch, not decoded — its bytes are perfectly well-formed and
 * would produce a plausible P0514 freeze frame filed under the pump.
 */
export const FREEZE_FRAME_WRONG_COMPONENT_FRAMES = FREEZE_FRAME_P0514_FRAMES;

/** Frames as bytes, in arrival order. */
export function freezeFrameBytes(frames: readonly string[]): Uint8Array[] {
  return frames.map(parseHexFrame);
}
