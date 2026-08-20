import { monotonicNow, since } from "../monotonic.ts";
import { acquireBus } from "./bus-lease.ts";
import type { VcuKwpClient, VcuMultiFrameOutcome } from "./kwp-client.ts";
import { isUploadFinished, readUploadGrant, toHex, type VcuUploadGrant } from "./multiframe-codec.ts";
import type { VcuTarget } from "./param-codec.ts";

// The bulk freeze-frame log: `0x35` RequestUpload, then N × `0x36` TransferData, then
// `0x37` RequestTransferExit. It is the whole stored LOG with timestamps, where `0x17`
// gives one undated record per component.
//
// The factory tool did exactly this on 2026-08-08 and it took **~7 minutes for 1198
// blocks**. That single fact drives most of the design: everything here is about a read
// that runs for minutes on a bus shared with the brakes, rather than about the protocol,
// which is three services and a loop. A bus lease, pacing, timers rather than loops, and a
// `handleFrame` that hands back everything not ours are what keep the OBD poller alive.
//
// ⚠️ This module does NOT decode those records, on purpose — a decoder written against a
// layout that has never been seen is how you get 1198 plausible wrong answers instead of
// one. The bytes are kept whole so the first real transfer can be read by a human.
//
// ✅ Since 2026-08-20 every REQUEST byte is captured rather than guessed, and three
// defects that came out of reading the capture are fixed. The REPLY side is still where
// this can fail on the first frame, so it is built to fail LOUDLY.
//
// ⚠️ AND IT MUST BE STOPPABLE. `cancel()` takes effect between blocks and inside the block
// in flight, and the `0x37` still goes out afterwards: an abandoned upload is a micro left
// holding state that may make it refuse the next request. `0x37` transfers nothing and
// stores nothing, so sending it on the way out of a failure is not a write.
//
// What is established and what is not: docs/vcu-parameters.md §11.

/** Which micro. A8, and not a parameter — the same argument ../diagnostics/freeze-frame.ts makes for `0x17`. */
const VCU_SAFETY_MICRO: VcuTarget = "A8";

/**
 * Gap between `0x36` blocks, on top of the client's own outbound pace.
 *
 * The factory tool ran 1198 blocks in ~7 minutes, i.e. **~350 ms per block**. We
 * do not know whether that was politeness, a slow USB adapter or something the
 * micro requires, and the difference matters: too fast might simply not work.
 *
 * 25 ms is the compromise, and it is a compromise rather than a measurement. With
 * the client's 10 ms outbound pace and a reply window, a full 1198-block read
 * lands around 60–90 s — long enough to be a deliberate operation, short enough
 * that a person will wait for it, and roughly 25 frames/s onto a bus that already
 * carries the BMS at 20 Hz. If the first live run is refused or drops blocks,
 * raising this towards 350 ms is the first thing to try, because matching the only
 * known-good client is a stronger position than being clever.
 */
const DEFAULT_PACE_MS = 25;

/**
 * Hard ceiling on blocks, so a micro that never says "finished" still ends.
 *
 * 4× the 1198 the factory tool read. Generous on purpose: this bike's log could
 * have grown since, and truncating a real transfer would be the worse failure of
 * the two. Reaching it is reported as its own completion state rather than as a
 * finished read, because a capped read is not a whole one.
 */
const DEFAULT_MAX_BLOCKS = 5000;

/**
 * Largest single `0x36` reply to assemble.
 *
 * 🔴 This was 128, sized from ONE log record (~28 bytes) plus slack. A block is not a
 * record: it is as many records as fit, and the `75 12 E9` grant says how many —
 * `0xE9` = 233 bytes. The 1198 blocks in the 2026-08-08 capture run 206…233, so at 128
 * the reassembler abandoned block 1 with "first frame declares 231 bytes, over the 128
 * cap" and the read came back with nothing. docs/vcu-parameters.md §11.
 *
 * 256 is above the 233 the micro is granted, and still a bound on what a stuck responder
 * can make this process hold across 1198 iterations.
 */
const TRANSFER_BLOCK_MAX_PAYLOAD_BYTES = 256;

export interface FreezeFrameLogOptions {
  /** The client to run this on. Its session machinery and single-flight rule are reused, not copied. */
  client: VcuKwpClient;
  /** Gap between blocks. Defaults to `DEFAULT_PACE_MS`; raise it towards 350 ms if the bike objects. */
  paceMs?: number;
  /** Hard block ceiling. Defaults to `DEFAULT_MAX_BLOCKS`. */
  maxBlocks?: number;
  /**
   * Called after every block, so a long read can show progress. Kept
   * side-effect-only and synchronous-cheap: it runs inside the read's own pacing
   * budget, so anything slow here slows the transfer.
   */
  onProgress?: (progress: FreezeFrameLogProgress) => void;
}

export interface FreezeFrameLogProgress {
  blocks: number;
  bytes: number;
  elapsedMs: number;
}

/** How the closing `0x37` went. */
export type FreezeFrameLogExit =
  /** Sent, and the micro answered `77`. The transfer is closed. */
  | "acknowledged"
  /** Sent, and the micro did not answer. It may still be holding an open upload. */
  | "unacknowledged"
  /**
   * Not sent, because nothing was opened — the micro REFUSED the `0x35`, there was
   * no session, or the frame never left our socket. Sending one anyway would be
   * noise, and reporting it as a failed close would be a warning about nothing.
   */
  | "not-owed";

/** How a whole log read ended. */
export type FreezeFrameLogCompletion =
  /** The micro said the upload was over. The only outcome that means "this is the whole log". */
  | "finished"
  /**
   * `cancel()`, or a closing service gate calling it. What was read is still
   * returned, and the transfer was closed with `0x37` on the way out.
   *
   * ⚠️ NOT a `client.stop()`. That is a harder stop — it refuses every subsequent
   * transmit, so the closing `0x37` cannot go out either — and a read that ends
   * with the micro possibly still holding an open upload is `failed`, with
   * "client stopped" as its reason. The two look similar from the outside and
   * differ in the one way that matters to the next read.
   */
  | "cancelled"
  /** `maxBlocks` reached. The log is longer than we were willing to read in one go. */
  | "block-cap"
  /** Something went wrong — a refusal, silence, a scrambled reply. `reason` says what. */
  | "failed";

export interface FreezeFrameLogResult {
  completion: FreezeFrameLogCompletion;
  /** Why, for every completion but `finished`. Null there. */
  reason: string | null;
  /**
   * Every `0x36` block body, in arrival order, exactly as it arrived — the bytes
   * after the `76` service byte and nothing else. Undecoded on purpose; see the
   * header.
   */
  blocks: Uint8Array[];
  /** What the `75` reply said, or null if the upload never opened. */
  grant: VcuUploadGrant | null;
  /**
   * How the closing `0x37` went.
   *
   * Three states rather than a boolean, because "we did not close it" and "there
   * was nothing to close" are different claims and only one of them is worth a
   * warning. Neither is a failure of the READ — every block already in `blocks` is
   * good regardless — but `unacknowledged` means the micro may still think an
   * upload is open, which is worth knowing before the next attempt is called
   * broken.
   */
  exit: FreezeFrameLogExit;
  elapsedMs: number;
}

/** A log read in flight. */
export interface RunningFreezeFrameLogRead {
  /** How it ended. Resolves whatever happens; never rejects. */
  finished: Promise<FreezeFrameLogResult>;
  /** Asks it to stop. It still closes the transfer with `0x37` on the way out. */
  cancel: (reason: string) => void;
}

/**
 * Starts a bulk freeze-frame log read.
 *
 * Takes the bus lease itself rather than expecting a caller to, because the lease
 * has to outlive the whole sequence — an upload interrupted halfway by a parameter
 * sweep would leave the micro's transfer position somewhere nobody knows.
 * Resolves with `failed` when the bus is busy, naming who has it.
 */
export function startFreezeFrameLogRead(options: FreezeFrameLogOptions): RunningFreezeFrameLogRead {
  const state: LogReadState = {
    options,
    blocks: [],
    grant: null,
    cancellation: null,
    startedAt: monotonicNow(),
  };
  return {
    finished: runLogRead(state),
    cancel: reason => {
      if (state.cancellation === null) {
        state.cancellation = reason;
        // Reaches the exchange in flight as well as the loop between blocks. A
        // block can sit in a reply window for a few hundred ms, and waiting that
        // out before noticing a cancel is what makes a stop button feel broken.
        options.client.cancelMultiFrameRead(reason);
      }
    },
  };
}

interface LogReadState {
  options: FreezeFrameLogOptions;
  blocks: Uint8Array[];
  grant: VcuUploadGrant | null;
  /** The reason a cancel was asked for, or null. Set once; the first reason is the true one. */
  cancellation: string | null;
  startedAt: number;
}

async function runLogRead(state: LogReadState): Promise<FreezeFrameLogResult> {
  const bus = acquireBus("a freeze-frame log read");
  if (!bus.ok) {
    return finish(state, "failed", `the bus is busy with ${bus.heldBy}`, "not-owed");
  }
  try {
    return await readWithBus(state);
  } finally {
    bus.lease.release();
  }
}

async function readWithBus(state: LogReadState): Promise<FreezeFrameLogResult> {
  const { client } = state.options;

  const opened = await client.multiFrameRead(VCU_SAFETY_MICRO, { kind: "request-upload-freeze-frame-log" });
  const openFailure = describeFailure(opened, "35 RequestUpload");
  if (openFailure !== null) {
    // ⚠️ A failed `0x35` does NOT mean no upload is open, and this used to assume
    // it did. Only three outcomes prove the micro has nothing to close: it
    // REFUSED the request, we never opened a session, or the frame never left our
    // socket. Everything else — silence, a scrambled reply, a cancel — means the
    // request reached the bus and A8 may have opened an upload whose grant we
    // never saw. Leaving that open is what makes the NEXT read's `0x35` get
    // refused, which is the exact failure this module's header promises to avoid.
    const nothingWasOpened =
      opened.status === "no-session" ||
      opened.status === "not-sent" ||
      (opened.status === "reply" && opened.reply.kind === "refused");
    const exit = nothingWasOpened ? "not-owed" : await closeTransfer(state);
    return finish(state, state.cancellation === null ? "failed" : "cancelled", openFailure, exit);
  }
  if (opened.status !== "reply" || opened.reply.kind !== "positive") {
    // Unreachable — describeFailure covers every other shape — and here so that a
    // later widening cannot fall through into reading `.body` off a refusal.
    return finish(state, "failed", "35 RequestUpload answered in a shape this read does not define", "not-owed");
  }
  state.grant = readUploadGrant(opened.reply.body);
  if (!state.grant.asCaptured) {
    // Loud, and NOT fatal. The one captured grant was `75 12 E9`; anything else
    // means an assumption about this service is wrong, and the bytes are the
    // evidence. Carrying on is what produces the rest of that evidence.
    console.warn(
      `vcu: 35 RequestUpload answered "${state.grant.rawHex}", not the captured "12 E9" — ` +
        "continuing, but treat the blocks that follow as unverified"
    );
  }

  const completion = await readBlocks(state);
  // Always, on every path including a cancel and a failure. See the header: an
  // upload left open is state on the micro, and `0x37` transfers nothing.
  const exit = await closeTransfer(state);
  return finish(state, completion.completion, completion.reason, exit);
}

async function readBlocks(
  state: LogReadState
): Promise<{ completion: FreezeFrameLogCompletion; reason: string | null }> {
  const { client, onProgress } = state.options;
  const paceMs = state.options.paceMs ?? DEFAULT_PACE_MS;
  const maxBlocks = state.options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  let bytesSoFar = 0;

  while (state.blocks.length < maxBlocks) {
    if (state.cancellation !== null) {
      return { completion: "cancelled", reason: state.cancellation };
    }
    const block = await client.multiFrameRead(
      VCU_SAFETY_MICRO,
      { kind: "transfer-data" },
      { maxPayloadBytes: TRANSFER_BLOCK_MAX_PAYLOAD_BYTES }
    );
    if (state.cancellation !== null) {
      return { completion: "cancelled", reason: state.cancellation };
    }
    const failure = describeFailure(block, `36 TransferData (block ${state.blocks.length + 1})`);
    if (failure !== null) {
      return { completion: "failed", reason: failure };
    }
    if (block.status !== "reply" || block.reply.kind !== "positive") {
      return { completion: "failed", reason: "36 TransferData answered in a shape this read does not define" };
    }
    if (isUploadFinished(block.reply.body)) {
      return { completion: "finished", reason: null };
    }
    state.blocks.push(block.reply.body);
    // Accumulated rather than re-reduced. Re-summing the whole array on every
    // block is O(n²) over a read that can run to thousands of them, and a running
    // total costs nothing.
    bytesSoFar += block.reply.body.length;
    onProgress?.({ blocks: state.blocks.length, bytes: bytesSoFar, elapsedMs: Math.round(since(state.startedAt)) });
    // Scheduled, not spun. This is the yield that keeps the OBD poller and the
    // dashboard alive across a read that runs for a minute or more.
    await sleep(paceMs);
  }
  return {
    completion: "block-cap",
    reason: `stopped at the ${maxBlocks}-block ceiling with the micro still sending`,
  };
}

/**
 * Sends `0x37` and reports whether it was acknowledged.
 *
 * Never throws and never turns a good read into a bad one: the blocks already
 * collected are unaffected by how this goes.
 */
async function closeTransfer(state: LogReadState): Promise<FreezeFrameLogExit> {
  const exit = await state.options.client.multiFrameRead(VCU_SAFETY_MICRO, { kind: "request-transfer-exit" });
  if (exit.status === "reply" && exit.reply.kind === "positive") {
    return "acknowledged";
  }
  const failure = describeFailure(exit, "37 RequestTransferExit") ?? "an unrecognised reply";
  // A warning rather than an error: the read itself may have gone perfectly, and
  // this only says the micro was not told we had finished.
  console.warn(`vcu: could not close the freeze-frame upload — ${failure}`);
  return "unacknowledged";
}

/** One line naming what went wrong with an exchange, or null when nothing did. */
function describeFailure(outcome: VcuMultiFrameOutcome, what: string): string | null {
  switch (outcome.status) {
    case "reply":
      if (outcome.reply.kind === "refused") {
        // `description` already carries the hex — see describeNegativeResponseCode.
        return `${what} refused: NRC ${outcome.reply.description}`;
      }
      if (outcome.reply.kind === "unrecognised") {
        return `${what}: ${outcome.reply.reason}`;
      }
      return null;
    case "no-response":
      return `${what}: no reply, stalled at ${outcome.stage}`;
    case "abandoned":
      // The important one, and the reason it is a failure rather than a shrug: an
      // abandoned transfer is a reply we REFUSED to complete because completing it
      // would have meant inventing bytes.
      return `${what}: reply discarded as unusable — ${outcome.reason}`;
    case "no-session":
      return `${what}: ${outcome.reason}`;
    case "cancelled":
      return `${what}: ${outcome.reason}`;
    case "not-sent":
      return `${what}: never reached the bus — ${outcome.reason}`;
  }
}

function finish(
  state: LogReadState,
  completion: FreezeFrameLogCompletion,
  reason: string | null,
  exit: FreezeFrameLogExit
): FreezeFrameLogResult {
  return {
    completion,
    reason,
    blocks: state.blocks,
    grant: state.grant,
    exit,
    elapsedMs: Math.round(since(state.startedAt)),
  };
}

/** A log read as one line, in the vocabulary the rest of this repo logs in. */
export function describeFreezeFrameLogResult(result: FreezeFrameLogResult): string {
  const size = result.blocks.reduce((total, body) => total + body.length, 0);
  const scale = `${result.blocks.length} block(s), ${size} byte(s) in ${(result.elapsedMs / 1000).toFixed(1)} s`;
  const grant = result.grant ? ` — grant "${result.grant.rawHex}"` : "";
  // Only `unacknowledged` earns a warning. `not-owed` means nothing was opened,
  // and warning about an unclosed transfer that never existed is how a log line
  // teaches people to ignore it.
  const untidy = result.exit === "unacknowledged" ? " ⚠️ the 37 close was not acknowledged" : "";
  switch (result.completion) {
    case "finished":
      return `freeze-frame log: complete, ${scale}${grant}${untidy}`;
    case "cancelled":
      return `freeze-frame log: STOPPED after ${scale} — ${result.reason}${untidy}`;
    case "block-cap":
      return `freeze-frame log: TRUNCATED at ${scale} — ${result.reason}${untidy}`;
    case "failed":
      return `freeze-frame log: FAILED after ${scale} — ${result.reason}${untidy}`;
  }
}

/** Every block as one hex line, which is what a first live run wants written down. */
export function formatFreezeFrameLogBlocks(result: FreezeFrameLogResult): string[] {
  return result.blocks.map((body, index) => `${(index + 1).toString().padStart(4, " ")}  ${toHex(body)}`);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
