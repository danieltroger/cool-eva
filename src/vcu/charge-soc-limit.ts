import type { RawChannel } from "socketcan";
import { ageMs, latestValue } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { buildChargeSocLimitRead, buildChargeSocLimitWrite } from "../can/charge-soc-command.ts";
import { toHex } from "./param-codec.ts";
import { readPiClock } from "./service-actions.ts";
import { appendAuditRecord } from "./write-audit.ts";
import type { ServiceWriteAnswer } from "./write-runner.ts";

// The bike's "stop charging at N %" setting, over the 0x120 dash command channel — the one write
// action in this repo with a REAL read-back, because the channel answers a read with the VCU's
// stored value rather than an echo (send b2 = 0, get 0x5A back).
//
// Its own file rather than more of write-runner.ts (1464 lines) or write-session.ts (1352): this is
// a request/response round trip with a poll loop, where everything in those is either
// fire-and-forget or a KWP session. Proven on-bike 2026-09-19: 80 → 90, read back twice.
// docs/dash-command-0x2c-charge-limit.md.

/** What this needs from the write runner's context. Deliberately the audit directory and nothing else. */
export interface ChargeSocLimitContext {
  directory: string;
}

export interface ChargeSocLimitRequest {
  percent: number;
}

/**
 * How long to let the VCU apply a write before reading it back. The committed
 * scripts/dash-command-write.ts uses 40 ms and it read back correctly on 2026-09-19; the
 * independent read 18 s later agreed, so 40 is not a value the answer is balanced on.
 */
const WRITE_SETTLE_MS = 40;

/** How long to wait for the VCU's reply before giving up. It answered in 5 ms warm, 99 ms cold. */
const READ_TIMEOUT_MS = 500;

/** How often to look for the reply while waiting. */
const READ_POLL_MS = 10;

/** The signal the reply lands on, via the ordinary RX path and src/can/charge-soc-limit.ts. */
const SOC_LIMIT_SIGNAL = "charge_soc_limit_pct";

/**
 * The bike is awake and CAN is arriving. `0x625` broadcasts at 10 Hz whenever the bike is awake —
 * parked and unplugged included — so a stale one means we would be commanding into silence.
 */
const AWAKE_SIGNAL = "fast_dc_limit_max_a";
const AWAKE_MAX_AGE_MS = 5_000;

/**
 * Sets the SOC charge limit and PROVES it took, by reading the VCU's own stored value back.
 *
 * ⚠️ Unlike charge-current, this does not have to settle for "sent". The write is one frame on
 * 0x120 and the read that follows is a different frame with bit 7 clear, which the VCU answers
 * out of its store — so `after` in the audit record is what the bike holds, not what we asked for.
 *
 * ⚠️ What it still cannot prove is that the bike STOPS at that percentage. Nothing in this repo
 * has ever observed the limit being reached; only a charge that gets there settles that.
 */
export async function performChargeSocLimit(
  context: ChargeSocLimitContext,
  request: ChargeSocLimitRequest,
  channel: RawChannel
): Promise<ServiceWriteAnswer> {
  const asleep = describeIfAsleep("set the charge limit on");
  if (asleep !== null) {
    return { ok: false, reason: asleep };
  }
  const before = await readSocLimit(channel);
  console.warn(`vcu-write: about to set the SOC charge limit to ${request.percent} % (it reads ${describe(before)})`);
  const sent = sendSocLimit(channel, request.percent);
  if (sent.status === "failed") {
    await recordAttempt(context, "charge-soc-limit", "failed", request.percent, before, null, sent.reason);
    return { ok: false, reason: sent.reason };
  }
  await delay(WRITE_SETTLE_MS);
  const after = await readSocLimit(channel);
  const took = after === request.percent;
  await recordAttempt(
    context,
    "charge-soc-limit",
    took ? "written" : "read-back-mismatch",
    request.percent,
    before,
    after,
    took
      ? `${request.percent} % on 0x120 (${sent.hex}); read back from the VCU's store as ${after} %`
      : `asked for ${request.percent} %, the VCU's store reads ${describe(after)} afterwards`
  );
  return {
    ok: true,
    result: {
      action: "charge-soc-limit",
      status: took ? "written" : "read-back-mismatch",
      message: took
        ? `The bike will now stop charging at ${request.percent} % (was ${describe(before)}). ` +
          "Read back from the VCU's own store, not an echo. ⚠️ That it STORES the limit is not proof it " +
          "stops there — nothing here has watched the limit be reached — so check the dash and the next full charge."
        : `Asked for ${request.percent} %, but the VCU's store reads ${describe(after)}. Nothing was changed as asked; ` +
          "the bike may have clamped or ignored the value. Do not retry blind — read it on the bike's own screen first.",
      succeeded: took,
    },
  };
}

/**
 * Reads the SOC charge limit without changing it. Bit 7 clear, one frame.
 *
 * Non-mutating, and that is measured rather than assumed on this id: two reads a second apart on
 * 2026-09-19 both returned 80, and the reply carried 0x50 where the request carried 0.
 */
export async function performChargeSocLimitRead(
  context: ChargeSocLimitContext,
  channel: RawChannel
): Promise<ServiceWriteAnswer> {
  const asleep = describeIfAsleep("read the charge limit off");
  if (asleep !== null) {
    return { ok: false, reason: asleep };
  }
  const value = await readSocLimit(channel);
  await recordAttempt(
    context,
    "charge-soc-limit-read",
    value === null ? "failed" : "read",
    null,
    null,
    value,
    value === null ? `no reply within ${READ_TIMEOUT_MS} ms` : `the VCU's store reads ${value} %`
  );
  if (value === null) {
    return {
      ok: false,
      reason: `the VCU did not answer the charge-limit read within ${READ_TIMEOUT_MS} ms. The bike may have gone to sleep.`,
    };
  }
  return {
    ok: true,
    result: {
      action: "charge-soc-limit-read",
      status: "read",
      message:
        value === 0
          ? "No charge limit is set — the bike will charge to full."
          : `The bike is set to stop charging at ${value} %.`,
      succeeded: true,
    },
  };
}

/** Transmits the one-frame write. Fire-and-forget; the read that follows is the verification. */
function sendSocLimit(
  channel: RawChannel,
  percent: number
): { status: "sent"; hex: string } | { status: "failed"; reason: string } {
  let frames;
  try {
    frames = buildChargeSocLimitWrite(percent);
  } catch (err) {
    // Surfaced rather than swallowed: a silently-dropped command looks exactly like one the bike
    // ignored, and this one is supposed to be range-checked upstream.
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  const frame = frames[0];
  try {
    channel.send({ id: frame.id, ext: false, rtr: false, data: Buffer.from(frame.data) });
  } catch (err) {
    console.error(`vcu-write: could not transmit the SOC charge-limit frame on 0x${frame.id.toString(16)}`, err);
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  const hex = `0x${frame.id.toString(16)} ${toHex(frame.data)}`;
  console.warn(`vcu-write: sent the SOC charge limit ${percent} % — ${hex}`);
  return { status: "sent", hex };
}

/**
 * Asks the VCU for its stored limit and waits for the answer, or null if none comes.
 *
 * ⚠️ THE MARK IS TAKEN IMMEDIATELY BEFORE THIS TRANSMIT, never before the write that may precede
 * it. The bike answers our WRITE with a 0x121 of its own within ~6 ms, so a mark taken before the
 * write is satisfied by that answer — a read-back that cannot fail, which is the failure mode this
 * repo names by hand. check-charge-soc-limit-runner.ts §2 mutates the mark earlier and must go red.
 *
 * The reply arrives through the ordinary RX path (0x121 is in STREAM_IDS and in the kernel filter),
 * so this waits on the signal rather than adding a second listener to keep in step. `record()`
 * refreshes the arrival mark outside the deadband branch, so an unchanged value still counts.
 */
export async function readSocLimit(channel: RawChannel): Promise<number | null> {
  const frame = buildChargeSocLimitRead()[0];
  const markedAt = monotonicNow();
  try {
    channel.send({ id: frame.id, ext: false, rtr: false, data: Buffer.from(frame.data) });
  } catch (err) {
    console.error("vcu-write: could not transmit the SOC charge-limit read request", err);
    return null;
  }
  while (since(markedAt) < READ_TIMEOUT_MS) {
    await delay(READ_POLL_MS);
    const age = ageMs(SOC_LIMIT_SIGNAL);
    // age ≤ since(mark) means the reading arrived AFTER the mark — the comparison is done in
    // elapsed time rather than by reconstructing an absolute mark, so there is nothing to get
    // the sign of wrong.
    if (age !== null && age <= since(markedAt)) {
      return latestValue(SOC_LIMIT_SIGNAL);
    }
  }
  console.warn(`vcu-write: no charge-limit reply within ${READ_TIMEOUT_MS} ms`);
  return null;
}

/** Why the bike cannot be asked right now, or null when it can. */
function describeIfAsleep(what: string): string | null {
  const age = ageMs(AWAKE_SIGNAL);
  if (age === null) {
    return `nothing has arrived on ${AWAKE_SIGNAL} this session, so there is no evidence the bike is awake to ${what}.`;
  }
  if (age > AWAKE_MAX_AGE_MS) {
    return `${AWAKE_SIGNAL} last arrived ${Math.round(age / 1000)} s ago — the bike is asleep or CAN is not being received, so there is nothing to ${what}.`;
  }
  return null;
}

function describe(percent: number | null): string {
  if (percent === null) {
    return "unknown";
  }
  return percent === 0 ? "no limit" : `${percent} %`;
}

async function recordAttempt(
  context: ChargeSocLimitContext,
  action: "charge-soc-limit" | "charge-soc-limit-read",
  status: string,
  requested: number | null,
  before: number | null,
  after: number | null,
  note: string
): Promise<void> {
  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
    action,
    status,
    requested,
    before,
    after,
    note,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}
