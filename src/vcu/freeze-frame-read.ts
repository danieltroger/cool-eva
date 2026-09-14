import { monitorEventLoopDelay } from "node:perf_hooks";
import type { RawChannel } from "socketcan";
import type { ArrivalLatency, FrameArrival } from "../can/frame-arrival.ts";
import { MAX_HOLD_MS } from "../can/obd-hold.ts";
import { createVcuKwpClient, worstCaseMultiFrameReadMs, type VcuMultiFrameOutcome } from "./kwp-client.ts";
import { describeMeasurement, readOneComponent, worseOf } from "./lifetime-read.ts";
import { answeredCount, type StoredLifetimeReply } from "./lifetime-store.ts";
import { decodeMultiFrameReply, decodeStoredDtcList } from "./multiframe-codec.ts";
import { selectComponentsToRead, type FreezeFrameListReport } from "./freeze-frame-list.ts";
import { monotonicNow } from "../monotonic.ts";

// Every stored freeze frame on A8, in one gated read: `0x18` for the list of components
// that have a record, then `0x17` for each of them.
//
// ⚠️ THE LIST IS THE AUTHORITY on which components have a record, and that is a measured
// claim rather than a convenient one: on 2026-09-08 `0x18` named five components and the
// two that it omitted, 36 and 54, each answered `0x17` with `57 00`. n=2, so the page says
// "the VCU's list did not include this component" — a claim about the LIST — rather than
// "the bike has no record", which is a claim about `0x17` nobody has made 63 times.
//
// ⚠️ IT IS BOUNDED BY A DEADLINE, not by the list. ../can/obd-hold.ts caps a hold at 15 s
// and the cap is enforced by the POLLER: past it the 2 Hz loop resumes underneath whatever
// is in flight, and a request landing mid-transfer is what makes the VCU abandon it. A
// 29-component list where every `0x17` stalls is ~51 s of work. So the loop stops while a
// whole component still fits, keeps what it has, and says so. docs/freeze-frame.md.
//
// The read itself is ../vcu/lifetime-read.ts's `readOneComponent` — one implementation of
// `0x17`, one definition of what counts as an answer.

/** How a whole read ended. Closed, so the store cannot meet a state it has no rule for. */
export type FreezeFrameReadCompletion =
  /** The `0x18` was read and every legal component on it was asked about. */
  | "complete"
  /** The deadline stopped the loop with components left unasked. What was read is kept. */
  | "budget-spent"
  /** The `0x18` itself failed, so nothing was asked and there is no list to judge against. */
  | "no-list"
  /** The `0x18` succeeded and the read then threw, or the client was stopped under it. */
  | "failed"
  /** `abort()` — the gate watchdog, or a shutdown. */
  | "cancelled";

/** What a read produced, and what it had to drop to produce it. */
export interface FreezeFrameReadResult {
  completion: FreezeFrameReadCompletion;
  /** Why, for every completion but `complete`. Null there. */
  reason: string | null;
  /** One per component ASKED about, in list order. `replies.length` is how many were asked. */
  replies: StoredLifetimeReply[];
  /**
   * Every component the `0x18` list named that this read was willing to ask about, after
   * padding, illegal components and duplicates were dropped.
   *
   * ⚠️ NOT the same as `replies.map(…)`, and the difference is the point: a `budget-spent`
   * read asked about a prefix of this. ../vcu/freeze-frame-store.ts needs the whole list to
   * tell "the bike no longer has that record" from "we did not get to it".
   */
  components: number[];
  /**
   * What the `0x18` said and what became of it — or **null when it never answered**.
   *
   * ⚠️ NULLABLE, and that is the store's whole guard against writing "the bike has nothing
   * stored" from a list it never read. It used to be a zero-filled report beside a
   * `completion` of `no-list`, which put the belief "this is the bike's answer" in an enum
   * next to the report rather than in the report — and the two disagreed the moment a THIRD
   * completion carried the same empty report. A gate watchdog aborting during the `0x18`
   * reports `cancelled`, correctly, and its zero-filled list passed every damage test:
   * five stored components were replaced by none.
   *
   * Reported rather than smoothed away otherwise, the way `decodeStoredDtcList` reports
   * `paddingRecords` and `trailingHex` instead of filtering them: "the VCU listed seven
   * records and we asked about five" and "the VCU has five records" are different
   * sentences, and the store's rules turn on which one this was.
   */
  list: FreezeFrameListReport | null;
  /** Worst flow-control latency across every transfer. The number the in-service path exists to take. */
  flowControl: ArrivalLatency | null;
  /** Worst event-loop delay while the read ran, ms. Null when it finished inside one 1 ms bin. */
  loopDelayMs: number | null;
  elapsedMs: number;
}

/** A read in flight. Same shape as ./lifetime-read.ts's, so ./read-runner.ts drives them alike. */
export interface RunningFreezeFrameRead {
  /** ⚠️ `arrival` is REQUIRED — dropping it un-measures the read and no check can see that. */
  handleFrame: (id: number, data: Buffer, arrival: FrameArrival | null) => boolean;
  abort: (reason: string) => void;
  finished: Promise<FreezeFrameReadResult>;
}

export interface FreezeFrameReadOptions {
  channel: RawChannel;
  /**
   * The deadline, ms. Defaults to `FREEZE_FRAME_READ_BUDGET_MS`.
   *
   * ⚠️ Injectable for checks only, alongside `now` below. Production passes neither.
   */
  budgetMs?: number;
  /**
   * The clock the deadline is measured on. Defaults to `monotonicNow`.
   *
   * ⚠️ A BYPASS AS MUCH AS A SEAM — the same warning scripts/check-arming.ts §7 makes
   * about its injected reading, and for a sharper reason: a `now` that does not advance
   * defeats the deadline entirely. No production call site passes one, and the check
   * asserts that rather than hoping. It exists because no double in this repo can burn a
   * worst-case component — replies come back in ~2 ms — so walking the real clock would
   * make the count depend on how loaded the laptop is.
   */
  now?: () => number;
}

/** Attempts per component. `readOneComponent`'s own default, named so the budget can use it. */
const ATTEMPTS_PER_COMPONENT = 2;

/**
 * The longest one component can take, session open included.
 *
 * Derived, never typed: ../vcu/kwp-client.ts owns the timeouts and does the arithmetic.
 * 1730 ms with today's defaults.
 */
export const WORST_CASE_COMPONENT_MS = worstCaseMultiFrameReadMs(ATTEMPTS_PER_COMPONENT);

/** The same for the `0x18`, which does not retry. 1020 ms today. */
export const WORST_CASE_LIST_MS = worstCaseMultiFrameReadMs(1);

/**
 * How much of the poller hold this read refuses to spend.
 *
 * ⚠️ It buys the LAST EXCHANGE, not the store write — that happens after both the hold and
 * the bus lease are released (../vcu/read-runner.ts). The deadline is checked before a
 * component starts, so the read can still be inside one when it fires; this is the room
 * that one has to finish in without the poller resuming under it.
 */
const HOLD_MARGIN_MS = 3000;

/**
 * The deadline. Derived from the cap it protects, so raising one moves the other.
 *
 * scripts/check-freeze-frame-values.ts asserts the two relationships that make it safe and
 * useful: `HOLD_MARGIN_MS > WORST_CASE_COMPONENT_MS`, so a component in flight when the
 * deadline fires still finishes inside the hold; and `budget >= 4 × WORST_CASE_COMPONENT_MS`,
 * so a margin that swallowed the budget fails even though the first still holds.
 */
export const FREEZE_FRAME_READ_BUDGET_MS = MAX_HOLD_MS - HOLD_MARGIN_MS;

/** Starts a read of every stored freeze frame. Resolves whatever happens; nothing here rejects. */
export function startFreezeFrameRead(options: FreezeFrameReadOptions): RunningFreezeFrameRead {
  const client = createVcuKwpClient(options.channel);
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const state: ReadState = {
    now: options.now ?? monotonicNow,
    budgetMs: options.budgetMs ?? FREEZE_FRAME_READ_BUDGET_MS,
    cancellation: null,
    startedAt: 0,
  };
  state.startedAt = state.now();
  const finished = runRead(client, state).finally(() => {
    loopDelay.disable();
    client.stop();
  });
  return {
    handleFrame: (id, data, arrival) => client.handleFrame(id, data, arrival),
    abort: reason => {
      // First reason wins, and it reaches the journal rather than only the caller: a
      // gate-closed abort and a shutdown store the same completion, and which it was is
      // the part worth knowing on a bike you cannot attach a debugger to.
      state.cancellation ??= reason;
      console.log(`freeze-frame: read aborted — ${reason}`);
      client.stop();
    },
    // ⚠️ `max` on an EMPTY histogram is 0, the "0.0 ms is what success looks like" trap
    // ../can/frame-arrival.ts refuses for the other instrument. A read that finished
    // before the first 1 ms tick has not measured the loop; it says so.
    finished: finished.then(partial => ({
      ...partial,
      loopDelayMs: loopDelay.count === 0 ? null : loopDelay.max / 1e6,
    })),
  };
}

interface ReadState {
  now: () => number;
  budgetMs: number;
  cancellation: string | null;
  startedAt: number;
}

type VcuKwpClientHandle = ReturnType<typeof createVcuKwpClient>;

async function runRead(
  client: VcuKwpClientHandle,
  state: ReadState
): Promise<Omit<FreezeFrameReadResult, "loopDelayMs">> {
  const listed = readList(await client.multiFrameRead("A8", { kind: "list-stored-dtcs" }));
  if ("failure" in listed) {
    // ⚠️ A cancel that lands during the `0x18` is a CANCEL, not a missing list. `client.stop()`
    // refuses the transmit, so the outcome arrives as "never reached the bus" — true, and the
    // wrong thing to tell somebody: the gate watchdog closing on a moving motorcycle and the
    // micro not answering are different events, and only one of them is about the bike being
    // broken. The store treats both the same way; the operator should not have to.
    if (state.cancellation !== null) {
      return finish(state, "cancelled", state.cancellation, [], [], null, null);
    }
    return finish(state, "no-list", listed.failure, [], [], null, null);
  }
  const decoded = decodeStoredDtcList(listed.body);
  const selection = selectComponentsToRead(decoded);
  console.log(
    `freeze-frame: 0x18 listed ${decoded.declaredCount} record(s) — asking about ${selection.components.length} ` +
      `(${selection.report.padding} padding, ${selection.report.outOfRange} out of range, ${selection.report.duplicate} duplicate)`
  );

  const replies: StoredLifetimeReply[] = [];
  // ⚠️ A box rather than a return value, for the same reason `replies` is appended to: what
  // was measured before a throw is exactly what a throw makes interesting, and a local in
  // `readEachComponent` would be lost with the stack.
  const measured: { flowControl: ArrivalLatency | null } = { flowControl: null };
  try {
    await readEachComponent(client, state, selection.components, replies, measured);
  } catch (err) {
    // ⚠️ CAUGHT HERE, WITH `replies` IN SCOPE. A throw escaping to ../vcu/read-runner.ts
    // is turned into one error string there, which would discard every component already
    // read — the same loss `selectComponentsToRead` exists to prevent, arrived at from
    // the other direction. Never swallowed: it is logged and it names the completion.
    console.error("freeze-frame: read threw:", err);
    const reason = err instanceof Error ? err.message : String(err);
    return finish(state, "failed", reason, replies, selection.components, selection.report, measured.flowControl);
  }
  if (state.cancellation !== null) {
    return finish(
      state,
      "cancelled",
      state.cancellation,
      replies,
      selection.components,
      selection.report,
      measured.flowControl
    );
  }
  if (replies.length < selection.components.length) {
    const reason =
      `stopped after ${replies.length} of ${selection.components.length} component(s): another read ` +
      `could take ${WORST_CASE_COMPONENT_MS} ms and the ${state.budgetMs} ms budget had ` +
      `${Math.round(state.budgetMs - (state.now() - state.startedAt))} ms left`;
    console.warn(`freeze-frame: ${reason}`);
    return finish(state, "budget-spent", reason, replies, selection.components, selection.report, measured.flowControl);
  }
  return finish(state, "complete", null, replies, selection.components, selection.report, measured.flowControl);
}

/**
 * Asks about each component until the list runs out, a cancel lands, or the budget does.
 *
 * Appends to `replies` and to `measured` as it goes rather than returning them, so the
 * caller still has what was read and what was measured when this throws.
 */
async function readEachComponent(
  client: VcuKwpClientHandle,
  state: ReadState,
  components: readonly number[],
  replies: StoredLifetimeReply[],
  measured: { flowControl: ArrivalLatency | null }
): Promise<void> {
  for (const component of components) {
    if (state.cancellation !== null) {
      return;
    }
    // ⚠️ LOOKAHEAD, not `elapsed > budget`. Checking whether the budget has already been
    // spent would let a component start one millisecond inside it and run a whole worst
    // case past it — which is true of `HOLD_MARGIN_MS` too, but then the read could no
    // longer promise that its elapsed time stays inside its own budget, and that promise
    // is what the check asserts.
    if (state.now() - state.startedAt + WORST_CASE_COMPONENT_MS > state.budgetMs) {
      return;
    }
    const { reply, latency } = await readOneComponent(client, component, ATTEMPTS_PER_COMPONENT);
    replies.push(reply);
    measured.flowControl = worseOf(measured.flowControl, latency);
  }
}

/**
 * The `0x18`'s body, or one line naming what went wrong.
 *
 * ⚠️ Returns the thing it validated rather than a `string | null` beside the outcome. As a
 * predicate it left the caller re-narrowing `outcome.reply.kind` afterwards, through a
 * 13-line branch the code itself had to label unreachable and invent a message for — a
 * branch that exists only to satisfy the type checker is a branch the next reader has to
 * work out is dead.
 */
function readList(outcome: VcuMultiFrameOutcome): { body: Uint8Array } | { failure: string } {
  switch (outcome.status) {
    case "reply": {
      if (outcome.reply.kind === "positive") {
        return { body: outcome.reply.body };
      }
      const reply = decodeMultiFrameReply(outcome.payload, 0x58);
      return {
        failure:
          reply.kind === "refused"
            ? `18 ReadDTCByStatus refused: ${reply.description}`
            : `18 ReadDTCByStatus: ${reply.kind === "unrecognised" ? reply.reason : "unusable reply"}`,
      };
    }
    case "no-response":
      return { failure: `18 ReadDTCByStatus: no reply, stalled at ${outcome.stage}` };
    case "abandoned":
      return { failure: `18 ReadDTCByStatus: reply discarded as unusable — ${outcome.reason}` };
    case "no-session":
      return { failure: `18 ReadDTCByStatus: ${outcome.reason}` };
    case "cancelled":
      return { failure: `18 ReadDTCByStatus: cancelled — ${outcome.reason}` };
    case "not-sent":
      return { failure: `18 ReadDTCByStatus: never reached the bus — ${outcome.reason}` };
  }
}

function finish(
  state: ReadState,
  completion: FreezeFrameReadCompletion,
  reason: string | null,
  replies: StoredLifetimeReply[],
  components: number[],
  list: FreezeFrameListReport | null,
  flowControl: ArrivalLatency | null
): Omit<FreezeFrameReadResult, "loopDelayMs"> {
  return {
    completion,
    reason,
    replies,
    components,
    list,
    flowControl,
    elapsedMs: Math.round(state.now() - state.startedAt),
  };
}

/**
 * A read as one line, in the vocabulary the rest of this repo logs in.
 *
 * ⚠️ It carries the MEASUREMENT, through ./lifetime-read.ts's own formatter. Both numbers —
 * how late our flow control was, and the worst event-loop delay — are taken on every read
 * here and were reaching nothing: not this line, not the endpoint, not the store. Over ~30
 * exchanges this is the larger population of the two paths that take them, so it is the one
 * more likely to catch a First Frame answered late, and `handleFrame`'s warning about
 * dropping `arrival` was guarding a number nobody read.
 */
export function describeFreezeFrameRead(result: FreezeFrameReadResult): string {
  const answered = answeredCount(result.replies);
  const scale =
    `${answered}/${result.components.length} listed component(s) answered in ` +
    `${(result.elapsedMs / 1000).toFixed(1)} s · ` +
    describeMeasurement({ replies: result.replies, flowControl: result.flowControl, loopDelayMs: result.loopDelayMs });
  switch (result.completion) {
    case "complete":
      return `freeze frames: read ${scale}`;
    case "budget-spent":
      return `freeze frames: TRUNCATED, ${scale} — ${result.reason}`;
    case "no-list":
      return `freeze frames: NO LIST — ${result.reason}`;
    case "failed":
      return `freeze frames: FAILED after ${scale} — ${result.reason}`;
    case "cancelled":
      return `freeze frames: STOPPED after ${scale} — ${result.reason}`;
  }
}
