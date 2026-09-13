import type { RawChannel } from "socketcan";
import type { ArrivalLatency, FrameArrival } from "../can/frame-arrival.ts";
import { monotonicNow, since } from "../monotonic.ts";
import {
  KWP_REQUEST_CAN_ID,
  KWP_RESPONSE_CAN_ID,
  buildRequestFrame,
  buildRequestPayload,
  canIdsFor,
  decodeParameterReply,
  identifierFor,
  identifierForIndex,
  isSessionOpened,
  parseResponseFrame,
  type VcuAddressedFrame,
  type VcuRequest,
  type VcuTarget,
} from "./param-codec.ts";
import { CALIBRATION_BANK, type VcuMicro } from "./param-table.ts";
import {
  decodeMultiFrameReply,
  encodeMultiFrameRequestPayload,
  expectedResponseService,
  type VcuMultiFrameReply,
  type VcuMultiFrameRequest,
} from "./multiframe-codec.ts";
import {
  startMultiFrameTransfer,
  type MultiFrameResult,
  type RunningMultiFrameTransfer,
  type TransferStage,
} from "./multiframe-transfer.ts";

// The transport half of reading VCU calibration parameters: put a frame on the bus, wait
// for the reply, keep the diagnostic session alive, give up on time. Every byte it sends is
// built by ./param-codec.ts or ./multiframe-codec.ts and every byte it receives is
// interpreted there — this file holds only the socket, the clock and the session state.
//
// ⚠️ READ-ONLY, structurally. It cannot express a write. Every byte reaching `channel.send`
// was built by one of TWO encoders — `buildRequestPayload` (./param-codec.ts, three members,
// three service bytes) or `encodeMultiFrameRequestPayload` (./multiframe-codec.ts, five and
// five) — each a closed union with a throwing default and an allowlist re-check on the
// emitted byte. A caller names an operation and a target, never a service byte, and there is
// nowhere to put a value. `0x31`, `0x2E`, `0x3B`, `0x14`, `0x11`, `0x27`, `0x2F` and `0x34`
// are unreachable from this client.
//
// ⚠️ A parameter read is carried by the SAME transport as the five multi-frame services, so
// a record too wide for one frame is assembled rather than refused. That changed no request
// byte: `segmentRequestPayload` on a 3-byte `22 hi lo` emits the identical Single Frame
// `buildRequestFrame` did. What it changed is the reply side, and the outcomes below.
//
// ⚠️ It SENDS FLOW-CONTROL FRAMES, and the property that mattered is preserved rather than
// spent: **no transmit address is ever derived from something the bus said.**
//
// ⚠️ IT DOES NOT CONFIGURE can0. `bringUpCan` downs the interface when the link is not
// already as it wants it, killing every other raw-CAN socket on the Pi including the running
// service's. This client only opens a channel on one that is already up, so it cannot rescue
// a listen-only bus — which is why ./read-runner.ts refuses a sweep when OBD_ENABLED=0.
//
// ⚠️ The micros answer NOTHING until a session is open, `10 81`, and it auto-closes after
// ~2.5 s idle — hence SESSION_IDLE_LIMIT_MS. A8 and A9 hold SEPARATE sessions, so the state
// below is per-micro: whichever one you left expires while you work on the other.
// docs/vcu-parameters.md §9.

/** Which micro, which parameter — carried on every outcome so a result is never ambiguous. */
export interface VcuReadTarget {
  micro: VcuMicro;
  index: number;
  /** `0x1000 | index`, i.e. bank 1. */
  identifier: number;
}

/**
 * How a read came out, minus the identity of what was asked.
 *
 * Factored out so the sweep and the probe share ONE set of outcomes rather than two
 * that drift: the sweep's identity is a micro and a bank-1 index, the probe's is any
 * target, bank and index, and everything downstream of "what happened" is the same
 * question either way.
 */
export type VcuReadResult =
  | { status: "read"; record: Uint8Array }
  /** The micro answered, by name, that it will not. */
  | { status: "refused"; negativeResponseCode: number; description: string }
  /** A session was open and the read got silence. NOT "the parameter does not exist". */
  | { status: "no-response" }
  /** The micro would not open a session, so nothing was even asked of it. */
  | { status: "no-session"; reason: string }
  /**
   * A First Frame arrived and the rest of the reply never did.
   *
   * A claim about the micro or the link, kept apart from `abandoned` below, which is
   * a claim about the framing. In a garage with no reception those send you to
   * different places, which is the whole reason ./multiframe-transfer.ts separates
   * them and why they are not folded here either.
   */
  | { status: "stalled"; reason: string }
  /**
   * A reply arrived and was DISCARDED as unusable: a sequence gap, a Consecutive
   * Frame that under-filled, a declared length over the cap.
   *
   * ⚠️ Deliberately the same word `VcuMultiFrameOutcome` uses, so a tally line traces
   * back to the frame that caused it. And its own status for the same reason: the
   * alternative is completing at the declared length with shifted bytes, which decodes
   * into plausible numbers.
   *
   * ⚠️ This REPLACED a `multi-frame` member meaning "a First Frame arrived where none
   * can exist". One can, and does — A8 bank-1 index 278, 2026-09-14 — and it is now
   * assembled rather than reported. `VcuFrame` in ./param-codec.ts keeps its own
   * `multi-frame`, which is a different claim about a different path.
   */
  | { status: "abandoned"; reason: string }
  /** Something answered in a shape the service does not define. */
  | { status: "unrecognised"; reason: string }
  /**
   * Never reached the bus — our socket, not the bike. Kept apart from
   * `no-response` for the same reason src/can/obd-dtc.ts keeps `not-sent` apart:
   * one is a claim about the VCU, the other a claim about us.
   */
  | { status: "not-sent"; reason: string };

/**
 * What a read observed about THIS PROCESS, as against about the bike.
 *
 * ⚠️ Carried on every read since #223, because a read can now answer a First Frame and
 * this is the number that says whether it did so in time. ../can/obd-dtc.ts measured
 * 4/12 transfers completing at 0 ms of added delay and 1/12 at 40 ms, so a late flow
 * control is the first thing to suspect when a wide record comes back `stalled` — and
 * without this it would be measured by the transport and then thrown away.
 */
export interface VcuReadMeasurement {
  /** Kernel arrival of the First Frame → our flow control. Null when the reply needed none. */
  flowControlLatency: ArrivalLatency | null;
}

/** How one parameter read came out. Resolves; nothing here rejects. */
export type VcuReadOutcome = VcuReadTarget & VcuReadResult & VcuReadMeasurement;

/** What was asked in a one-off probe: any target, any bank, any index. */
export interface VcuProbeTarget {
  target: VcuTarget;
  bank: number;
  index: number;
  /** `(bank << 12) | index`, carried so a caller never recomputes it. */
  identifier: number;
}

/** How one probe came out. Same outcomes as a sweep read — only the identity differs. */
export type VcuProbeOutcome = VcuProbeTarget & VcuReadResult & VcuReadMeasurement;

/**
 * How one multi-frame exchange came out.
 *
 * Deliberately NOT folded into `VcuReadResult`, even now that both go through one
 * transport. What a reply MEANS differs: a parameter read is decoded against the
 * identifier it echoed, these five against the service byte they name, and a `reply`
 * here can carry a refusal while still being a successful exchange. The two unions
 * agree about `abandoned` on purpose, because that one is a claim about the framing
 * and the framing is the part they share.
 */
export type VcuMultiFrameOutcome =
  /**
   * A whole reply arrived and was split against the service asked for. `reply`
   * may still be a refusal: the micro answering `7F 17 31` is a successful
   * exchange carrying a negative answer.
   */
  | {
      status: "reply";
      reply: VcuMultiFrameReply;
      payload: Uint8Array;
      sawFlowControlFromMicro: boolean;
      /** Kernel arrival of the First Frame → our flow control. Null when the reply needed none. */
      flowControlLatency: ArrivalLatency | null;
    }
  /** A session was open and the exchange got silence. `stage` says where it stopped. */
  | { status: "no-response"; stage: TransferStage; flowControlLatency: ArrivalLatency | null }
  /**
   * A reply arrived and was DISCARDED as unusable — a sequence gap, a Consecutive
   * Frame that under-filled, a declared length over the cap.
   *
   * The whole reason this is its own status: the alternative is completing at the
   * declared length with shifted bytes, which decodes into plausible numbers. A
   * review already caught exactly that in the freeze-frame decoder.
   */
  | { status: "abandoned"; reason: string; flowControlLatency: ArrivalLatency | null }
  /** The micro would not open a session, so nothing was even asked of it. */
  | { status: "no-session"; reason: string }
  /** The caller stopped it — a cancel, a shutdown, or a gate closing. */
  | { status: "cancelled"; reason: string }
  /** Never reached the bus — our socket, not the bike. */
  | { status: "not-sent"; reason: string };

/** Per-exchange transport limits. Every one of them bounds a stuck or hostile responder. */
export interface VcuMultiFrameOptions {
  /**
   * Largest reply payload to assemble, and the number the reassembler's frame cap
   * is derived from. A caller states the largest reply ITS service can justify.
   */
  maxPayloadBytes?: number;
  /** How long to wait for the first frame of the reply. */
  firstReplyTimeoutMs?: number;
  /** How long to wait for the rest, once a First Frame has arrived. */
  transferTimeoutMs?: number;
  /** How long to wait for the micro's flow control before sending the rest of a long request. */
  requestFlowControlTimeoutMs?: number;
}

export interface VcuKwpClient {
  /**
   * Feed every received CAN frame here. Returns true when the frame was consumed,
   * so a caller sharing the socket knows not to look at it as well.
   */
  /** `arrival` is the kernel's stamp — src/can/frame-arrival.ts. Optional: without it nothing is measured. */
  handleFrame: (id: number, data: Buffer, arrival?: FrameArrival | null) => boolean;
  /** Opens (or re-opens) a diagnostic session. Resolves false if the target will not. */
  openSession: (target: VcuTarget) => Promise<boolean>;
  /** `3E` TesterPresent — a pre-flight "is this target there?" that needs a session first. */
  ping: (target: VcuTarget) => Promise<boolean>;
  /** Reads one bank-1 parameter off a VCU micro. What the sweep uses. Resolves whatever happens. */
  readParameter: (micro: VcuMicro, index: number) => Promise<VcuReadOutcome>;
  /**
   * Reads ONE identifier off any target in any bank — service mode's probe.
   *
   * Same three request kinds and the same encoder as everything else here; the only
   * difference from `readParameter` is that the caller says which target and which
   * bank instead of those being the sweep's fixed A8/A9 and bank 1.
   */
  probe: (target: VcuTarget, bank: number, index: number) => Promise<VcuProbeOutcome>;
  /**
   * Runs one multi-frame read against a target the CALLER names.
   *
   * `request` is ./multiframe-codec.ts' closed union — five reads, no service byte
   * and no value a caller can choose — so this widens WHICH questions may be
   * asked and not what may be done. Resolves whatever happens.
   */
  multiFrameRead: (
    target: VcuTarget,
    request: VcuMultiFrameRequest,
    options?: VcuMultiFrameOptions
  ) => Promise<VcuMultiFrameOutcome>;
  /**
   * Abandons a multi-frame read in flight, keeping the client usable. False when
   * there is none.
   *
   * Separate from `stop()` because a bulk log read must be interruptible without
   * killing the client that has to send `0x37` afterwards to close the transfer
   * politely. `stop()` is the shutdown; this is the pause button.
   *
   * ⚠️ "Multi-frame" here names the TRANSPORT, not the reply's shape, and since a
   * parameter read uses that transport this now reaches one. No caller is affected
   * today — ./freeze-frame-log.ts drives a client of its own that never reads
   * parameters — but a caller sharing one would cancel whichever exchange is in the
   * slot, which is no longer only a bulk read.
   */
  cancelMultiFrameRead: (reason: string) => boolean;
  /** Stops accepting work and clears any timer, so the process can exit. */
  stop: () => void;
}

export interface VcuKwpClientOptions {
  /**
   * How long to wait for a reply. 300 ms is inherited from the two KWP/OBD paths
   * already in this repo (src/can/elock.ts, src/can/obd-dtc.ts' first-reply
   * window) rather than measured for this one — the 2026-08-08 session recorded no
   * per-read latencies, so this is a working default and not an established number.
   * Every read that has been observed answered immediately or not at all.
   */
  responseTimeoutMs?: number;
  /**
   * Gap between requests. A 277-parameter sweep is ~277 requests on a bus shared
   * with the ABS, the BMS at 20 Hz and (if the service is running) a 2 Hz OBD
   * poller, so it is paced rather than fired as fast as the socket allows. 10 ms
   * costs the whole sweep under 3 s and stays far inside the ~2.5 s session window.
   */
  paceMs?: number;
  /** Defaults for every multi-frame exchange. Each call may still override them. */
  multiFrame?: VcuMultiFrameOptions;
}

/**
 * How quiet a session may go before it is assumed expired and re-opened. The
 * measured window is ~2.5 s idle; 1.5 s leaves margin for a scheduling hiccup on a
 * Pi Zero without re-opening on every read.
 */
const SESSION_IDLE_LIMIT_MS = 1500;

const DEFAULT_RESPONSE_TIMEOUT_MS = 300;
const DEFAULT_PACE_MS = 10;

/**
 * Largest reply payload a parameter read will assemble.
 *
 * The widest record anything here describes is a 4-byte DWORD, so the longest reply that
 * is not a surprise is `62 <hi> <lo>` plus 4 = 7 bytes. 32 leaves room for a record four
 * times wider before the cap is what stops a read, which matters because an unexpected
 * LENGTH is the evidence that a width is wrong — and the declared length survives in the
 * abandonment's reason either way, so the cap costs no evidence even when it fires.
 *
 * ⚠️ Chosen here rather than inherited: ../diagnostics/extended-iso-tp.ts' constructor
 * asks each caller to state the largest reply its own service can justify, and says in as
 * many words that it is "deliberately not large enough for anything". It derives two caps —
 * 6 contributing frames (`maxFramesFor`) and 22 frames per exchange — so a reply abandoned
 * for frame count on this path was over one of those.
 */
const READ_MAX_PAYLOAD_BYTES = 32;

/**
 * Multi-frame defaults.
 *
 * ⚠️ None of these is measured for THIS channel — no multi-frame reply has ever
 * been timed on it, because none has ever been captured. They are carried over
 * from the OBD channel's numbers in src/can/obd-dtc.ts, which WERE measured on
 * this bike 2026-08-04: First Frames arrived 23–70 ms after the request, and
 * completed transfers ran 79–110 ms end to end. Both windows there are ~4× the
 * observed worst case, and the same ratio is kept here.
 *
 * The payload cap is the one number chosen rather than inherited: 256 bytes is
 * comfortably above the longest reply any of these five services can produce
 * (a `0x18` list of all 63 components is 191), and far below what would let a
 * stuck responder matter. A caller with a tighter bound should say so.
 */
const DEFAULT_MULTI_FRAME: Required<VcuMultiFrameOptions> = {
  maxPayloadBytes: 256,
  firstReplyTimeoutMs: 300,
  transferTimeoutMs: 400,
  /**
   * Deliberately short. This window is only reached by the one multi-frame
   * REQUEST (`0x35`), it ends in sending the rest anyway rather than in a
   * failure (see `onRequestFlowControlTimeout`), and every millisecond spent
   * waiting is a millisecond the micro's ~2.5 s session is ticking down.
   */
  requestFlowControlTimeoutMs: 150,
};

/**
 * The one exchange in flight, of whichever kind.
 *
 * ONE slot, not one per kind. Two nullable fields and an `if` per entry point is
 * exactly the shape ./bus-lease.ts' header describes going wrong — it worked
 * while there was one kind of exchange and stopped working when there were two.
 * The invariant that matters is the same for both: these micros answer on ONE
 * CAN id with no request/response tag, so a second exchange in flight would be
 * answered by whichever frame landed first.
 */
type PendingExchange =
  /** One frame out, one frame back — a session, a ping, a parameter read. */
  | {
      kind: "single-frame";
      resolve: (frame: VcuAddressedFrame) => void;
      abandon: (result: { kind: "timeout" } | { kind: "not-sent"; reason: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  /** A transfer that spans frames in one or both directions. ./multiframe-transfer.ts owns its timers. */
  | { kind: "multi-frame"; transfer: RunningMultiFrameTransfer };

interface ClientContext {
  channel: RawChannel;
  responseTimeoutMs: number;
  paceMs: number;
  multiFrame: Required<VcuMultiFrameOptions>;
  /** The one exchange in flight, or null. */
  pending: PendingExchange | null;
  /** Monotonic mark of the last reply from each target; null while no session is believed open. */
  lastExchangeAt: Partial<Record<VcuTarget, number | null>>;
  /**
   * The CAN id the request in flight expects its reply on. Held rather than assumed,
   * because a second ECU on its own pair of ids was briefly a thing here — so "is
   * this frame for us" was made a question about who we last asked rather than a
   * constant. Both remaining targets share 0x7E0, so it answers the same today; it is
   * kept as a question because the next ECU added will not.
   */
  pendingResponseCanId: number | null;
  stopped: boolean;
}

/**
 * Opens a read-only KWP client over an ALREADY-UP CAN interface.
 *
 * The channel is the caller's: this never starts, stops or reconfigures it, so the
 * same socket can be shared with whatever else is listening.
 */
export function createVcuKwpClient(channel: RawChannel, options: VcuKwpClientOptions = {}): VcuKwpClient {
  const context: ClientContext = {
    channel,
    responseTimeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
    paceMs: options.paceMs ?? DEFAULT_PACE_MS,
    multiFrame: { ...DEFAULT_MULTI_FRAME, ...options.multiFrame },
    pending: null,
    lastExchangeAt: { A8: null, A9: null },
    pendingResponseCanId: null,
    stopped: false,
  };
  return {
    handleFrame: (id, data, arrival) => handleFrame(context, id, data, arrival),
    // The public contract stays a boolean: no caller outside this file needs to tell
    // our own refusal from the micro's silence, and `performRead` — which does — reads
    // `SessionAttempt` directly.
    openSession: async target => (await openSession(context, target)).opened,
    ping: target => ping(context, target),
    readParameter: (micro, index) => readParameter(context, micro, index),
    probe: (target, bank, index) => probe(context, target, bank, index),
    multiFrameRead: (target, request, multiFrameOptions) =>
      multiFrameExchange(context, target, request, multiFrameOptions),
    cancelMultiFrameRead: reason => cancelMultiFrameRead(context, reason),
    stop: () => stop(context),
  };
}

function handleFrame(context: ClientContext, id: number, data: Buffer, arrival?: FrameArrival | null): boolean {
  // Matched against the id the request IN FLIGHT expects, not against a constant.
  // With nothing in flight there is nothing of ours on the bus, so nothing here is
  // ours to consume — which also keeps this a strict no-op for the shared socket in
  // src/index.ts between sweeps.
  if (context.pendingResponseCanId === null || id !== context.pendingResponseCanId) {
    return false;
  }
  if (context.pending?.kind === "multi-frame") {
    // Handed straight through, undecoded. The transfer answers a First Frame with
    // flow control from inside this call, so nothing may be inserted before it —
    // see the timing note in ./multiframe-transfer.ts' header.
    return context.pending.transfer.handleFrame(data, arrival);
  }
  const frame = parseResponseFrame(data);
  if (frame.kind === "ignored") {
    // Includes anything not addressed to 0xF1 — another tester, or a micro
    // answering someone else. Handed back rather than swallowed.
    return false;
  }
  const waiting = context.pending;
  if (!waiting) {
    // A reply to a request that already timed out. Dropping it here is what stops
    // it being handed to the NEXT request as its answer; for a parameter read the
    // identifier echo would catch that anyway, which is the belt to this braces.
    return true;
  }
  context.pending = null;
  clearTimeout(waiting.timer);
  waiting.resolve(frame);
  return true;
}

/**
 * Runs one multi-frame exchange inside the session machinery.
 *
 * Everything a single-frame read gets, this gets too, and by going through the
 * same places rather than by reimplementing them: the session is opened if it has
 * gone idle, the one-in-flight rule is the same slot, `stop()` reaches it, and the
 * outbound pace is the same. What it does NOT share is the retry — see below.
 */
async function multiFrameExchange(
  context: ClientContext,
  micro: VcuTarget,
  request: VcuMultiFrameRequest,
  overrides: VcuMultiFrameOptions = {}
): Promise<VcuMultiFrameOutcome> {
  const busy = busyReason(context);
  if (busy !== null) {
    return { status: "not-sent", reason: busy };
  }
  const session = await ensureSession(context, micro);
  if (!session.opened) {
    return session.notSent === null
      ? { status: "no-session", reason: `${micro} did not answer 10 81` }
      : { status: "not-sent", reason: session.notSent };
  }

  const expectedService = expectedResponseService(request);
  const result = await runTransfer(context, micro, encodeMultiFrameRequestPayload(request), overrides);

  switch (result.kind) {
    case "payload":
      return {
        status: "reply",
        reply: decodeMultiFrameReply(result.payload, expectedService),
        payload: result.payload,
        sawFlowControlFromMicro: result.sawFlowControlFromMicro,
        flowControlLatency: result.flowControlLatency,
      };
    case "timeout":
      // NOT retried, deliberately, where a single-frame read is. A stale session
      // is the likeliest cause of silence and is why `performRead` retries once —
      // but that retry is only safe because a parameter read is idempotent and
      // costs one frame. `0x36` is neither: it advances the micro's upload
      // position, so asking again after a timeout could skip a block or replay
      // one, and the caller would have no way to tell which. ./freeze-frame-log.ts
      // ends the transfer instead, which is the recoverable move.
      // ⚠️ The latency is carried even here — ESPECIALLY here. A First Frame answered
      // late and then stalling is the failure this measurement exists to catch, and
      // dropping it would lose the one reading worth having.
      return { status: "no-response", stage: result.stage, flowControlLatency: result.flowControlLatency };
    case "abandoned":
      return { status: "abandoned", reason: result.reason, flowControlLatency: result.flowControlLatency };
    case "cancelled":
      return { status: "cancelled", reason: result.reason };
    case "not-sent":
      return { status: "not-sent", reason: result.reason };
  }
}

/**
 * Why this client cannot take another exchange right now, or null.
 *
 * ⚠️ Asked BEFORE the session is opened, deliberately. With a second request already in
 * flight, `ensureSession` would itself be refused and the caller would be told the micro
 * did not answer `10 81` — a claim about the bike, for a fault that is entirely ours.
 */
function busyReason(context: ClientContext): string | null {
  if (context.stopped) {
    return "client stopped";
  }
  if (context.pending) {
    const reason = "a request was already in flight";
    console.warn(`vcu: ${reason} — refusing to interleave a second one`);
    return reason;
  }
  return null;
}

/**
 * Runs one transfer to completion in the one-in-flight slot, and paces afterwards.
 *
 * The caller owns the session and the decode; this owns the slot, the socket and the
 * pace, so a parameter read and a `0x17` differ only in the bytes they hand over and
 * what they make of what comes back.
 *
 * ⚠️ `requestPayload` is raw bytes, which is the one shape this client's safety case says
 * does not exist — so: it is module-private, and both callers hand it a payload built and
 * allowlisted by a closed union (`buildRequestPayload`, `encodeMultiFrameRequestPayload`).
 * Neither can express a write, and nothing widens by their sharing a transport.
 */
async function runTransfer(
  context: ClientContext,
  micro: VcuTarget,
  requestPayload: Uint8Array,
  overrides: VcuMultiFrameOptions
): Promise<MultiFrameResult> {
  const busy = busyReason(context);
  if (busy !== null) {
    // Both callers ask the same question before opening a session, where the answer
    // makes a better message. This is the guard on the slot itself — the `await` in
    // between is real — and it is loud rather than quiet for that reason.
    return { kind: "not-sent", reason: busy, flowControlLatency: null };
  }
  const settings = { ...context.multiFrame, ...overrides };
  const transfer = startMultiFrameTransfer({
    target: micro,
    requestPayload,
    send: frame =>
      context.channel.send({ id: canIdsFor(micro).request, ext: false, rtr: false, data: Buffer.from(frame) }),
    maxPayloadBytes: settings.maxPayloadBytes,
    firstReplyTimeoutMs: settings.firstReplyTimeoutMs,
    transferTimeoutMs: settings.transferTimeoutMs,
    requestFlowControlTimeoutMs: settings.requestFlowControlTimeoutMs,
  });
  context.pending = { kind: "multi-frame", transfer };
  context.pendingResponseCanId = canIdsFor(micro).response;

  const result = await transfer.finished;
  if (context.pending?.kind === "multi-frame" && context.pending.transfer === transfer) {
    context.pending = null;
  }
  context.pendingResponseCanId = null;
  if (result.kind === "payload") {
    context.lastExchangeAt[micro] = monotonicNow();
  }
  // Paced on the way OUT, like every other exchange here, so every path through
  // this client is polite to a bus shared with the ABS and the BMS by default
  // rather than by the caller remembering to be.
  await sleep(context.paceMs);
  return result;
}

async function readParameter(context: ClientContext, micro: VcuMicro, index: number): Promise<VcuReadOutcome> {
  const identity: VcuReadTarget = { micro, index, identifier: identifierForIndex(index) };
  return { ...identity, ...(await performRead(context, micro, CALIBRATION_BANK, index)) };
}

/**
 * One identifier off any target in any bank.
 *
 * `identifierFor` is called BEFORE anything reaches the bus, so a bank or index a
 * CommonIdentifier cannot express throws here rather than being truncated into a
 * different, valid-looking read. That matters more for a probe than for the sweep:
 * the sweep's indices come from a table this repo owns, a probe's come from whoever
 * is holding the phone.
 */
async function probe(context: ClientContext, target: VcuTarget, bank: number, index: number): Promise<VcuProbeOutcome> {
  const identity: VcuProbeTarget = { target, bank, index, identifier: identifierFor(bank, index) };
  return { ...identity, ...(await performRead(context, target, bank, index)) };
}

/**
 * The read itself, shared by the sweep and the probe so there is one session/retry/decode path.
 *
 * ⚠️ It goes through the MULTI-FRAME transport, and every read does, not only the wide
 * ones. The request bytes are unchanged — `segmentRequestPayload` emits the same Single
 * Frame `buildRequestFrame` does for a 3-byte payload — and a Single Frame reply still
 * completes on the first frame pushed. What it buys is the reply that does not fit: A8
 * answered bank-1 index 278 with a 7-byte First Frame on 2026-09-14 and this repo could
 * not assemble it. The alternative, asking again after seeing a First Frame, would meet a
 * micro mid-ISO-TP-abort on a guess about its N_Bs window that cannot be tested from here.
 * docs/vcu-parameters.md §9.
 */
async function performRead(
  context: ClientContext,
  micro: VcuTarget,
  bank: number,
  index: number
): Promise<VcuReadResult & VcuReadMeasurement> {
  const identifier = identifierFor(bank, index);
  const busy = busyReason(context);
  if (busy !== null) {
    return { status: "not-sent", reason: busy, flowControlLatency: null };
  }
  const session = await ensureSession(context, micro);
  if (!session.opened) {
    return { ...sessionFailure(session, micro, "did not answer 10 81"), flowControlLatency: null };
  }

  // Both hoisted: the retry must run under the same bytes and the same settings as the
  // first attempt, and a reader should not have to prove that from two call sites.
  const requestPayload = buildRequestPayload({ kind: "read-parameter", bank, index });
  const transferOptions = readTransferOptions(context);
  let result = await runTransfer(context, micro, requestPayload, transferOptions);
  if (result.kind === "timeout" && result.stage === "first-reply") {
    // Far and away the likeliest cause of silence is the session having expired
    // while we were doing something else, so re-open and ask once more before
    // reporting the bike as unresponsive. Exactly one retry: past that, a second
    // silence is information, and hammering a shared bus to re-establish it is not
    // a trade worth making (same reasoning as obd-dtc.ts' "only a stall is retried").
    //
    // ⚠️ ONLY on `first-reply`. A stall AFTER a First Frame is not a stale session —
    // the micro demonstrably answered — so the retry's whole premise is absent, and
    // asking again would put a second request on a micro that is still transmitting
    // the first reply.
    const reopened = await openSession(context, micro);
    if (!reopened.opened) {
      return { ...sessionFailure(reopened, micro, "stopped answering 10 81 mid-read"), flowControlLatency: null };
    }
    result = await runTransfer(context, micro, requestPayload, transferOptions);
  }
  // ⚠️ ONE attachment point, which is what ./multiframe-transfer.ts's `settle` earned
  // its comment for: a stalled read is exactly the case the measurement exists for, so
  // it must not be droppable by a branch someone adds later and forgets to spread it on.
  return { ...describeReadResult(result, identifier), flowControlLatency: result.flowControlLatency };
}

/** What one finished transfer means for a parameter read. Pure. */
function describeReadResult(result: MultiFrameResult, identifier: number): VcuReadResult {
  switch (result.kind) {
    case "payload":
      return describeReadPayload(result.payload, identifier);
    case "timeout":
      return describeReadTimeout(result.stage);
    case "abandoned":
      return { status: "abandoned", reason: result.reason };
    // "We stopped", not "the bike went quiet" — the same claim `stop()` made before this
    // path assembled anything, and ./sweep.ts discards an in-flight outcome on abort on
    // the strength of it. A cancel and a dead socket are one answer to a caller here.
    case "cancelled":
    case "not-sent":
      return { status: "not-sent", reason: result.reason };
  }
}

/**
 * The transfer settings a parameter read runs under.
 *
 * ⚠️ `firstReplyTimeoutMs` is the CLIENT's `responseTimeoutMs`, not the multi-frame
 * default. A read's reply window is the caller's to set and has been since before any of
 * this existed; inheriting 300 ms here would quietly ignore whatever the caller asked for.
 */
function readTransferOptions(context: ClientContext): VcuMultiFrameOptions {
  return { maxPayloadBytes: READ_MAX_PAYLOAD_BYTES, firstReplyTimeoutMs: context.responseTimeoutMs };
}

/** One assembled reply, decoded against the identifier that was asked for. */
function describeReadPayload(payload: Uint8Array, identifier: number): VcuReadResult {
  const reply = decodeParameterReply(payload, identifier);
  switch (reply.kind) {
    case "record":
      return { status: "read", record: reply.record };
    case "refused":
      return {
        status: "refused",
        negativeResponseCode: reply.negativeResponseCode,
        description: reply.description,
      };
    case "identifier-mismatch":
      return {
        status: "unrecognised",
        reason: `reply echoed identifier 0x${reply.received.toString(16)}, not 0x${reply.expected.toString(16)}`,
      };
    case "unrecognised":
      return { status: "unrecognised", reason: reply.reason };
  }
}

/**
 * A timeout, by the window it happened in.
 *
 * ⚠️ A switch over all three stages with NO `default`, so a fourth `TransferStage` is a
 * compile error here rather than silently inheriting whatever the last branch said. That
 * is the whole payment: the `request-flow-control` branch is unreachable from a read — a
 * 3-byte request is one frame, so nothing is ever outstanding for a micro to be asked
 * about — and it says so in its own reason rather than being folded into a neighbour.
 */
function describeReadTimeout(stage: TransferStage): VcuReadResult {
  switch (stage) {
    case "first-reply":
      return { status: "no-response" };
    case "reply-transfer":
      return { status: "stalled", reason: "a First Frame arrived and the rest of the reply never did" };
    case "request-flow-control":
      return {
        status: "stalled",
        reason: "no flow control for a request of ours — impossible for a read, which is always one frame",
      };
  }
}

/**
 * Why a session was not opened — OURS or the micro's.
 *
 * ⚠️ A boolean here was one layer too high. `exchange` knows it never transmitted, and
 * for two reasons (we stopped, or another exchange holds the slot); collapsing that to
 * false made the caller guess the cause back from `context.stopped`, which covered one
 * of the two and reported the other as the bike being asleep. The reason travels now.
 */
type SessionAttempt = { opened: true } | { opened: false; notSent: string | null };

async function openSession(context: ClientContext, micro: VcuTarget): Promise<SessionAttempt> {
  const result = await exchange(context, micro, { kind: "start-session" });
  const opened = result.kind === "reply" && result.frame.kind === "payload" && isSessionOpened(result.frame.payload);
  // Cleared rather than left stale on failure: believing a session is open when it
  // is not turns every subsequent read into a silent one.
  context.lastExchangeAt[micro] = opened ? monotonicNow() : null;
  if (opened) {
    return { opened: true };
  }
  return { opened: false, notSent: result.kind === "not-sent" ? result.reason : null };
}

async function ping(context: ClientContext, micro: VcuTarget): Promise<boolean> {
  if (!(await ensureSession(context, micro)).opened) {
    return false;
  }
  const result = await exchange(context, micro, { kind: "tester-present" });
  return result.kind === "reply" && result.frame.kind === "payload";
}

/** Opens a session only when the last one is believed to have expired. */
async function ensureSession(context: ClientContext, micro: VcuTarget): Promise<SessionAttempt> {
  const lastExchangeAt = context.lastExchangeAt[micro] ?? null;
  if (lastExchangeAt !== null && since(lastExchangeAt) < SESSION_IDLE_LIMIT_MS) {
    return { opened: true };
  }
  return openSession(context, micro);
}

/**
 * A failed session open, as an outcome — ours or the micro's, never a guess.
 *
 * `notSent` is set only when nothing reached the bus, which is the one case where
 * blaming the micro would be a claim about the motorcycle for a fault of ours.
 * ./probe.ts renders `no-session` as "either nothing is at this address, or it is
 * asleep", so this is the difference between a diagnosis and a wild goose chase.
 */
function sessionFailure(attempt: { notSent: string | null }, micro: VcuTarget, when: string): VcuReadResult {
  return attempt.notSent === null
    ? { status: "no-session", reason: `${micro} ${when}` }
    : { status: "not-sent", reason: attempt.notSent };
}

/**
 * How one request/reply window ended.
 *
 * `timeout` and `not-sent` are kept apart all the way up to VcuReadOutcome, because
 * they are claims about different things: one says the micro did not answer, the
 * other says we never managed to ask. Collapsing them would put our own dead socket
 * on the screen as the bike refusing to talk — `can0` goes down whenever the
 * cool-eva service restarts (CLAUDE.md), so that is a thing that happens.
 */
type ExchangeResult =
  | { kind: "reply"; frame: VcuAddressedFrame }
  | { kind: "timeout" }
  | { kind: "not-sent"; reason: string };

/**
 * One request, one reply window. Resolves whatever happens; never rejects.
 *
 * Deliberately not safe to call concurrently with itself — there is one reply id
 * for all three micros and no request/response tag to match on, so two requests in
 * flight would be answered by whichever frame lands first. A caller that tries is
 * told so rather than being given a plausible wrong answer.
 */
function exchange(context: ClientContext, micro: VcuTarget, request: VcuRequest): Promise<ExchangeResult> {
  if (context.stopped) {
    // Nothing reaches the bus after stop(), whichever entry point asked. readParameter()
    // already checks this, but openSession() and ping() route straight through here, so
    // without this a Ctrl-C mid-sweep still puts 10 81 / 3E on the bus for the micro we
    // had not got to yet — contradicting stop()'s "stops accepting work". This is where
    // the guarantee belongs for all three callers.
    return Promise.resolve({ kind: "not-sent", reason: "client stopped" });
  }
  const busy = busyReason(context);
  if (busy !== null) {
    return Promise.resolve({ kind: "not-sent", reason: busy });
  }
  const frame = Buffer.from(buildRequestFrame(micro, request));
  const canIds = canIdsFor(micro);
  return new Promise<ExchangeResult>(resolve => {
    const settle = (result: ExchangeResult): void => {
      if (result.kind === "reply") {
        context.lastExchangeAt[micro] = monotonicNow();
      }
      context.pendingResponseCanId = null;
      // Paced on the way OUT rather than by the caller, so every path through this
      // client is polite to the bus by default instead of by remembering to be.
      setTimeout(() => resolve(result), context.paceMs);
    };
    const timer = setTimeout(() => {
      context.pending = null;
      settle({ kind: "timeout" });
    }, context.responseTimeoutMs);
    context.pending = {
      kind: "single-frame",
      resolve: frame => settle({ kind: "reply", frame }),
      timer,
      abandon: settle,
    };
    context.pendingResponseCanId = canIds.response;

    try {
      context.channel.send({ id: canIds.request, ext: false, rtr: false, data: frame });
    } catch (err) {
      clearTimeout(timer);
      context.pending = null;
      // Loud: a bus that will not take an 8-byte frame is a much bigger problem
      // than this read, and on this Pi it usually means can0 went down under us.
      console.error("vcu: send failed", err);
      settle({ kind: "not-sent", reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

function stop(context: ClientContext): void {
  context.stopped = true;
  context.pendingResponseCanId = null;
  const waiting = context.pending;
  if (!waiting) {
    return;
  }
  context.pending = null;
  if (waiting.kind === "multi-frame") {
    // The transfer clears its own timers, including the pacer that would otherwise
    // keep putting Consecutive Frames of a half-sent request on the bus after
    // stop() had promised nothing more would go out.
    waiting.transfer.cancel("client stopped");
    return;
  }
  clearTimeout(waiting.timer);
  // "We stopped", not "the bike went quiet" — the caller writes its outcomes down,
  // and recording our own shutdown as the VCU failing to answer would be believed
  // by the next run that resumes from that file.
  waiting.abandon({ kind: "not-sent", reason: "client stopped" });
}

/**
 * Abandons a multi-frame read without stopping the client.
 *
 * The result comes back through the ordinary `multiFrameRead` promise as
 * `cancelled`, so a caller that was awaiting it is told what happened rather than
 * left holding a promise that never settles.
 */
function cancelMultiFrameRead(context: ClientContext, reason: string): boolean {
  if (context.pending?.kind !== "multi-frame") {
    return false;
  }
  context.pending.transfer.cancel(reason);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The id every request goes out on, re-exported so a caller can filter its socket. */
export { KWP_REQUEST_CAN_ID, KWP_RESPONSE_CAN_ID };
