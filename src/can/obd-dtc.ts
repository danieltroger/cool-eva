import type { RawChannel } from "socketcan";
import { IsoTpReassembler } from "./iso-tp.ts";
import { monotonicNow, since } from "../monotonic.ts";
import {
  MODE_PENDING_DTCS,
  MODE_PERMANENT_DTCS,
  MODE_STORED_DTCS,
  decodeObdDtcResponse,
  describeNegativeResponseCode,
  type ObdDtcResponse,
} from "../diagnostics/obd-dtc.ts";

// The transport half of reading trouble codes over OBD-II: send the request, drive
// the ISO-TP reassembler, answer a First Frame with flow control, give up on time.
// Decoding lives in src/diagnostics/obd-dtc.ts and reassembly in ./iso-tp.ts, both
// pure; this module is the only part that touches the bus or the clock.
//
// ⚠️ READ-ONLY BY CONSTRUCTION. The only service bytes this module can put on the
// bus are 0x03, 0x07 and 0x0A — all three are "tell me what is wrong", none of them
// changes anything in an ECU, and requestTroubleCodeList() throws on anything else
// rather than trusting its caller. Mode 04 (clear DTCs) is deliberately absent and
// must stay absent: it would erase the very history this exists to read, and on a
// bike whose stored list has been accumulating since before we started looking that
// is not recoverable. SecurityAccess (0x27) is likewise absent. Same standing rule
// as src/can/elock.ts keeps for the immobilizer ECU.
//
// ── What the bus actually does, measured 2026-08-04 ──────────────────────────────
//
// The request goes out functionally on 0x7DF; the VCU answers on **0x7EF**, not the
// 0x7E8 a car would use. Mode 03's reply is 80 bytes, so it arrives as a First
// Frame plus eleven Consecutive Frames with a flow-control frame from us in between:
//
//   →  7DF  01 03 00 00 00 00 00 00     one payload byte: service 03
//   ←  7EF  10 50 43 27 05 62 10 00     First Frame, 0x050 = 80 bytes to come
//   →  7E7  30 00 00 00 00 00 00 00     our flow control: send it all, no delay
//   ←  7EF  21 10 03 05 14 C1 11 C1     … eleven of these, ~5 ms apart
//
// ⚠️ THE FLOW-CONTROL FRAME DRAWS A SPURIOUS NEGATIVE RESPONSE, and misreading it
// is what made this look impossible. Sent to 0x7E7 — the physical request address
// paired with the 0x7EF the VCU answers on — *something* on the bus replies
// `03 7F 00 33`: a refusal of "service 0x00" with NRC 0x33 securityAccessDenied.
// There is no service 0x00 and we never sent one; it is an artefact of an ECU
// reading our flow-control frame as a request. It arrives whether or not the
// transfer then succeeds — transfers that completed produced it too. So a negative
// response naming a service we did not ask for is IGNORED here rather than ending
// the wait. obd-garage/CAN_MAP.md recorded that NRC as mode 03 being locked behind
// SecurityAccess; it never was, and the note there is now dated and corrected.
//
// ⚠️ THE TRANSFER IS NOT RELIABLE, and the failure mode is always the same: the
// First Frame arrives, we answer it, and the Consecutive Frames never come. It is
// never a refusal and never a partial payload — it is all 80 bytes or nothing.
// Measured per-attempt success, sharing the bus with the 2 Hz mode-01 poller:
//
//   flow control → 0x7E7   2/8, 7/10, 7/10, and 4-5/12 across the latency sweep
//   flow control → 0x7DF   2/8, 5/10
//   no flow control        0/8, 0/5   ← so the flow control is genuinely required
//
// Somewhere between 25 % and 70 % per attempt, run to run, with no input of ours
// that reliably moves it. Deliberately not dressed up as better than that: three
// separate runs of ten-plus attempts disagree with each other, so retries are the
// only honest answer and RETRY_ATTEMPTS is sized for the low end.
//
// One input does measurably matter, in the bad direction. Delaying the flow control
// on purpose gave 4/12 at 0 ms, 5/12 at 10 ms, 3/12 at 20 ms and 1/12 at 40 ms — so
// the VCU's patience runs out fast, and NOTHING here may sit between the First Frame
// and its answer. The flow control is sent synchronously from the frame handler,
// before the frame is even decoded. Seen from the other side: a completed transfer
// had ZERO mode-01 replies interleaved and a failed one 50+, i.e. it finishes inside
// one gap in the poller's own traffic or it does not finish at all.

const OBD_FUNCTIONAL_REQUEST_ID = 0x7df;

/** Frames on the OBD response range, which is where every reply we care about lands. */
const OBD_RESPONSE_LO = 0x7e0;
const OBD_RESPONSE_HI = 0x7ef;

/** The physical request half of that range — the only IDs this module may transmit on. */
const PHYSICAL_REQUEST_LO = 0x7e0;
const PHYSICAL_REQUEST_HI = 0x7e7;

/**
 * Where the flow-control frame goes: the physical request address paired with the
 * ID the reply came in on (0x7EF ⇒ 0x7E7), per ISO 15765-2 — a functionally
 * addressed request is answered physically, and the flow control belongs on that
 * physical channel. Sending it functionally to 0x7DF also works and avoids the
 * spurious NRC above, but it measured no better and shouts the frame at every ECU
 * on the bus instead of at the one talking to us.
 */
const FLOW_CONTROL_ID_OFFSET = -8;

/** Flow control: ClearToSend, BlockSize 0 (send it all), STmin 0 (no delay). */
const FLOW_CONTROL_FRAME = [0x30, 0x00, 0x00];

/**
 * How long to wait for the FIRST frame of a reply. Every First Frame we have ever
 * seen arrived 23-70 ms after the request, so 300 ms is ~4× the worst case — and
 * this is the timeout a mode that answers nothing at all pays, once per attempt.
 * Keeping it well below the transfer budget is what stops modes 07 and 0A costing
 * the mode-01 poller a second of blind time every read.
 */
const FIRST_REPLY_TIMEOUT_MS = 300;

/**
 * How long to wait for the rest, once a First Frame has arrived. Every completed
 * transfer ran 79-110 ms from First Frame to last Consecutive Frame, so 400 ms is
 * ~4× the observed worst case — and a stalled one has never later recovered, so
 * spending longer here only lengthens the retry cycle.
 */
const TRANSFER_TIMEOUT_MS = 400;

/**
 * Extra tries when a transfer starts and then stalls. Five attempts at the pessimistic
 * end of the measured range (~33 %) is ~87 %; at the optimistic end (70 %) it is
 * essentially certain. Cost when every one of them stalls is ~2.8 s, which is
 * affordable because this runs once a minute and because speed and rpm also arrive
 * on CAN 0x104 at 100 Hz — the dashboard is not blind while it runs.
 *
 * Only a stall is retried, never silence: six attempts have already established that
 * modes 07 and 0A answer nothing, and hammering a bus shared with the ABS and the
 * BMS to establish it a seventh time is not a trade worth making.
 */
const RETRY_ATTEMPTS = 4;

/**
 * Breather between attempts. The VCU has just abandoned an ISO-TP transfer it
 * thinks is still open, and firing the next request into that is both impolite to
 * a bus we share with the brakes and the likeliest way to keep it stuck.
 */
const RETRY_GAP_MS = 120;

export type DtcReadOutcome =
  /** A reply arrived and decoded. `response` may still be a refusal. */
  | { outcome: "answered"; mode: number; response: ObdDtcResponse; payload: Uint8Array }
  /** The question reached the bus and nothing came back. NOT "there are no codes". */
  | { outcome: "silent"; mode: number }
  /** A First Frame arrived and the rest never did. Distinct from silence. */
  | { outcome: "truncated"; mode: number; reason: string }
  /**
   * The question never reached the bus — our socket, not the bike.
   *
   * Kept apart from `silent` because they are claims about different things, and
   * only one of them is about the VCU. `can0` goes down whenever the service
   * restarts (CLAUDE.md), so a send that throws is a thing that happens; filing it
   * as "no response" would put our own dead socket on the dashboard as the bike
   * refusing to answer.
   */
  | { outcome: "not-sent"; mode: number; reason: string };

interface InFlightRequest {
  mode: number;
  reassembler: IsoTpReassembler;
  channel: RawChannel;
  settle: (result: DtcReadOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sawFirstFrame: boolean;
  failure: string | null;
}

let inFlight: InFlightRequest | null = null;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Reads one trouble-code list — mode 0x03 stored, 0x07 pending or 0x0A permanent.
 * Resolves whatever happens; it never rejects, and a bike that says nothing is an
 * ordinary outcome rather than an error.
 *
 * Not safe to call concurrently with itself, and it says so rather than trying: one
 * transfer is followed at a time, and a second request on 0x7DF is exactly what
 * makes the VCU abandon the first.
 */
export async function requestTroubleCodeList(channel: RawChannel, mode: number): Promise<DtcReadOutcome> {
  if (mode !== MODE_STORED_DTCS && mode !== MODE_PENDING_DTCS && mode !== MODE_PERMANENT_DTCS) {
    // Defence in depth against a future caller. Nothing that writes to an ECU may
    // ever reach the bus through this module.
    throw new Error(`obd-dtc: mode 0x${mode.toString(16)} is not a read-only trouble-code service`);
  }
  if (inFlight) {
    const reason = `a mode 0x${inFlight.mode.toString(16)} read was still running`;
    console.warn(`obd-dtc: mode 0x${mode.toString(16)} skipped — ${reason}`);
    // `not-sent`, not `silent`: nothing was put on the bus, so the bike has not
    // declined to answer anything.
    return { outcome: "not-sent", mode, reason };
  }

  let result: DtcReadOutcome = { outcome: "silent", mode };
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    const startedAt = monotonicNow();
    result = await attemptRead(channel, mode);
    if (result.outcome !== "truncated") {
      return result;
    }
    console.log(
      `obd-dtc: mode 0x${mode.toString(16)} stalled after ${Math.round(since(startedAt))} ms ` +
        `(${result.reason}) — attempt ${attempt + 1} of ${RETRY_ATTEMPTS + 1}`
    );
    if (attempt < RETRY_ATTEMPTS) {
      await sleep(RETRY_GAP_MS);
    }
  }
  return result;
}

/** Is this a frame this module might want? Same range the mode-01 poller uses. */
function isTroubleCodeResponseId(id: number): boolean {
  return id >= OBD_RESPONSE_LO && id <= OBD_RESPONSE_HI;
}

/**
 * Feeds one CAN frame to the transfer in progress. Returns true if the frame was
 * consumed, so the mode-01 poller in obd.ts knows not to look at it as well.
 *
 * Everything that is not part of our transfer is handed straight back rather than
 * dropped: mode-01 replies land in the same ID range, and swallowing one would
 * stall that poller for a whole timeout.
 */
export function handleTroubleCodeFrame(id: number, data: Buffer): boolean {
  const request = inFlight;
  if (!request || !isTroubleCodeResponseId(id) || !addressesService(request.mode, data)) {
    return false;
  }

  const result = request.reassembler.push(data);
  switch (result.status) {
    case "flow-control-required":
      // Sent before anything else happens, deliberately. See the timing note above:
      // the VCU's patience here is short enough that a 20 ms delay measurably cost
      // us transfers, so nothing may come between this frame and its answer.
      sendFlowControl(request.channel, id);
      request.sawFirstFrame = true;
      armTimer(request, TRANSFER_TIMEOUT_MS);
      return true;
    case "incomplete":
      return true;
    case "complete":
      settle(request, {
        outcome: "answered",
        mode: request.mode,
        response: decodeObdDtcResponse(result.payload, request.mode),
        payload: result.payload,
      });
      return true;
    case "abandoned":
      // Remembered rather than acted on. This means a sequence gap, which has never
      // actually been seen on this bus — every observed failure was silence after
      // the First Frame, not scrambled frames — so what a real one does next is
      // unknown, and letting the window run its course is the cheaper guess than
      // giving up on a transfer that might still finish. Either way the reason ends
      // up in the `truncated` result and in the journal.
      request.failure = result.reason;
      return true;
    default:
      return false;
  }
}

/** One request, one response window. Resolves; never rejects. */
function attemptRead(channel: RawChannel, mode: number): Promise<DtcReadOutcome> {
  return new Promise<DtcReadOutcome>(resolve => {
    const request: InFlightRequest = {
      mode,
      reassembler: new IsoTpReassembler(),
      channel,
      settle: resolve,
      timer: setTimeout(() => expire(request), FIRST_REPLY_TIMEOUT_MS),
      sawFirstFrame: false,
      failure: null,
    };
    inFlight = request;

    // `01 <mode>` — a single frame carrying one payload byte, zero-padded.
    const frame = Buffer.alloc(8);
    frame[0] = 0x01;
    frame[1] = mode;
    try {
      channel.send({ id: OBD_FUNCTIONAL_REQUEST_ID, ext: false, rtr: false, data: frame });
    } catch (err) {
      console.error(`obd-dtc: send of mode 0x${mode.toString(16)} failed`, err);
      // Ours, not the bike's — see the `not-sent` note on DtcReadOutcome.
      settle(request, { outcome: "not-sent", mode, reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

function expire(request: InFlightRequest): void {
  if (!request.sawFirstFrame) {
    settle(request, { outcome: "silent", mode: request.mode });
    return;
  }
  settle(request, {
    outcome: "truncated",
    mode: request.mode,
    reason: request.failure ?? "no consecutive frames after the first frame",
  });
}

function armTimer(request: InFlightRequest, ms: number): void {
  clearTimeout(request.timer);
  request.timer = setTimeout(() => expire(request), ms);
}

function settle(request: InFlightRequest, result: DtcReadOutcome): void {
  if (inFlight !== request) return;
  inFlight = null;
  clearTimeout(request.timer);
  request.reassembler.reset();
  request.settle(result);
}

/**
 * Does this frame belong to the service we asked for?
 *
 * Consecutive Frames carry no service id at all, so they are accepted on the
 * strength of a transfer being open — which is the only state this function is
 * called in. Single and First Frames have to name the right service.
 */
function addressesService(mode: number, data: Buffer): boolean {
  if (data.length < 2) {
    return false;
  }
  const pci = data[0] >> 4;
  if (pci === 0x2) {
    return true;
  }
  // A First Frame spends byte 1 on the low half of the length, so its service id is
  // one byte further along than a Single Frame's.
  const service = pci === 0x1 ? data[2] : data[1];
  if (service === mode + 0x40) {
    return true;
  }
  // A refusal counts only when it names the service we asked for. The `7F 00 33`
  // our own flow control provokes names service 0x00, so it falls through here and
  // is left on the bus as what it is: noise.
  if (service === 0x7f && data.length >= 3) {
    return (pci === 0x1 ? data[3] : data[2]) === mode;
  }
  return false;
}

function sendFlowControl(channel: RawChannel, responseId: number): void {
  const flowControlId = responseId + FLOW_CONTROL_ID_OFFSET;
  // The rest of this module is read-only by construction rather than by argument,
  // and this is the one place that derives a transmit ID from a received one. A
  // First Frame arriving on 0x7E0..0x7E7 — the request half of the range that
  // isTroubleCodeResponseId accepts — would put the flow control on 0x7D8..0x7DF,
  // and 0x7DF is the functional broadcast every ECU on the bus reads as a request.
  // Unlikely rather than impossible, which is exactly what a guard is for.
  if (flowControlId < PHYSICAL_REQUEST_LO || flowControlId > PHYSICAL_REQUEST_HI) {
    console.warn(
      `obd-dtc: refusing flow control to 0x${flowControlId.toString(16)} — outside the physical request range`
    );
    return;
  }
  const frame = Buffer.alloc(8);
  Buffer.from(FLOW_CONTROL_FRAME).copy(frame);
  try {
    channel.send({ id: flowControlId, ext: false, rtr: false, data: frame });
  } catch (err) {
    // Not fatal — the transfer then times out as `truncated`, which is exactly what
    // it is. Loud, because a bus that will not take a 3-byte frame is a problem far
    // bigger than this module.
    console.error(`obd-dtc: flow control to 0x${flowControlId.toString(16)} failed`, err);
  }
}

/** A read outcome as one log line, in the same vocabulary the dashboard uses. */
export function describeReadOutcome(result: DtcReadOutcome): string {
  const mode = `mode 0x${result.mode.toString(16).padStart(2, "0")}`;
  if (result.outcome === "silent") {
    return `${mode}: NO RESPONSE — which is not the same claim as “no codes”`;
  }
  if (result.outcome === "not-sent") {
    return `${mode}: never asked — ${result.reason}`;
  }
  if (result.outcome === "truncated") {
    return `${mode}: transfer started and stalled — ${result.reason}`;
  }
  const { response } = result;
  if (response.kind === "negative") {
    return `${mode}: refused, NRC ${describeNegativeResponseCode(response.negativeResponseCode)}`;
  }
  if (response.kind === "unrecognised") {
    return `${mode}: unrecognised reply — ${response.reason}`;
  }
  const mismatch = response.truncated ? ` (count byte said ${response.declaredCount})` : "";
  return `${mode}: ${response.codes.length} ${response.list} code(s)${mismatch}`;
}
