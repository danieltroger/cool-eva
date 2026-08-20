import { ExtendedIsoTpReassembler, maxFramesFor } from "../diagnostics/extended-iso-tp.ts";
import {
  TESTER_ADDRESS,
  buildFlowControlFrame,
  parseFlowControlFrame,
  segmentRequestPayload,
  toHex,
  type VcuFlowControl,
} from "./multiframe-codec.ts";
import type { VcuTarget } from "./param-codec.ts";

// One multi-frame request/reply window on the VCU micros' custom-KWP channel.
//
// The transport half of ./multiframe-codec.ts: it owns the socket, the clock and the
// timers, and nothing else. It holds no session — ./kwp-client.ts does that, and drives one
// of these per request — and it decodes nothing.
//
// ⚠️ THE FLOW CONTROL WE SEND KEEPS THE READ-ONLY PROPERTY INTACT. ./param-codec.ts claims
// "no transmit address is ever derived from something the bus said"; that survives, because
// `buildFlowControlFrame` addresses the target the CALLER named and this module never reads
// an address out of a received frame.
//
// ⚠️ NOTHING MAY SIT BETWEEN A FIRST FRAME AND ITS ANSWER. Measured on this bike's OBD
// channel 2026-08-04: delaying the flow control on purpose gave 4/12 completed transfers at
// 0 ms, 5/12 at 10 ms, 3/12 at 20 ms and 1/12 at 40 ms. So it goes out synchronously from
// the frame handler, before the frame is even decoded — and `handleFrame` below must stay
// callable straight off the CAN listener.
//
// ⚠️ AND IT MUST NOT STARVE THE OBD POLLER. The micros answer on 0x7E0, inside the range
// the 2 Hz mode-01 poller reads, so `handleFrame` returns false for every frame that is not
// part of this transfer and the caller hands it on. Nothing here loops or blocks; every
// wait is a timer. docs/vcu-parameters.md §10.

/** How one multi-frame exchange ended. Resolves; nothing here rejects. */
export type MultiFrameResult =
  /** A whole reply arrived. `payload` excludes the address and every PCI byte. */
  | { kind: "payload"; payload: Uint8Array; sawFlowControlFromMicro: boolean }
  /**
   * Nothing came back inside the window. `stage` says which window, because they
   * are different claims: silence after the request may be an expired session,
   * silence after a First Frame is a stalled transfer, and silence where a flow
   * control was expected is a micro that never agreed to hear the rest.
   */
  | { kind: "timeout"; stage: TransferStage }
  /**
   * The reply was unusable and has been discarded — a sequence gap, a Consecutive
   * Frame that under-filled, a declared length over the cap, too many frames.
   *
   * ⚠️ Kept strictly apart from `payload`. Completing a transfer at its declared
   * length from a short Consecutive Frame is exactly the bug a review caught in
   * the freeze-frame decoder: every later field shifts, `trailingHex` comes out
   * empty, and the answer looks perfect and is wrong.
   */
  | { kind: "abandoned"; reason: string }
  /** Never reached the bus — our socket, not the bike. */
  | { kind: "not-sent"; reason: string }
  /** The caller stopped it: a cancel, a shutdown, or the service gate closing. */
  | { kind: "cancelled"; reason: string };

/** Which window a timeout happened in. */
export type TransferStage =
  /** Waiting for the micro to agree to hear the rest of a multi-frame REQUEST. */
  | "request-flow-control"
  /** Waiting for the first frame of the reply. */
  | "first-reply"
  /** Waiting for the rest of a reply whose First Frame has arrived. */
  | "reply-transfer";

export interface MultiFrameTransferOptions {
  /** Which micro. Decides the address byte on every frame we send, including flow control. */
  target: VcuTarget;
  /** The request, already built and service-checked by ./multiframe-codec.ts. */
  requestPayload: Uint8Array;
  /** Puts one 8-byte frame on the bus. Throws on a dead socket, which becomes `not-sent`. */
  send: (frame: Uint8Array) => void;
  /**
   * Largest reply payload to assemble. Bounds what a stuck or hostile responder
   * can make us hold, and is passed through to the reassembler so its frame cap
   * is derived from the same number.
   */
  maxPayloadBytes: number;
  /** How long to wait for the first frame of the reply. */
  firstReplyTimeoutMs: number;
  /** How long to wait for the rest, once a First Frame has arrived. */
  transferTimeoutMs: number;
  /**
   * How long to wait for the micro's flow control before sending the rest of a
   * multi-frame REQUEST. Only ever used by `0x35`.
   */
  requestFlowControlTimeoutMs: number;
}

/** A transfer in flight. */
export interface RunningMultiFrameTransfer {
  /**
   * Feed one received CAN frame. True when it was consumed, so a caller sharing
   * the socket knows not to look at it as well.
   *
   * Safe to call straight off the CAN listener, and it must be: the flow-control
   * answer to a First Frame goes out from inside here.
   */
  handleFrame: (data: Buffer) => boolean;
  /** How it ended. Resolves exactly once. */
  finished: Promise<MultiFrameResult>;
  /** Ends it now with `cancelled`. Safe to call after it has already settled. */
  cancel: (reason: string) => void;
}

/**
 * How many frames that contribute NOTHING to a payload one exchange may absorb.
 *
 * The only such frame a well-behaved micro sends is a flow control answering our
 * `0x35` — one of them, or a few if it says WAIT first. 16 is generous for that
 * and still a hard bound on a micro that only ever says WAIT.
 */
const FLOW_CONTROL_FRAME_ALLOWANCE = 16;

/**
 * Ceiling on frames handled in one exchange, over and above the reassembler's own cap.
 *
 * The reassembler bounds frames that CONTRIBUTE to a payload. This bounds the ones that do
 * not: a micro repeating flow-control frames — which the reassembler deliberately ignores,
 * so nothing there counts them — would otherwise keep this alive doing nothing until the
 * timer saved us. This is the cheaper guard.
 *
 * ⚠️ DERIVED from the payload cap rather than fixed. As a constant the two caps only stayed
 * ordered while the payload cap was small, and a caller that raised it past ~380 bytes
 * would have seen a legitimate long reply abandoned as "more than 64 frames in one
 * exchange" — a true statement about the wrong number. docs/vcu-parameters.md §10.
 */
function maxFramesPerExchange(maxPayloadBytes: number): number {
  return maxFramesFor(maxPayloadBytes) + FLOW_CONTROL_FRAME_ALLOWANCE;
}

/**
 * Starts one multi-frame exchange and sends the first frame of the request.
 *
 * The request goes out before this returns, so the caller can register
 * `handleFrame` and be sure it did not miss a reply — the same ordering
 * ./kwp-client.ts' `exchange` relies on.
 */
export function startMultiFrameTransfer(options: MultiFrameTransferOptions): RunningMultiFrameTransfer {
  const context: TransferContext = {
    options,
    reassembler: new ExtendedIsoTpReassembler(options.maxPayloadBytes),
    outstandingRequestFrames: [],
    consecutiveFramesUntilNextFlowControl: 0,
    separationTimeMs: 0,
    sawFlowControlFromMicro: false,
    sawStrayFlowControl: false,
    framesHandled: 0,
    settled: false,
    settle: () => {},
    timer: null,
    pacer: null,
  };
  const finished = new Promise<MultiFrameResult>(resolve => {
    context.settle = resolve;
  });

  const frames = segmentRequestPayload(options.target, options.requestPayload);
  context.outstandingRequestFrames = frames.slice(1);

  if (!transmit(context, frames[0])) {
    return { handleFrame: () => false, finished, cancel: () => {} };
  }
  if (context.outstandingRequestFrames.length === 0) {
    armTimer(context, options.firstReplyTimeoutMs, "first-reply");
  } else {
    // A multi-frame request: the micro is supposed to answer the First Frame with
    // a flow control of its own before we send the rest. See `onRequestFlowControlTimeout`
    // for what happens when it does not, and why.
    armTimer(context, options.requestFlowControlTimeoutMs, "request-flow-control");
  }

  return {
    handleFrame: data => handleFrame(context, data),
    finished,
    cancel: reason => settle(context, { kind: "cancelled", reason }),
  };
}

interface TransferContext {
  options: MultiFrameTransferOptions;
  reassembler: ExtendedIsoTpReassembler;
  /** Consecutive Frames of the REQUEST still to send, in order. Empty for a single-frame request. */
  outstandingRequestFrames: Uint8Array[];
  /** How many more may go out before the micro wants another flow control. 0 means unlimited. */
  consecutiveFramesUntilNextFlowControl: number;
  /** The gap the micro asked for between our Consecutive Frames. */
  separationTimeMs: number;
  /**
   * The micro answered one of OUR multi-frame requests with a flow control. This
   * is the answer to the open question and rides out on the result; it is set only
   * where request frames were actually outstanding.
   */
  sawFlowControlFromMicro: boolean;
  /** A flow control arrived with nothing outstanding. Logged, not reported as the above. */
  sawStrayFlowControl: boolean;
  framesHandled: number;
  settled: boolean;
  settle: (result: MultiFrameResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** The paced send of our own Consecutive Frames, so a cancel can stop it mid-request. */
  pacer: ReturnType<typeof setTimeout> | null;
}

function handleFrame(context: TransferContext, data: Buffer): boolean {
  if (context.settled) {
    return false;
  }
  if (data.length < 2 || data[0] !== TESTER_ADDRESS) {
    // Not addressed to us. Handed back BEFORE the frame budget is touched, and
    // that ordering is the point: this transport shares the 0x7E0–0x7EF range
    // with the 2 Hz OBD poller, so counting frames that are not ours would let
    // ambient traffic exhaust the budget and abandon a perfectly good transfer.
    // The bug that reads as "the bike scrambled a reply" when the bus was merely
    // busy.
    return false;
  }
  const frameBudget = maxFramesPerExchange(context.options.maxPayloadBytes);
  if (context.framesHandled >= frameBudget) {
    settle(context, { kind: "abandoned", reason: `more than ${frameBudget} frames in one exchange` });
    return true;
  }
  context.framesHandled += 1;

  // Flow control is checked FIRST and separately, because the reassembler
  // deliberately ignores it — under this framing a flow-control frame is ours to
  // send, and the one case where one arrives for us is the micro answering the
  // `0x35` request's First Frame. That is a frame the reassembler would hand back
  // as "not ours", and it is very much ours.
  const flowControl = parseFlowControlFrame(data);
  if (flowControl) {
    return handleFlowControlFromMicro(context, flowControl);
  }

  const result = context.reassembler.push(data);
  switch (result.status) {
    case "flow-control-required":
      // Synchronously, before anything else happens. See the timing note in the
      // header: 20 ms of delay measurably cost transfers on this bike.
      if (!transmit(context, buildFlowControlFrame(context.options.target))) {
        return true;
      }
      armTimer(context, context.options.transferTimeoutMs, "reply-transfer");
      return true;
    case "incomplete":
      return true;
    case "complete":
      settle(context, {
        kind: "payload",
        payload: result.payload,
        sawFlowControlFromMicro: context.sawFlowControlFromMicro,
      });
      return true;
    case "abandoned":
      // Acted on rather than remembered, unlike src/can/obd-dtc.ts which lets the
      // window run its course. The difference is what an abandonment MEANS here:
      // that module has only ever seen silence after a First Frame, so a sequence
      // gap there is hypothetical and waiting is the cheaper guess. Here the
      // commonest abandonment is a Consecutive Frame that under-filled — a real
      // bug this repo has already shipped once — and continuing to wait would let
      // the NEXT frame's bytes land at the wrong offset if the transfer resumed.
      settle(context, { kind: "abandoned", reason: result.reason });
      return true;
    case "ignored":
      // Another tester's traffic, a mode-01 reply on the same id range, or a
      // Consecutive Frame from a transfer we are not following. Handed back so the
      // OBD poller still sees it.
      return false;
    default:
      return false;
  }
}

function handleFlowControlFromMicro(context: TransferContext, flowControl: VcuFlowControl): boolean {
  if (context.outstandingRequestFrames.length === 0) {
    // A flow control with nothing left to send. Consumed rather than handed on —
    // it is addressed to the tester and no other reader on this socket wants it —
    // but it changes nothing.
    //
    // ⚠️ And it deliberately does NOT set `sawFlowControlFromMicro`. That flag is
    // the evidence for the one genuinely open question about this channel — does
    // A8 answer a multi-frame REQUEST with a flow control? — and every `0x36` in a
    // 1198-block read is a single-frame request with nothing outstanding. Counting
    // a stray frame here would answer that question "yes" from a transfer that
    // never asked it. The log line below is how a stray one is reported instead.
    //
    // Logged ONCE per transfer, not once per frame. A micro that repeats these is
    // bounded only by the frame budget, and dozens of identical lines in the
    // journal would bury whatever else went wrong in the same second.
    if (!context.sawStrayFlowControl) {
      console.log(`vcu: flow control from ${context.options.target} with no request frames outstanding, ignoring`);
    }
    context.sawStrayFlowControl = true;
    return true;
  }
  context.sawFlowControlFromMicro = true;
  switch (flowControl.status) {
    case "clear-to-send":
      // ⚠️ The window this timer was guarding has CLOSED — the micro answered. It
      // must be cleared here and not only on the branches that re-arm it, because
      // the ordinary pacing branch of `sendNextRequestFrame` re-arms nothing: a
      // separation time longer than the timer's remainder would let
      // `onRequestFlowControlTimeout` fire mid-send, warn that no flow control
      // came when one just did — on the one question this transfer exists to
      // settle — and then discard the separation time the micro had asked for.
      if (context.timer !== null) {
        clearTimeout(context.timer);
        context.timer = null;
      }
      context.consecutiveFramesUntilNextFlowControl = flowControl.blockSize;
      context.separationTimeMs = flowControl.separationTimeMs;
      // A second clear-to-send arriving while the first one's paced send is still
      // running would otherwise leave two chains walking the same queue. `shift()`
      // makes that harmless rather than duplicating a frame, but it would send
      // faster than the separation time the micro just asked for — which is the one
      // thing it asked for.
      if (context.pacer !== null) {
        clearTimeout(context.pacer);
        context.pacer = null;
      }
      sendNextRequestFrame(context);
      return true;
    case "wait":
      // Re-arm rather than give up: WAIT means another flow control is coming.
      // Bounded by the same timer, so a micro that only ever says WAIT still ends.
      armTimer(context, context.options.requestFlowControlTimeoutMs, "request-flow-control");
      return true;
    case "overflow":
      settle(context, {
        kind: "abandoned",
        reason: `${context.options.target} answered our request with flow-control OVERFLOW — it cannot hold the request`,
      });
      return true;
    case "unrecognised":
      settle(context, {
        kind: "abandoned",
        reason: `flow control with undefined status 0x${flowControl.flowStatus.toString(16)}`,
      });
      return true;
  }
}

/**
 * What to do when the micro never answers our request's First Frame.
 *
 * ⚠️ A judgement call, and it deserves to be read before it is trusted: NO flow-control
 * frame has ever been captured on this channel in either direction, so whether A8 emits one
 * before the `0x35` Consecutive Frames is genuinely unknown.
 *
 * So on a timeout the remaining frames go out anyway, loudly. The frames themselves are
 * close to inert — a Consecutive Frame carries PCI `0x2N` and no service byte at all, so a
 * micro not in a receive state either discards it as ISO-TP noise or draws a refusal.
 * Neither outcome writes anything, and `sawFlowControlFromMicro` rides out on the result so
 * the first live run settles it. The full argument: docs/vcu-parameters.md §10.
 */
function onRequestFlowControlTimeout(context: TransferContext): void {
  console.warn(
    `vcu: ${context.options.target} sent no flow control for our ${context.options.requestPayload.length}-byte ` +
      `request within ${context.options.requestFlowControlTimeoutMs} ms — sending the remaining ` +
      `${context.outstandingRequestFrames.length} consecutive frame(s) unprompted. ` +
      "See onRequestFlowControlTimeout in src/vcu/multiframe-transfer.ts for why that is the chosen guess."
  );
  context.consecutiveFramesUntilNextFlowControl = 0;
  context.separationTimeMs = 0;
  sendNextRequestFrame(context);
}

/**
 * Sends one Consecutive Frame of our own request, then schedules the next.
 *
 * Scheduled rather than looped even when the separation time is zero: a
 * `setTimeout(0)` between frames returns to the event loop, which is what keeps
 * the WebSocket, the CAN RX handler and the OBD poller running while a request
 * goes out. Only ever two frames today, but ./freeze-frame-log.ts sends 1198
 * requests through this same path.
 */
function sendNextRequestFrame(context: TransferContext): void {
  if (context.settled || context.outstandingRequestFrames.length === 0) {
    return;
  }
  const frame = context.outstandingRequestFrames.shift();
  if (!frame || !transmit(context, frame)) {
    return;
  }
  if (context.outstandingRequestFrames.length === 0) {
    // The request is out. Now wait for the reply.
    armTimer(context, context.options.firstReplyTimeoutMs, "first-reply");
    return;
  }
  if (context.consecutiveFramesUntilNextFlowControl > 0) {
    context.consecutiveFramesUntilNextFlowControl -= 1;
    if (context.consecutiveFramesUntilNextFlowControl === 0) {
      // The micro asked to be consulted again after this many frames. Unreachable
      // with today's 12-byte request and a BlockSize of anything but 1, and here
      // so that a larger request later cannot silently overrun a micro that meant
      // it.
      armTimer(context, context.options.requestFlowControlTimeoutMs, "request-flow-control");
      return;
    }
  }
  context.pacer = setTimeout(() => sendNextRequestFrame(context), context.separationTimeMs);
}

/** Puts one frame on the bus. False when it did not go, in which case the transfer has settled. */
function transmit(context: TransferContext, frame: Uint8Array): boolean {
  try {
    context.options.send(frame);
    return true;
  } catch (err) {
    // Loud: a bus that will not take an 8-byte frame is a much bigger problem than
    // this transfer, and on this Pi it usually means can0 went down under us.
    console.error(`vcu: sending ${toHex(frame)} to ${context.options.target} failed`, err);
    settle(context, { kind: "not-sent", reason: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function armTimer(context: TransferContext, ms: number, stage: TransferStage): void {
  if (context.timer !== null) {
    clearTimeout(context.timer);
  }
  context.timer = setTimeout(() => {
    if (stage === "request-flow-control") {
      onRequestFlowControlTimeout(context);
      return;
    }
    settle(context, { kind: "timeout", stage });
  }, ms);
}

function settle(context: TransferContext, result: MultiFrameResult): void {
  if (context.settled) {
    return;
  }
  context.settled = true;
  if (context.timer !== null) {
    clearTimeout(context.timer);
    context.timer = null;
  }
  if (context.pacer !== null) {
    clearTimeout(context.pacer);
    context.pacer = null;
  }
  context.reassembler.reset();
  context.settle(result);
}
