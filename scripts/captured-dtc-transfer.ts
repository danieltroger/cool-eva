import { IsoTpReassembler } from "../src/can/iso-tp.ts";
import {
  MODE_PENDING_DTCS,
  MODE_PERMANENT_DTCS,
  MODE_STORED_DTCS,
  decodeObdDtcResponse,
} from "../src/diagnostics/obd-dtc.ts";
import { FREEZE_FRAME_DTC_KEY, recordFreezeFrameDtc, recordTroubleCodeRead } from "../src/diagnostics/stored-codes.ts";
import { record } from "../src/can/signals.ts";

// One real OBD-II trouble-code exchange, kept where two scripts can share it:
// scripts/decode-dtc-response.ts checks the decoders against it, and
// scripts/replay-capture.ts loads it so the Faults tab has something to draw when
// there is no bike. Data only — nothing here talks to a bus.
//
// Captured 2026-08-04 on can0 with the bike keyed on and parked. Frames arrived on
// ID 0x7EF in reply to `01 03` on 0x7DF, with `30 00 00` sent to 0x7E7 after the
// First Frame. Byte-identical across five separate transfers that day.
//
// The `03 7F 00 33` the bike also emits when the flow control goes to 0x7E7 is
// deliberately absent: it answers the flow-control frame rather than the request,
// and knowing to ignore it is the transport's job, not this fixture's.
export const CAPTURED_MODE_03_FRAMES_2026_08_04 = [
  "10 50 43 27 05 62 10 00",
  "21 10 03 05 14 C1 11 C1",
  "22 12 10 04 10 12 10 16",
  "23 10 20 10 21 0A 09 C1",
  "24 10 10 30 90 00 90 02",
  "25 90 04 90 06 90 08 90",
  "26 09 90 12 01 20 01 21",
  "27 0A 07 10 44 10 45 10",
  "28 46 D0 00 06 01 50 03",
  "29 50 06 50 08 50 10 50",
  "2A 12 50 14 50 16 50 17",
  "2B 05 00 C1 21 00 00 00",
];

/** Mode 01 PID 01 read 0xA7 in the same minute: MIL on, 0x27 = 39 stored codes. */
export const CAPTURED_STORED_CODE_COUNT = 39;

/** Mode 01 PID 02 read `05 14` — P0514, the code the lamp is on for. */
export const CAPTURED_FREEZE_FRAME_DTC = 0x0514;

/** Frames as bytes, in arrival order. */
export function capturedFrames(): Uint8Array[] {
  return CAPTURED_MODE_03_FRAMES_2026_08_04.map(parseHexFrame);
}

/**
 * Runs the capture through the real reassembler and returns the payload, or null if
 * it never completed — which for this fixture would mean a reassembler regression.
 */
export function reassembleCapture(): Uint8Array | null {
  const reassembler = new IsoTpReassembler();
  for (const frame of capturedFrames()) {
    const result = reassembler.push(frame);
    if (result.status === "complete") {
      return result.payload;
    }
  }
  return null;
}

/**
 * Loads the capture into the live snapshot, exactly as a real read would — same
 * decoder, same recorder, same signals — so the Faults tab in a replay shows what
 * it shows on the bike.
 *
 * Modes 07 and 0A are filed as `silent` because that is what they actually did:
 * six requests, no reply. Faking an empty list for them would make the replay
 * disagree with the bike about the one distinction that screen exists to make.
 */
export function loadCapturedTroubleCodes(): boolean {
  const payload = reassembleCapture();
  if (!payload) {
    return false;
  }
  recordTroubleCodeRead(
    { outcome: "answered", mode: MODE_STORED_DTCS, response: decodeObdDtcResponse(payload, MODE_STORED_DTCS), payload },
    "stored"
  );
  recordTroubleCodeRead({ outcome: "silent", mode: MODE_PENDING_DTCS }, "pending");
  recordTroubleCodeRead({ outcome: "silent", mode: MODE_PERMANENT_DTCS }, "permanent");
  // Both halves, because on the bike both happen: the PID poller records the signal
  // and then hands the same value to the snapshot (src/can/obd.ts). Doing only the
  // second here would leave freeze_frame_dtc missing from the ALL view in a replay
  // and present on the bike, which is the sort of difference that gets debugged
  // twice before anyone notices it is the fixture.
  record(FREEZE_FRAME_DTC_KEY, CAPTURED_FREEZE_FRAME_DTC);
  recordFreezeFrameDtc(CAPTURED_FREEZE_FRAME_DTC);
  return true;
}

/** "10 50 43" → bytes. Throws rather than guessing, since every caller is a script. */
export function parseHexFrame(text: string): Uint8Array {
  const bytes = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  return Uint8Array.from(bytes, byte => {
    const value = Number.parseInt(byte, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error(`not a hex byte: "${byte}"`);
    }
    return value;
  });
}
