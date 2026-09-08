import { monitorEventLoopDelay } from "node:perf_hooks";
import type { RawChannel } from "socketcan";
import type { ArrivalLatency, FrameArrival } from "../can/frame-arrival.ts";
import { LIFETIME_COMPONENTS } from "../diagnostics/lifetime-stats.ts";
import { createVcuKwpClient, type VcuMultiFrameOutcome } from "./kwp-client.ts";
import { toHex } from "./multiframe-codec.ts";
import type { StoredLifetimeReply } from "./lifetime-store.ts";

// Reading components 51 and 52 off A8 — the one read this feature is built on, in the
// one place both callers use it.
//
// ⚠️ TWO CALLERS, ONE READ. scripts/read-freeze-frame.ts --lifetime runs it with the
// service stopped; ./read-runner.ts runs it in-service. Writing it twice would leave
// two implementations that must agree forever about what lands in one file, on a
// feature whose whole premise is that the stored reading is the interface.
//
// ⚠️ AND IT MEASURES ITSELF. The question this path exists to settle is whether the
// service's listener can answer a First Frame in time, which is a property of this
// process's event loop and cannot be seen from a capture taken with the service
// stopped. Two independent numbers come back with the reading — see `LifetimeReadResult`.

/** One read in flight. Same shape as ./probe.ts's, so ./read-runner.ts drives all three alike. */
export interface RunningLifetimeRead {
  handleFrame: (id: number, data: Buffer, arrival?: FrameArrival | null) => boolean;
  abort: (reason: string) => void;
  finished: Promise<LifetimeReadResult>;
}

/** What a read produced, plus what it observed about the process that ran it. */
export interface LifetimeReadResult {
  /** One per component asked about, in order, whatever came back. */
  replies: StoredLifetimeReply[];
  /**
   * Kernel arrival of a First Frame → our flow control on the wire, worst of the two
   * transfers. THE number: null when no transfer needed a flow control, `known: false`
   * when the kernel gave no stamp or the clock stepped.
   */
  flowControl: ArrivalLatency | null;
  /**
   * Worst event-loop delay while the read ran, in ms.
   *
   * The second, independent instrument. It needs no timestamp threaded anywhere and is
   * available whatever this build of `socketcan` does with receive stamps — so if the
   * kernel stamp turns out absent, this still bounds the answer.
   */
  loopDelayMs: number | null;
}

export interface LifetimeReadOptions {
  channel: RawChannel;
  /**
   * Attempts per component. Two — one retry.
   *
   * ⚠️ HERE, at the `0x17` caller, and never inside `multiFrameRead`. ./kwp-client.ts
   * refuses to retry a multi-frame timeout deliberately: `0x36` advances the micro's
   * upload position, so a repeat could skip or replay a block. `0x17` is idempotent and
   * carries no such position, which is why it may retry and the bulk log may not.
   */
  attempts?: number;
}

const DEFAULT_ATTEMPTS = 2;

/** Starts a read of both components. Resolves whatever happens; nothing here rejects. */
export function startLifetimeRead(options: LifetimeReadOptions): RunningLifetimeRead {
  const client = createVcuKwpClient(options.channel);
  // resolution: 1 ms bins are plenty for a question whose threshold is ~10 ms, and the
  // histogram runs in libuv rather than on the loop it is measuring.
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  const finished = readBothComponents(client, options.attempts ?? DEFAULT_ATTEMPTS).finally(() => {
    loopDelay.disable();
    client.stop();
  });
  return {
    handleFrame: (id, data, arrival) => client.handleFrame(id, data, arrival),
    abort: () => client.stop(),
    finished: finished.then(partial => ({ ...partial, loopDelayMs: loopDelay.max / 1e6 })),
  };
}

/**
 * One component, with its retry. Exported so scripts/read-freeze-frame.ts prints the
 * same outcome this stores rather than reading the bike twice to get both.
 */
export async function readOneComponent(
  client: ReturnType<typeof createVcuKwpClient>,
  component: number,
  attempts = DEFAULT_ATTEMPTS
): Promise<{ reply: StoredLifetimeReply; outcome: VcuMultiFrameOutcome }> {
  let outcome = await client.multiFrameRead("A8", { kind: "read-freeze-frame", component });
  for (let attempt = 1; attempt < attempts && shouldRetry(outcome); attempt += 1) {
    console.log(`lifetime: component ${component} came back ${outcome.status} — asking once more`);
    outcome = await client.multiFrameRead("A8", { kind: "read-freeze-frame", component });
  }
  return { reply: toStoredReply(component, outcome), outcome };
}

/**
 * Whether a second ask is worth making.
 *
 * Only for the outcomes a retry can fix: silence and a discarded reply. A refusal, a
 * closed session or a frame that never reached the bus are all answers, and asking
 * again would hammer a shared bus to be told the same thing.
 */
function shouldRetry(outcome: VcuMultiFrameOutcome): boolean {
  return outcome.status === "no-response" || outcome.status === "abandoned";
}

/** The outcome in the store's own shape. A non-frame reply still carries its bytes. */
function toStoredReply(component: number, outcome: VcuMultiFrameOutcome): StoredLifetimeReply {
  if (outcome.status !== "reply") {
    return { component, payloadHex: null, failure: outcome.status };
  }
  return { component, payloadHex: toHex(outcome.payload), failure: null };
}

async function readBothComponents(
  client: ReturnType<typeof createVcuKwpClient>,
  attempts: number
): Promise<Omit<LifetimeReadResult, "loopDelayMs">> {
  const replies: StoredLifetimeReply[] = [];
  let flowControl: ArrivalLatency | null = null;
  for (const component of [LIFETIME_COMPONENTS.packState, LIFETIME_COMPONENTS.counters]) {
    const { reply, outcome } = await readOneComponent(client, component, attempts);
    replies.push(reply);
    if (outcome.status === "reply") {
      flowControl = worseOf(flowControl, outcome.flowControlLatency);
    }
  }
  return { replies, flowControl };
}

/**
 * The worse of two latencies, so one good transfer cannot hide a slow one.
 *
 * An unusable reading beats a known one: "we could not measure it" is the answer that
 * must reach the doc, rather than being averaged away by the transfer that did.
 */
function worseOf(left: ArrivalLatency | null, right: ArrivalLatency | null): ArrivalLatency | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  if (!left.known || !right.known) {
    return left.known ? right : left;
  }
  return right.ms > left.ms ? right : left;
}
