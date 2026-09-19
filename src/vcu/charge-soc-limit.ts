import type { RawChannel } from "socketcan";
import { ageMs, latestValue } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { buildChargeSocLimitRead, buildChargeSocLimitWrite } from "../can/charge-soc-command.ts";
import { toHex } from "./param-codec.ts";
import { readPiClock } from "./service-actions.ts";
import { appendAuditRecord, type AuditRecord } from "./write-audit.ts";
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

/**
 * How long to let the VCU apply a write before reading it back. The committed
 * scripts/dash-command-write.ts uses 40 ms and it read back correctly on 2026-09-19; the
 * independent read 18 s later agreed, so 40 is not a value the answer is balanced on.
 */
const WRITE_SETTLE_MS = 40;

/**
 * How long to wait for the VCU's reply before giving up.
 *
 * ⚠️ The bike answers in single-digit milliseconds — 1.586, 3.252 and 7.664 ms in the capture of
 * this Pi's own exchanges. The 500 is for the SEND path, not the reply: the probe's first
 * `channel.send` took 83 ms to reach the wire on this Zero 2 W. A "99 ms cold reply" measured
 * from the sender was that send, and docs/dash-command-0x2c-charge-limit.md says so.
 */
const READ_TIMEOUT_MS = 500;

/** How often to look for the reply while waiting. */
const READ_POLL_MS = 10;

/** The signal the reply lands on, via the ordinary RX path and src/can/charge-soc-limit.ts. */
const SOC_LIMIT_SIGNAL = "charge_soc_limit_pct";

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
  percent: number,
  channel: RawChannel
): Promise<ServiceWriteAnswer> {
  const before = await readSocLimit(channel);
  console.warn(`vcu-write: about to set the SOC charge limit to ${percent} % (it reads ${describe(before)})`);
  const sent = sendSocLimit(channel, percent);
  if (sent.status === "failed") {
    await recordAttempt(context, {
      action: "charge-soc-limit",
      status: "failed",
      requested: percent,
      before,
      after: null,
      note: sent.reason,
    });
    return { ok: false, reason: sent.reason };
  }
  await delay(WRITE_SETTLE_MS);
  const after = await readSocLimit(channel);
  // ⚠️ THREE outcomes, not two. A read that TIMED OUT says nothing about the write — the frame went
  // out and the READ got no answer — so calling it a mismatch would assert the opposite of what is
  // known, in the one sentence a person standing at the bike acts on. Same distinction this whole
  // feature keeps between "the VCU stores it" and "the bike stops there".
  const outcome: SocLimitOutcome = after === null ? "unverified" : after === percent ? "written" : "read-back-mismatch";
  const said = describeOutcome(outcome, percent, before, after, sent.hex);
  await recordAttempt(context, {
    action: "charge-soc-limit",
    status: outcome,
    requested: percent,
    before,
    after,
    rawHex: sent.hex,
    note: said.note,
  });
  return {
    ok: true,
    result: { action: "charge-soc-limit", status: outcome, message: said.message, succeeded: outcome === "written" },
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
  const value = await readSocLimit(channel);
  await recordAttempt(context, {
    action: "charge-soc-limit-read",
    status: value === null ? "failed" : "read",
    after: value,
    note: value === null ? `no reply within ${READ_TIMEOUT_MS} ms` : `the VCU's store reads ${value} %`,
  });
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

/**
 * What a write turned out to be. ⚠️ Three cases, and `describeOutcome`'s switch has no default, so
 * a fourth is a compile error rather than a missing sentence discovered on the bike.
 */
type SocLimitOutcome = "written" | "read-back-mismatch" | "unverified";

/** The audit note and the rider-facing sentence for one outcome, which belong together. */
function describeOutcome(
  outcome: SocLimitOutcome,
  percent: number,
  before: number | null,
  after: number | null,
  hex: string
): { note: string; message: string } {
  switch (outcome) {
    case "written":
      return {
        note: `${percent} % on 0x120 (${hex}); read back from the VCU's store as ${after} %`,
        message:
          `The bike will now stop charging at ${percent} % (was ${describe(before)}). ` +
          "Read back from the VCU's own store, not an echo. ⚠️ That it STORES the limit is not proof it " +
          "stops there — nothing here has watched the limit be reached — so check the dash and the next full charge.",
      };
    case "read-back-mismatch":
      return {
        note: `asked for ${percent} %, the VCU's store reads ${describe(after)} afterwards`,
        message:
          `Asked for ${percent} %, but the VCU's store reads ${describe(after)}. Nothing was changed as asked; ` +
          "the bike may have clamped or ignored the value. Do not retry blind — read it on the bike's own screen first.",
      };
    case "unverified":
      return {
        note: `${percent} % on 0x120 (${hex}); the write went out and the read-back got NO answer within ${READ_TIMEOUT_MS} ms — unknown, not failed`,
        message:
          `The ${percent} % command went out, but the read-back got no answer. ⚠️ This does NOT mean it failed — ` +
          "the write and the read are separate frames and only the read went unanswered. Read it again, or check the bike's own screen.",
      };
  }
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
async function readSocLimit(channel: RawChannel): Promise<number | null> {
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

function describe(percent: number | null): string {
  if (percent === null) {
    return "unknown";
  }
  return percent === 0 ? "no limit" : `${percent} %`;
}

/**
 * One audit line. Takes the record rather than seven positional arguments — three of which were
 * adjacent `number | null` (requested, before, after), where a transposition typechecks and no
 * check catches it. The two stamped fields are the only thing this adds.
 */
async function recordAttempt(
  context: ChargeSocLimitContext,
  record: Omit<AuditRecord, "at" | "clockTrustworthy">
): Promise<void> {
  await appendAuditRecord(context.directory, {
    ...record,
    at: Date.now(),
    clockTrustworthy: readPiClock().trustworthy,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}
