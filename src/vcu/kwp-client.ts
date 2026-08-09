import type { RawChannel } from "socketcan";
import { monotonicNow, since } from "../monotonic.ts";
import {
  KWP_REQUEST_CAN_ID,
  KWP_RESPONSE_CAN_ID,
  buildRequestFrame,
  decodeParameterReply,
  identifierForIndex,
  isSessionOpened,
  parseResponseFrame,
  type VcuAddressedFrame,
  type VcuRequest,
} from "./param-codec.ts";
import type { VcuMicro } from "./param-table.ts";

// The transport half of reading VCU calibration parameters: put a frame on the
// bus, wait for the reply, keep the diagnostic session alive, give up on time.
// Every byte it sends is built by ./param-codec.ts and every byte it receives is
// interpreted there — this file holds only the socket, the clock and the session
// state, so the protocol itself stays replayable without a bike.
//
// ⚠️ READ-ONLY, structurally. It cannot express a write: the only way a byte
// reaches `channel.send` is through `buildRequestFrame`, whose input is a closed
// three-alternative union (start session / tester present / read one parameter).
// There is no raw-bytes entry point to misuse, and no transmit address is ever
// derived from something the bus said — the target micro is always one the caller
// named. See the header of ./param-codec.ts for the list of services that must
// never be added, and why.
//
// ⚠️ IT DOES NOT CONFIGURE can0. `bringUpCan` takes the interface DOWN, which
// kills every other raw-CAN socket on the Pi including the running thermometer
// service's (CLAUDE.md). This client only ever opens a channel on an interface
// that is already up, so a parameter read can be taken alongside the live service
// instead of interrupting it. The cost is that it cannot rescue a listen-only
// bus — it will just see nothing, which scripts/read-vcu-params.ts checks for and
// explains rather than leaving as a mystery.
//
// ── What the bus does, per obd-garage/DIAG_ADDRESSES.md §3 (live 2026-08-08) ──
// The micros answer NOTHING until a session is open — `A9 01 3E` alone is silence,
// which is why a conventional sweep misses them entirely. `10 81` first, then reads
// work. The session then auto-closes after ~2.5 s idle, so a long sweep either
// keeps moving or re-opens; this client does the latter whenever it has been quiet
// for longer than SESSION_IDLE_LIMIT_MS, which also makes it correct when the
// caller pauses (a flaky ssh link, a Ctrl-Z, a slow write to the SD card).
//
// A8 and A9 hold SEPARATE sessions, so the state below is per-micro. Switching
// between them mid-sweep is what makes that matter: whichever one you left goes
// idle and expires while you work on the other.

/** Which micro, which parameter — carried on every outcome so a result is never ambiguous. */
export interface VcuReadTarget {
  micro: VcuMicro;
  index: number;
  /** `0x1000 | index`, i.e. bank 1. */
  identifier: number;
}

/** How one parameter read came out. Resolves; nothing here rejects. */
export type VcuReadOutcome = VcuReadTarget &
  (
    | { status: "read"; record: Uint8Array }
    /** The micro answered, by name, that it will not. */
    | { status: "refused"; negativeResponseCode: number; description: string }
    /** A session was open and the read got silence. NOT "the parameter does not exist". */
    | { status: "no-response" }
    /** The micro would not open a session, so nothing was even asked of it. */
    | { status: "no-session"; reason: string }
    /**
     * The reply was a First Frame. Impossible for a bank-1 record (see the codec's
     * header), so it means an assumption is wrong; reported rather than assembled.
     */
    | { status: "multi-frame"; totalLength: number }
    /** Something answered in a shape the service does not define. */
    | { status: "unrecognised"; reason: string }
    /**
     * Never reached the bus — our socket, not the bike. Kept apart from
     * `no-response` for the same reason src/can/obd-dtc.ts keeps `not-sent` apart:
     * one is a claim about the VCU, the other a claim about us.
     */
    | { status: "not-sent"; reason: string }
  );

export interface VcuKwpClient {
  /**
   * Feed every received CAN frame here. Returns true when the frame was consumed,
   * so a caller sharing the socket knows not to look at it as well.
   */
  handleFrame: (id: number, data: Buffer) => boolean;
  /** Opens (or re-opens) a diagnostic session. Resolves false if the micro will not. */
  openSession: (micro: VcuMicro) => Promise<boolean>;
  /** `3E` TesterPresent — a pre-flight "is this micro there?" that needs a session first. */
  ping: (micro: VcuMicro) => Promise<boolean>;
  /** Reads one bank-1 parameter. Resolves whatever happens. */
  readParameter: (micro: VcuMicro, index: number) => Promise<VcuReadOutcome>;
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
}

/**
 * How quiet a session may go before it is assumed expired and re-opened. The
 * measured window is ~2.5 s idle; 1.5 s leaves margin for a scheduling hiccup on a
 * Pi Zero without re-opening on every read.
 */
const SESSION_IDLE_LIMIT_MS = 1500;

const DEFAULT_RESPONSE_TIMEOUT_MS = 300;
const DEFAULT_PACE_MS = 10;

interface ClientContext {
  channel: RawChannel;
  responseTimeoutMs: number;
  paceMs: number;
  /**
   * The one request in flight. `resolve` is what a matching reply calls; `abandon`
   * is for the ways a request ends without one, and takes the reason with it.
   */
  pending: {
    resolve: (frame: VcuAddressedFrame) => void;
    abandon: (result: { kind: "timeout" } | { kind: "not-sent"; reason: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** Monotonic mark of the last reply from each micro; null while no session is believed open. */
  lastExchangeAt: Record<VcuMicro, number | null>;
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
    pending: null,
    lastExchangeAt: { A8: null, A9: null },
    stopped: false,
  };
  return {
    handleFrame: (id, data) => handleFrame(context, id, data),
    openSession: micro => openSession(context, micro),
    ping: micro => ping(context, micro),
    readParameter: (micro, index) => readParameter(context, micro, index),
    stop: () => stop(context),
  };
}

function handleFrame(context: ClientContext, id: number, data: Buffer): boolean {
  if (id !== KWP_RESPONSE_CAN_ID) {
    return false;
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

async function readParameter(context: ClientContext, micro: VcuMicro, index: number): Promise<VcuReadOutcome> {
  const target: VcuReadTarget = { micro, index, identifier: identifierForIndex(index) };
  if (context.stopped) {
    return { ...target, status: "not-sent", reason: "client stopped" };
  }
  if (!(await ensureSession(context, micro))) {
    return { ...target, status: "no-session", reason: `${micro} did not answer 10 81` };
  }

  let result = await exchange(context, micro, { kind: "read-parameter", index });
  if (result.kind === "timeout") {
    // Far and away the likeliest cause of silence is the session having expired
    // while we were doing something else, so re-open and ask once more before
    // reporting the bike as unresponsive. Exactly one retry: past that, a second
    // silence is information, and hammering a shared bus to re-establish it is not
    // a trade worth making (same reasoning as obd-dtc.ts' "only a stall is retried").
    if (!(await openSession(context, micro))) {
      return { ...target, status: "no-session", reason: `${micro} stopped answering 10 81 mid-read` };
    }
    result = await exchange(context, micro, { kind: "read-parameter", index });
  }
  if (result.kind === "not-sent") {
    return { ...target, status: "not-sent", reason: result.reason };
  }
  if (result.kind === "timeout") {
    return { ...target, status: "no-response" };
  }
  if (result.frame.kind === "multi-frame") {
    return { ...target, status: "multi-frame", totalLength: result.frame.totalLength };
  }

  const reply = decodeParameterReply(result.frame.payload, target.identifier);
  switch (reply.kind) {
    case "record":
      return { ...target, status: "read", record: reply.record };
    case "refused":
      return {
        ...target,
        status: "refused",
        negativeResponseCode: reply.negativeResponseCode,
        description: reply.description,
      };
    case "identifier-mismatch":
      return {
        ...target,
        status: "unrecognised",
        reason: `reply echoed identifier 0x${reply.received.toString(16)}, not 0x${reply.expected.toString(16)}`,
      };
    case "unrecognised":
      return { ...target, status: "unrecognised", reason: reply.reason };
  }
}

async function openSession(context: ClientContext, micro: VcuMicro): Promise<boolean> {
  const result = await exchange(context, micro, { kind: "start-session" });
  const opened = result.kind === "reply" && result.frame.kind === "payload" && isSessionOpened(result.frame.payload);
  // Cleared rather than left stale on failure: believing a session is open when it
  // is not turns every subsequent read into a silent one.
  context.lastExchangeAt[micro] = opened ? monotonicNow() : null;
  return opened;
}

async function ping(context: ClientContext, micro: VcuMicro): Promise<boolean> {
  if (!(await ensureSession(context, micro))) {
    return false;
  }
  const result = await exchange(context, micro, { kind: "tester-present" });
  return result.kind === "reply" && result.frame.kind === "payload";
}

/** Opens a session only when the last one is believed to have expired. */
async function ensureSession(context: ClientContext, micro: VcuMicro): Promise<boolean> {
  const lastExchangeAt = context.lastExchangeAt[micro];
  if (lastExchangeAt !== null && since(lastExchangeAt) < SESSION_IDLE_LIMIT_MS) {
    return true;
  }
  return openSession(context, micro);
}

/**
 * How one request/reply window ended.
 *
 * `timeout` and `not-sent` are kept apart all the way up to VcuReadOutcome, because
 * they are claims about different things: one says the micro did not answer, the
 * other says we never managed to ask. Collapsing them would put our own dead socket
 * on the screen as the bike refusing to talk — `can0` goes down whenever the
 * thermometer service restarts (CLAUDE.md), so that is a thing that happens.
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
function exchange(context: ClientContext, micro: VcuMicro, request: VcuRequest): Promise<ExchangeResult> {
  if (context.stopped) {
    // Nothing reaches the bus after stop(), whichever entry point asked. readParameter()
    // already checks this, but openSession() and ping() route straight through here, so
    // without this a Ctrl-C mid-sweep still puts 10 81 / 3E on the bus for the micro we
    // had not got to yet — contradicting stop()'s "stops accepting work". This is where
    // the guarantee belongs for all three callers.
    return Promise.resolve({ kind: "not-sent", reason: "client stopped" });
  }
  if (context.pending) {
    const reason = "a request was already in flight";
    console.warn(`vcu: ${reason} — refusing to interleave a second one`);
    return Promise.resolve({ kind: "not-sent", reason });
  }
  const frame = Buffer.from(buildRequestFrame(micro, request));
  return new Promise<ExchangeResult>(resolve => {
    const settle = (result: ExchangeResult): void => {
      if (result.kind === "reply") {
        context.lastExchangeAt[micro] = monotonicNow();
      }
      // Paced on the way OUT rather than by the caller, so every path through this
      // client is polite to the bus by default instead of by remembering to be.
      setTimeout(() => resolve(result), context.paceMs);
    };
    const timer = setTimeout(() => {
      context.pending = null;
      settle({ kind: "timeout" });
    }, context.responseTimeoutMs);
    context.pending = { resolve: frame => settle({ kind: "reply", frame }), timer, abandon: settle };

    try {
      context.channel.send({ id: KWP_REQUEST_CAN_ID, ext: false, rtr: false, data: frame });
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
  if (context.pending) {
    const waiting = context.pending;
    context.pending = null;
    clearTimeout(waiting.timer);
    // "We stopped", not "the bike went quiet" — the caller writes its outcomes down,
    // and recording our own shutdown as the VCU failing to answer would be believed
    // by the next run that resumes from that file.
    waiting.abandon({ kind: "not-sent", reason: "client stopped" });
  }
}

/** The id every request goes out on, re-exported so a caller can filter its socket. */
export { KWP_REQUEST_CAN_ID, KWP_RESPONSE_CAN_ID };
