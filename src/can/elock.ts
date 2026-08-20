import type { RawChannel } from "socketcan";
import { record } from "./signals.ts";

// One-shot read of "number of keys paired" from the E-LOCK / keyless ECU. Plain
// KWP2000 over ISO-TP single frames, request on 0x791 and response on 0x790; the
// framing is in docs/can-decode-findings.md § "0x480". The bare read is tried
// first, and a diagnostic session is only opened (then closed immediately) if the
// ECU won't answer without one.
//
// ⚠️ This is the IMMOBILIZER ECU, so this module is deliberately minimal:
//   • it runs ONCE at startup, never on a timer and never in a retry loop;
//   • the only services it may ever send are 0x21 (ReadDataByLocalIdentifier),
//     0x10 0x81 (start diagnostic session) and 0x20 (stop diagnostic session).
//     Nothing that writes, resets or runs a routine (0x2E / 0x27 / 0x31 / 0x11 /
//     0x14 / 0x3B) belongs here;
//   • it is fully non-fatal — a timeout or a negative response just skips the
//     signal and logs a line. It never throws and never blocks app startup.

const ELOCK_REQ_ID = 0x791;
export const ELOCK_RESP_ID = 0x790;

const SERVICE_READ_BY_LOCAL_ID = 0x21;
const SERVICE_START_SESSION = 0x10;
const SERVICE_STOP_SESSION = 0x20;
const KEYS_PAIRED_LOCAL_ID = 0x99;
const STANDARD_SESSION = 0x81;

const NEGATIVE_RESPONSE_SID = 0x7f;
const POSITIVE_RESPONSE_OFFSET = 0x40;
const RESPONSE_TIMEOUT_MS = 300;

let pendingResponse: { resolve: (data: Buffer | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;

// Fire-and-forget: call this once at startup. Resolves whatever happens.
export async function readKeysPairedOnce(channel: RawChannel): Promise<void> {
  try {
    // 1) Bare read first — least intrusive, and this ECU usually answers it.
    let keysPaired = await readKeysPaired(channel);

    // 2) Only if that gave us nothing: open a standard diagnostic session,
    //    re-read, then close the session again straight away.
    if (keysPaired === null) {
      const sessionResponse = await request(channel, [SERVICE_START_SESSION, STANDARD_SESSION]);
      if (positiveResponsePayload(sessionResponse, SERVICE_START_SESSION) !== null) {
        keysPaired = await readKeysPaired(channel);
        await request(channel, [SERVICE_STOP_SESSION]);
      }
    }

    if (keysPaired === null) {
      console.log("elock: no usable response to 21 99 — skipping keys_paired");
      return;
    }
    record("keys_paired", keysPaired);
    console.log(`elock: keys_paired = ${keysPaired}`);
  } catch (err) {
    // Belt and braces — nothing above should throw, and a failure here must
    // never take the app down.
    console.error("elock: read failed — continuing without keys_paired", err);
  }
}

// Returns true if this frame was an E-LOCK diagnostic response we consumed.
export function isElockResponse(id: number): boolean {
  return id === ELOCK_RESP_ID;
}

export function handleElockResponse(data: Buffer): void {
  const waiting = pendingResponse;
  if (!waiting) return;
  pendingResponse = null;
  clearTimeout(waiting.timer);
  waiting.resolve(data);
}

// Sends one single-frame KWP request and waits for the reply. Resolves null on
// timeout or send failure — never rejects.
function request(channel: RawChannel, payload: number[]): Promise<Buffer | null> {
  return new Promise(resolve => {
    const frame = Buffer.alloc(8); // zero padding
    frame[0] = payload.length;
    Buffer.from(payload).copy(frame, 1);

    const timer = setTimeout(() => {
      pendingResponse = null;
      resolve(null);
    }, RESPONSE_TIMEOUT_MS);
    pendingResponse = { resolve, timer };

    try {
      channel.send({ id: ELOCK_REQ_ID, ext: false, rtr: false, data: frame });
    } catch (err) {
      clearTimeout(timer);
      pendingResponse = null;
      console.error("elock: send failed", err);
      resolve(null);
    }
  });
}

// Positive reply to service X is [len][X + 0x40][data…]; a negative one is
// [len][0x7F][X][NRC]. Returns the data bytes, or null for anything else.
function positiveResponsePayload(response: Buffer | null, service: number): Buffer | null {
  if (!response || response.length < 2) return null;
  const payload = response.subarray(1, 1 + response[0]);
  if (payload.length < 1) return null;
  if (payload[0] === NEGATIVE_RESPONSE_SID) {
    const negativeResponseCode = payload[2] ?? 0;
    console.log(
      `elock: negative response to service 0x${service.toString(16)} (NRC 0x${negativeResponseCode.toString(16)})`
    );
    return null;
  }
  if (payload[0] !== service + POSITIVE_RESPONSE_OFFSET) return null;
  return payload.subarray(1);
}

async function readKeysPaired(channel: RawChannel): Promise<number | null> {
  const response = await request(channel, [SERVICE_READ_BY_LOCAL_ID, KEYS_PAIRED_LOCAL_ID]);
  const payload = positiveResponsePayload(response, SERVICE_READ_BY_LOCAL_ID);
  // KWP 0x21 answers `61 <localId> <data…>` — the identifier is echoed back, so
  // the value starts one byte after it. Reading payload[0] yields the echo
  // (0x99 = 153), not the count.
  if (!payload || payload.length < 2 || payload[0] !== KEYS_PAIRED_LOCAL_ID) return null;
  return payload[1];
}
