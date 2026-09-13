import type { RawChannel } from "socketcan";
import { ageMs, latestValue } from "../can/signals.ts";
import { pollPidNow } from "../can/obd.ts";
import { requestTroubleCodeList } from "../can/obd-dtc.ts";
import { MODE_STORED_DTCS } from "../diagnostics/obd-dtc.ts";
import { recordTroubleCodeRead, troubleCodeSnapshot } from "../diagnostics/stored-codes.ts";
import { checkPiClock } from "./service-actions.ts";
import type { ServiceGateVerdict } from "./service-gate.ts";
import { clearStoredDtcs, type ClearDtcsOutcome, type RunningWriteSession } from "./write-session.ts";
import { appendAuditRecord } from "./write-audit.ts";
import type { ObdPollerHold } from "../can/obd-hold.ts";
import type { ServiceWriteAnswer } from "./write-runner.ts";

// OBD Mode 04, and the read-back that is the only thing separating "the bike said 44" from
// "the bike erased its fault memory".
//
// ⚠️ Twice this bike answered Mode 04 with a positive `44` and erased nothing — 2026-08-08
// and 2026-09-11, both journalled "Mode 04 accepted", with the stored count unmoved and PID 31
// still counting from 19 173 km. Once, on 2026-09-13, it swept 41 of 46 codes. Nothing on the
// screen or in the journal could tell the three apart. The captures, the five counters and the
// charger hypothesis: docs/clear-dtcs.md.
//
// Its own file rather than another 200 lines of write-runner.ts, which is four times the
// ~400-line split threshold already.

/** PID 01 — MIL lamp and the stored-code count. */
const PID_MONITOR_STATUS = 0x01;

/** PID 02 — the code the freeze frame was captured against. */
const PID_FREEZE_FRAME_DTC = 0x02;

/** PID 31 — kilometres since the codes were last cleared. The erasure proof. */
const PID_DISTANCE_SINCE_CLEAR = 0x31;

/**
 * The before-and-after of a clear, all read on the SAME parked bus within a few seconds.
 *
 * ⚠️ PID 31 falling to zero is the only one of these that PROVES the bike erased anything —
 * and only when it did not already read zero. See judgeErasure.
 */
export interface ClearDtcsCounts {
  /** PID 01's stored-code count, read immediately before the Mode 04. Null if it did not answer. */
  storedBefore: number | null;
  /** The same PID, read immediately after. */
  storedAfter: number | null;
  /** PID 31, distance since codes were last cleared. */
  distSinceClearBeforeKm: number | null;
  /** The same, after. */
  distSinceClearAfterKm: number | null;
  /** How many codes the fresh mode-03 transfer listed, or null when it did not complete. */
  listedAfter: number | null;
}

/** What PID 31 proves about this press. */
export type ErasureVerdict =
  /** It counted something before and reads zero now. The bike really erased its fault memory. */
  | "erased"
  /** It still reads what it read. The bike answered and did nothing — the 08-08 / 09-11 shape. */
  | "erased-nothing"
  /** It could not be read, or it already read zero, so this press cannot be judged on it. */
  | "unproven";

/**
 * ⚠️ A ZERO BEFORE-READING PROVES NOTHING, and that is not a corner case. Five of the 46 codes
 * came straight back on 2026-09-13, so pressing again a minute later is the expected gesture —
 * and on that press PID 31 reads 0 both times. Keying only on the after-value called that
 * "erased" in green, which is exactly the claim the two failures make and exactly the press that
 * most needs the verdict to be honest.
 */
export function judgeErasure(counts: ClearDtcsCounts): ErasureVerdict {
  if (counts.distSinceClearAfterKm === null || counts.distSinceClearBeforeKm === null) {
    return "unproven";
  }
  if (counts.distSinceClearAfterKm !== 0) {
    return "erased-nothing";
  }
  return counts.distSinceClearBeforeKm === 0 ? "unproven" : "erased";
}

/** What the caller needs of the runner. A subset of WriteContext, so the runner passes itself. */
export interface ClearDtcsContext {
  directory: string;
  gate: () => ServiceGateVerdict;
  holdPoller: (what: string) => Promise<ObdPollerHold | null>;
  running: RunningWriteSession | null;
}

/**
 * ⚠️ THE POLLER IS PARKED FIRST, and nothing is sent if it will not park. A mode-03 transfer
 * already in flight when the Mode 04 goes out would resolve AFTER it and file a pre-clear list
 * as the "after" — reporting "erased nothing" for a clear that worked. The poller is not
 * otherwise stopped by service mode, so this is the only thing that makes the two reads describe
 * the same moment.
 *
 * ⚠️ AND THE GATE IS RE-CHECKED TWICE INSIDE IT. `checkPreconditions` samples the gate once, and
 * the watchdog cannot cover this action's pre-frame window because nothing is in flight to abort
 * — so parking the poller (up to 6 s) and reading two PIDs would otherwise sit between the only
 * gate reading and an irreversible frame. A bike rolled during the park would have had its
 * diagnostic memory erased anyway.
 */
export async function performClearDtcs(context: ClearDtcsContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  const hold = await context.holdPoller("clearing the stored trouble codes");
  if (!hold) {
    return {
      ok: false,
      reason:
        "the OBD poller would not stop in time, so the bike could not be read back on either side of the clear — nothing was sent. Try again in a few seconds.",
    };
  }
  try {
    const parked = refuseIfUnsafe(context, "while the OBD poller parked");
    if (parked) {
      return parked;
    }
    return await clearOnParkedBus(context, channel);
  } finally {
    // Released on every path, including a throw: a leaked hold takes speed, rpm and the
    // temperatures off the dashboard AND out of the ride log, on a bike with no reception.
    hold.release();
  }
}

/** A refusal naming the blockers, or null when the bike is still safe to service. */
function refuseIfUnsafe(context: ClearDtcsContext, when: string): ServiceWriteAnswer | null {
  const verdict = context.gate();
  if (verdict.safe) {
    return null;
  }
  return {
    ok: false,
    reason: `the bike stopped being safe to service ${when} — ${verdict.blockers.join("; ")}. Nothing was sent.`,
  };
}

async function clearOnParkedBus(context: ClearDtcsContext, channel: RawChannel): Promise<ServiceWriteAnswer> {
  const before = await readClearCounters(channel);
  // The last gate reading before an irreversible frame, taken after the two PID reads rather
  // than only after the hold, so the unguarded window either side of the transmit is ~0.
  const rolling = refuseIfUnsafe(context, "while the counters were read");
  if (rolling) {
    return rolling;
  }

  console.warn("vcu-write: about to send OBD Mode 04 — the stored trouble codes and the freeze frame will be erased");
  const session = clearStoredDtcs(channel);
  context.running = session.session;
  const outcome = await session.finished;
  // ⚠️ Cleared HERE, not in `perform`'s finally, because the actuating exchange is over and
  // everything below is reads. `context.running` is what the gate watchdog and `runner.stop()`
  // both read as "an exchange is in flight"; leaving it set through the read-back made the
  // watchdog announce aborts it never performed. Clearing it early cannot fail quietly — the
  // frame router goes through it too, so an early clear times the exchange out and reports
  // `failed` on the first run.
  context.running = null;

  const after = outcome.status === "cleared" ? await readAfterClear(channel) : null;
  const counts: ClearDtcsCounts | undefined =
    after === null
      ? undefined
      : {
          storedBefore: before.storedCount,
          storedAfter: after.storedCount,
          distSinceClearBeforeKm: before.distSinceClearKm,
          distSinceClearAfterKm: after.distSinceClearKm,
          listedAfter: after.listedAfter,
        };
  const message = describeClear(context, outcome, counts);

  await appendAuditRecord(context.directory, {
    at: Date.now(),
    clockTrustworthy: checkPiClock({
      systemEpochMs: Date.now(),
      gpsEpochSeconds: latestValue("gps_epoch_s"),
      gpsAgeMs: ageMs("gps_epoch_s"),
    }).trustworthy,
    action: "clear-dtcs",
    status: outcome.status,
    // Recorded as read off the bus, so the journal is a witness rather than a transcript of what
    // the ECU claimed. The 08-08 and 09-11 lines say "cleared" and carry nothing to contradict them.
    before: describeCounters(before.storedCount, before.distSinceClearKm),
    after: after === null ? null : describeCounters(after.storedCount, after.distSinceClearKm),
    note: message,
  });

  return {
    ok: true,
    result: {
      action: "clear-dtcs",
      status: outcome.status,
      message,
      // ⚠️ NOT simply `status === "cleared"`. That is the ECU's word for it, and twice this bike
      // said it while erasing nothing. False only when PID 31 DISPROVES the erasure; a press that
      // cannot be judged stays true, because turning a missed 200 ms poll into "the bike refused"
      // would be the same invention in the other direction — the message says which.
      succeeded: outcome.status === "cleared" && (counts === undefined || judgeErasure(counts) !== "erased-nothing"),
      clear: counts,
    },
  };
}

/** PID 01 and PID 31, read now on the parked bus. Null for either that does not answer. */
async function readClearCounters(channel: RawChannel): Promise<{
  storedCount: number | null;
  distSinceClearKm: number | null;
}> {
  const answeredStatus = await pollPidNow(channel, PID_MONITOR_STATUS);
  const answeredDistance = await pollPidNow(channel, PID_DISTANCE_SINCE_CLEAR);
  // ⚠️ `latestValue` only after the poll ANSWERED. Reading it regardless would hand back the
  // always-on poller's last value — up to 10 s old for PID 01 — as a reading taken beside the frame.
  return {
    storedCount: answeredStatus ? latestValue("dtc_count") : null,
    distSinceClearKm: answeredDistance ? latestValue("dist_since_clear_km") : null,
  };
}

/**
 * The re-read after a positive Mode 04: the stored list, the freeze frame, and the counters.
 *
 * The mode-03 transfer does two jobs — it is the number the page shows, and it is what stops
 * /stored-dtcs serving the pre-clear list for the next minute. PID 02 is read because the freeze
 * frame is the one thing a clear is documented to take that nobody has ever watched it take: it
 * sits on the 10 s divisor, which is why the 2026-09-13 clear could not settle whether it
 * survived or was instantly re-captured.
 */
async function readAfterClear(channel: RawChannel): Promise<{
  storedCount: number | null;
  distSinceClearKm: number | null;
  listedAfter: number | null;
}> {
  const list = await requestTroubleCodeList(channel, MODE_STORED_DTCS);
  recordTroubleCodeRead(list, "stored");
  await pollPidNow(channel, PID_FREEZE_FRAME_DTC);
  const stored = troubleCodeSnapshot().stored;
  return {
    ...(await readClearCounters(channel)),
    listedAfter: stored.state === "codes" ? stored.codes.length : null,
  };
}

/** `46 stored, 19671 km since clear` — for the journal, where a shape is worth more than a number. */
function describeCounters(storedCount: number | null, distSinceClearKm: number | null): string {
  const stored = storedCount === null ? "stored count unread" : `${storedCount} stored`;
  const distance = distSinceClearKm === null ? "distance unread" : `${distSinceClearKm} km since clear`;
  return `${stored}, ${distance}`;
}

/**
 * What happened, in the words the page shows.
 *
 * ⚠️ A positive `44` is NOT success here, and this is the sentence that says so.
 */
function describeClear(
  context: ClearDtcsContext,
  outcome: ClearDtcsOutcome,
  counts: ClearDtcsCounts | undefined
): string {
  switch (outcome.status) {
    case "cleared":
      return describeAcceptedClear(context, counts as ClearDtcsCounts);
    case "refused":
      return `Refused: ${outcome.description}.`;
    case "failed":
      return `Nothing confirmed: ${outcome.reason}`;
  }
}

function describeAcceptedClear(context: ClearDtcsContext, counts: ClearDtcsCounts): string {
  const listed = counts.listedAfter === null ? "" : ` The list now holds ${counts.listedAfter}.`;
  switch (judgeErasure(counts)) {
    case "unproven":
      return (
        "Mode 04 accepted, but nothing here proves the bike acted on it — a positive answer alone has " +
        `twice meant nothing on this bike.${listed} ${unprovenReason(counts)}`
      );
    case "erased-nothing":
      return (
        "⚠️ Mode 04 was accepted AND THE BIKE ERASED NOTHING: distance since codes cleared still reads " +
        `${counts.distSinceClearAfterKm} km, which a real clear resets to zero within half a second. ` +
        twiceBeforeAdvice(context)
      );
    case "erased":
      return (
        `Cleared${countsSwept(counts)}. Distance since codes cleared went ${counts.distSinceClearBeforeKm} km → 0 km, ` +
        `which is the proof the bike really erased its fault memory.${listed} Codes whose faults are still active come straight back.`
      );
  }
}

/** Why a press could not be judged — the two reasons are different and the rider can act on one. */
function unprovenReason(counts: ClearDtcsCounts): string {
  if (counts.distSinceClearBeforeKm === 0) {
    return "Distance since codes cleared already read 0 km before the press, so it cannot show a reset. Ride, then read the Faults tab.";
  }
  return "The counters could not be read back. Check the Faults tab in a minute.";
}

/**
 * ⚠️ The imperative is conditioned on the gate. The dashboard's cable caution is; this sentence
 * was not, so a failed clear on the 2026-09-13 shape — no charge manager on the bus at all —
 * advised unplugging a cable the Pi has no evidence for, and said so into the audit journal too.
 */
function twiceBeforeAdvice(context: ClearDtcsContext): string {
  const observation = "This has happened twice before, both times with a cable or a charge involved.";
  const gate = context.gate();
  const cablePresent =
    gate.chargingEvidence !== null || gate.checks.find(check => check.key === "charge_manager_status")?.state === "ok";
  return cablePresent ? `${observation} There is a cable in the inlet now — unplug it and try again.` : observation;
}

/** `: 46 stored → 5 stored, 41 cleared`, or nothing when a count is missing or went the wrong way. */
function countsSwept(counts: ClearDtcsCounts): string {
  if (counts.storedBefore === null || counts.storedAfter === null) {
    return "";
  }
  const swept = counts.storedBefore - counts.storedAfter;
  const tail = swept < 0 ? `${-swept} MORE than before` : `${swept} cleared`;
  return `: ${counts.storedBefore} stored → ${counts.storedAfter} stored, ${tail}`;
}
