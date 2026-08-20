import { ExtendedIsoTpReassembler } from "../src/diagnostics/extended-iso-tp.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";

// The 29 freeze-frame replies the VCU actually sent, from capture-20260808-182129
// on 2026-08-08. Byte for byte, PCI bytes included — nothing here is constructed.
//
// These were missed once already. An earlier note in scripts/freeze-frame-fixtures.ts
// said no `0x17` payload had ever been recorded, because the search looked at `7C0`.
// `7C0` carries only requests: byte 0 is the addressed component, A8 or A9, on all
// 26 662 of them. Replies come back on `7E0` with byte 0 = F1, the tester. Both
// directions of a KWP session are NOT on one id here, and assuming they were is what
// hid 29 real payloads for long enough to build a fixture in their place.
//
// Component 60 is the only Single Frame — its shortlist is empty, so its reply is
// 6 bytes and fits. The other 28 are First Frame + Consecutive Frames, which is why
// A8 sends 1227 First Frames for 1198 `0x36` blocks + 28 of these + 1 `0x18`.
//
// Layout, confirmed against all 29: `57 <recordCount> <DTC-hi> <DTC-lo> <status>`,
// then the fault's infokey fields in payload order, then ONE trailing byte whose
// meaning is not known. See docs/diagnostics-and-checks.md §11.3.1.

export interface CapturedFreezeFrame {
  readonly component: number;
  readonly symptom: number;
  readonly frames: readonly string[];
}

/** Every `0x17` reply in the capture, ordered by component. */
export const CAPTURED_FREEZE_FRAMES: readonly CapturedFreezeFrame[] = [
  {
    component: 3,
    symptom: 0,
    frames: ["F1 10 11 57 01 00 03 05", "F1 20 21 00 00 00 00 00", "F1 21 00 00 00 00 88 06"],
  },
  {
    component: 4,
    symptom: 2,
    frames: ["F1 10 11 57 01 00 04 25", "F1 20 3E 00 00 0B 8F FF", "F1 21 FE 23 1B 3C 8B 03"],
  },
  {
    component: 5,
    symptom: 0,
    frames: [
      "F1 10 13 57 01 00 05 05",
      "F1 20 21 00 00 00 00 00",
      "F1 21 00 00 00 18 00 80",
      "F1 22 88 06 00 00 00 00",
    ],
  },
  {
    component: 6,
    symptom: 0,
    frames: [
      "F1 10 13 57 01 00 06 05",
      "F1 20 65 00 00 0B B1 FF",
      "F1 21 FF 10 00 10 00 80",
      "F1 22 89 0B 00 00 00 00",
    ],
  },
  {
    component: 7,
    symptom: 0,
    frames: [
      "F1 10 14 57 01 00 07 05",
      "F1 20 0C 22 26 0A 5E FC",
      "F1 21 8D 1C 2F 0C BB 0D",
      "F1 22 1B 71 3D 00 00 00",
    ],
  },
  {
    component: 8,
    symptom: 3,
    frames: [
      "F1 10 13 57 01 00 08 35",
      "F1 20 00 00 00 00 00 00",
      "F1 21 00 00 00 00 00 00",
      "F1 22 00 06 00 00 00 00",
    ],
  },
  {
    component: 10,
    symptom: 2,
    frames: ["F1 10 0D 57 01 00 0A 25", "F1 20 52 00 00 01 00 2E", "F1 21 F0 01 00 00 00 00"],
  },
  {
    component: 11,
    symptom: 2,
    frames: ["F1 10 0D 57 01 00 0B 25", "F1 20 52 00 00 01 00 2E", "F1 21 F0 01 00 00 00 00"],
  },
  {
    component: 12,
    symptom: 3,
    frames: ["F1 10 0D 57 01 00 0C 35", "F1 20 96 00 00 00 00 2F", "F1 21 88 02 00 00 00 00"],
  },
  {
    component: 20,
    symptom: 1,
    frames: [
      "F1 10 12 57 01 00 14 15",
      "F1 20 33 0E 11 01 97 01",
      "F1 21 00 00 00 74 00 00",
      "F1 22 05 00 00 00 00 00",
    ],
  },
  {
    component: 22,
    symptom: 0,
    frames: [
      "F1 10 14 57 01 00 16 05",
      "F1 20 00 00 00 00 00 00",
      "F1 21 00 00 00 00 00 00",
      "F1 22 00 88 08 00 00 00",
    ],
  },
  {
    component: 34,
    symptom: 0,
    frames: ["F1 10 0F 57 01 00 22 05", "F1 20 52 00 00 00 00 05", "F1 21 10 00 B3 09 00 00"],
  },
  {
    component: 35,
    symptom: 0,
    frames: ["F1 10 0F 57 01 00 23 05", "F1 20 52 00 00 00 00 05", "F1 21 10 00 B3 0B 00 00"],
  },
  {
    component: 36,
    symptom: 0,
    frames: ["F1 10 0F 57 01 00 24 05", "F1 20 3E 00 86 00 01 31", "F1 21 B0 0A 90 FF 00 00"],
  },
  {
    component: 37,
    symptom: 0,
    frames: ["F1 10 0F 57 01 00 25 05", "F1 20 3E 00 87 00 01 31", "F1 21 B0 0A 94 76 00 00"],
  },
  {
    component: 39,
    symptom: 0,
    frames: ["F1 10 0F 57 01 00 27 05", "F1 20 52 00 00 00 00 05", "F1 21 10 00 B3 29 00 00"],
  },
  {
    component: 40,
    symptom: 0,
    frames: ["F1 10 0F 57 01 00 28 05", "F1 20 52 00 00 00 00 05", "F1 21 10 00 B3 17 00 00"],
  },
  {
    component: 41,
    symptom: 0,
    frames: [
      "F1 10 17 57 01 00 29 05",
      "F1 20 52 00 00 00 03 00",
      "F1 21 04 00 0D 00 03 00",
      "F1 22 03 00 03 00 00 12",
    ],
  },
  {
    component: 42,
    symptom: 0,
    frames: [
      "F1 10 17 57 01 00 2A 05",
      "F1 20 52 00 00 00 01 00",
      "F1 21 01 00 02 00 01 00",
      "F1 22 02 00 02 00 00 12",
    ],
  },
  {
    component: 44,
    symptom: 0,
    frames: [
      "F1 10 12 57 01 00 2C 07",
      "F1 20 16 00 00 FF FC 01",
      "F1 21 5D 01 5D 01 5D 89",
      "F1 22 FF 00 00 00 00 00",
    ],
  },
  {
    component: 46,
    symptom: 0,
    frames: [
      "F1 10 14 57 01 00 2E 05",
      "F1 20 64 1D 1D 0D 05 00",
      "F1 21 07 01 3D 10 56 10",
      "F1 22 69 87 24 00 00 00",
    ],
  },
  {
    component: 48,
    symptom: 0,
    frames: ["F1 10 10 57 01 00 30 05", "F1 20 16 31 C0 23 44 08", "F1 21 6E 0A B2 74 10 00"],
  },
  {
    component: 49,
    symptom: 0,
    frames: ["F1 10 11 57 01 00 31 05", "F1 20 3E 47 0E 73 0F 65", "F1 21 0F 24 44 43 89 16"],
  },
  {
    component: 51,
    symptom: 0,
    frames: [
      "F1 10 1A 57 01 00 33 05",
      "F1 20 3F 13 13 64 0D B6",
      "F1 21 4C 2F 0A E6 FF FD",
      "F1 22 0D C8 0D 9D 00 02",
      "F1 23 AA 89 FF 00 00 00",
    ],
  },
  {
    component: 52,
    symptom: 0,
    frames: [
      "F1 10 14 57 01 00 34 05",
      "F1 20 00 09 87 80 03 B2",
      "F1 21 03 85 00 0E 01 4A",
      "F1 22 0B 3B FF 00 00 00",
    ],
  },
  {
    component: 53,
    symptom: 4,
    frames: ["F1 10 0A 57 01 00 35 45", "F1 20 FF FF FF FF 07 00"],
  },
  {
    component: 54,
    symptom: 11,
    frames: ["F1 10 0B 57 01 00 36 B5", "F1 20 22 0A 00 00 00 FF"],
  },
  {
    component: 60,
    symptom: 0,
    frames: ["F1 06 57 01 00 3C 05 FF"],
  },
  {
    component: 62,
    symptom: 0,
    frames: ["F1 10 0D 57 01 00 3E 05", "F1 20 52 00 00 06 C4 00", "F1 21 C0 01 00 00 00 00"],
  },
];

/**
 * Reassembled payload for one captured reply, PCI bytes stripped.
 *
 * Deliberately the PRODUCTION reassembler and not a local one. A hand-rolled version
 * here concatenated frames in arrival order and never looked at the sequence numbers
 * or the address byte — so renumbering every CF 0-based to 1-based, the exact mistake
 * PR #98 was about, left these fixtures passing. Now that mutation fails.
 */
export function capturedFreezeFramePayload(entry: CapturedFreezeFrame): Uint8Array {
  const reassembler = new ExtendedIsoTpReassembler();
  let result;
  for (const frame of entry.frames) {
    result = reassembler.push(parseHexFrame(frame));
  }
  if (!result || result.status !== "complete") {
    throw new Error(
      `captured-freeze-frames: component ${entry.component} did not reassemble (${result?.status ?? "no frames"})`
    );
  }
  return result.payload;
}
