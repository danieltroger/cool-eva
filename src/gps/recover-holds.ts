import { FIX_MAX_AGE_MS, WAYPOINT_REFUSAL, type WaypointRefusal } from "./waypoint.ts";
import { distanceKm, implausibleJumpKmh, isPositionOnEarth, type Fix } from "./fix-plausibility.ts";

// Reconstructing, from a decoded ride log, the waypoints a handlebar hold asked for and
// never got. Pure: rows in, verdicts out, no clock read, no I/O, no database — so
// scripts/check-recover-waypoints.ts drives every branch from synthetic fixtures and
// scripts/recover-waypoints.ts is only the shell that fetches rows and writes results.
//
// ⚠️ It reproduces what the Pi WOULD have done, gate for gate, rather than deciding afresh
// what a good waypoint is. That is why the gates are imported from ./waypoint.ts and
// ./fix-plausibility.ts instead of restated: a recovery that is stricter than the bike
// invents refusals the rider never had, and one that is looser invents waypoints.
// docs/waypoints.md §"Recovering the holds the phone dropped".

/** One row of one signal, as the ride log holds it. */
export interface LogRow {
  ts: number;
  value: number;
  /** Which run of the service wrote it. Presses are paired WITHIN one of these. */
  sessionId: number | null;
  /** Write order inside that session — see src/db.ts on why this is not ORDER BY ts. */
  seq: number | null;
}

/** A button press recovered from the log's rising and falling edges. */
export interface RecoveredPress {
  startedAt: number;
  durationMs: number;
  sessionId: number | null;
}

export const RECOVERY_OUTCOME = {
  /** A waypoint the bike should have saved and did not. */
  RECOVERED: "recovered",
  /** The hold fired at the time and the waypoint is already in the log. */
  ALREADY_LIVE: "already-live",
  /** A gate refused it, exactly as the bike would have. */
  REFUSED: "refused",
} as const;

export type RecoveryOutcome = (typeof RECOVERY_OUTCOME)[keyof typeof RECOVERY_OUTCOME];

export interface RecoveryVerdict {
  press: RecoveredPress;
  /** pressStart + holdMs — where the recogniser's threshold falls. */
  fireAt: number;
  outcome: RecoveryOutcome;
  latitudeDeg?: number;
  longitudeDeg?: number;
  refusal?: WaypointRefusal;
  /** How old the carried-back position row was. Reported, never gated on — see below. */
  positionAgeMs?: number;
  /**
   * ⚠️ Whether implausibleJumpKmh() actually looked at this point, or fell through.
   *
   * MIN_FIX_INTERVAL_MS is 1 s and the hub delivers fixes at ~1.8 Hz, so 96.3 % of fix
   * pairs on 2026-09-09 are closer together than the gate's own floor and it answers null
   * without judging. The bike ran the same gate in the same regime, so this is faithful
   * rather than broken — but a report that prints "jump gate: passed" is claiming a test
   * that did not run.
   */
  jumpGateJudged: boolean;
}

/**
 * Pairs a button signal's rows into presses.
 *
 * ⚠️ Three rules, each of which cost a wrong number before it was written down:
 * per SESSION and ordered by seq, because `ts` is wall clock and the Pi steps it; a press
 * opens only on a WATCHED 0→1, the rule src/gestures/long-press.ts enforces with
 * `state.previous === 0`, so a session whose first row is already 1 contributes nothing;
 * and a press still open when a session ends is discarded rather than closed by the next
 * session's first row.
 */
export function pairPresses(rows: LogRow[]): RecoveredPress[] {
  const ordered = [...rows].sort(comparePressRows);
  const presses: RecoveredPress[] = [];
  const openedAt = new Map<number | null, number>();
  const previous = new Map<number | null, number>();
  for (const row of ordered) {
    const seen = previous.get(row.sessionId);
    if (seen === undefined) {
      previous.set(row.sessionId, row.value);
      continue;
    }
    if (row.value === seen) {
      continue;
    }
    if (row.value === 1) {
      openedAt.set(row.sessionId, row.ts);
    } else {
      const startedAt = openedAt.get(row.sessionId);
      if (startedAt !== undefined) {
        presses.push({ startedAt, durationMs: row.ts - startedAt, sessionId: row.sessionId });
        openedAt.delete(row.sessionId);
      }
    }
    previous.set(row.sessionId, row.value);
  }
  return presses.sort((left, right) => left.startedAt - right.startedAt);
}

/**
 * Which presses already produced a waypoint, matched FORWARD IN TIME.
 *
 * ⚠️ A waypoint belongs to the press it fired FROM, so the only candidates are presses
 * that began before it and were still down when it landed. Matching by nearest instant
 * instead lets one waypoint vouch for several presses, which is how the same four holds
 * were miscounted twice — first as 3 losses, then as the wrong fourth one. The delays this
 * produces are their own proof: all 28 on 2026-09-09 land in 1000-1145 ms, at the two
 * beats of a 100 ms cadence, which a wrong pairing does not reproduce.
 */
export function matchLiveWaypoints(
  presses: RecoveredPress[],
  waypointRows: LogRow[],
  toleranceMs: number
): Set<RecoveredPress> {
  const fired = new Set<RecoveredPress>();
  for (const waypoint of [...waypointRows].sort((left, right) => left.ts - right.ts)) {
    let best: RecoveredPress | null = null;
    let bestDelay = Number.POSITIVE_INFINITY;
    for (const press of presses) {
      if (fired.has(press)) {
        continue;
      }
      const delay = waypoint.ts - press.startedAt;
      if (delay > 0 && delay <= press.durationMs + toleranceMs && delay < bestDelay) {
        bestDelay = delay;
        best = press;
      }
    }
    if (best !== null) {
      fired.add(best);
    }
  }
  return fired;
}

/** The last value logged at or before an instant, or null if the signal had not started. */
export function carryBack(rows: LogRow[], at: number): LogRow | null {
  let found: LogRow | null = null;
  for (const row of rows) {
    if (row.ts > at) {
      break;
    }
    found = row;
  }
  return found;
}

function comparePressRows(left: LogRow, right: LogRow): number {
  const leftSession = left.sessionId ?? -1;
  const rightSession = right.sessionId ?? -1;
  if (leftSession !== rightSession) {
    return leftSession - rightSession;
  }
  if (left.seq !== null && right.seq !== null && left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  return left.ts - right.ts;
}

/** Every signal timeline a verdict needs, already fetched. */
export interface RecoveryInputs {
  cancelRows: LogRow[];
  latitudeRows: LogRow[];
  longitudeRows: LogRow[];
  /** The receiver's own clock tick — the liveness witness. See gateFreshness(). */
  epochRows: LogRow[];
  waypointRows: LogRow[];
  holdMs: number;
  /** How far past the release a live waypoint may land and still belong to that press. */
  liveToleranceMs: number;
}

/** Runs every hold in a log through the gates the bike would have applied. */
export function judgeHolds(inputs: RecoveryInputs): RecoveryVerdict[] {
  const presses = pairPresses(inputs.cancelRows).filter(press => press.durationMs >= inputs.holdMs);
  const alreadyFired = matchLiveWaypoints(presses, inputs.waypointRows, inputs.liveToleranceMs);
  const fixes = buildFixTimeline(inputs.latitudeRows, inputs.longitudeRows);
  return presses.map(press => judgeOneHold(press, press.startedAt + inputs.holdMs, alreadyFired, fixes, inputs));
}

function judgeOneHold(
  press: RecoveredPress,
  fireAt: number,
  alreadyFired: Set<RecoveredPress>,
  fixes: Fix[],
  inputs: RecoveryInputs
): RecoveryVerdict {
  if (alreadyFired.has(press)) {
    return { press, fireAt, outcome: RECOVERY_OUTCOME.ALREADY_LIVE, jumpGateJudged: false };
  }
  const latitude = carryBack(inputs.latitudeRows, fireAt);
  const longitude = carryBack(inputs.longitudeRows, fireAt);
  if (latitude === null || longitude === null) {
    return refused(press, fireAt, WAYPOINT_REFUSAL.NO_FIX);
  }
  if (!isPositionOnEarth(latitude.value, longitude.value)) {
    return refused(press, fireAt, WAYPOINT_REFUSAL.FIX_NOT_ON_EARTH);
  }
  // ⚠️ FRESHNESS IS WITNESSED BY gps_epoch_s AND NOT BY THE POSITION ROWS. The Pi's gate
  // measures the age of the LIVE sample; a log holds only logged rows, and gps_lat/gps_lon
  // carry a ~3 m deadband. The distance that costs is bounded — src/can/signals.ts compares
  // against the last LOGGED value, so the live fix is always within one deadband of the
  // carry-back, at any row age — but a receiver that went silent while the bike kept moving
  // is a real hole, and this is the gate that catches it.
  const epoch = nearestRow(inputs.epochRows, fireAt);
  if (epoch === null || Math.abs(epoch.ts - fireAt) > FIX_MAX_AGE_MS) {
    return refused(press, fireAt, WAYPOINT_REFUSAL.FIX_STALE);
  }
  const { jump, judged } = judgeJump(fixes, fireAt);
  if (jump !== null) {
    return { ...refused(press, fireAt, WAYPOINT_REFUSAL.FIX_IMPLAUSIBLE), jumpGateJudged: judged };
  }
  return {
    press,
    fireAt,
    outcome: RECOVERY_OUTCOME.RECOVERED,
    latitudeDeg: latitude.value,
    longitudeDeg: longitude.value,
    positionAgeMs: fireAt - Math.max(latitude.ts, longitude.ts),
    jumpGateJudged: judged,
  };
}

/**
 * Fix pairs formed the way ../gps/waypoint.ts's onFixChanged() forms them.
 *
 * ⚠️ A pair at EVERY gps_lat OR gps_lon row, carrying the other axis back — not consecutive
 * gps_lat rows. The two are deadbanded independently, so pairing one axis against itself
 * feeds implausibleJumpKmh() pairs the bike never held and judges a jump it never saw.
 */
export function buildFixTimeline(latitudeRows: LogRow[], longitudeRows: LogRow[]): Fix[] {
  const instants = [...latitudeRows, ...longitudeRows].map(row => row.ts).sort((left, right) => left - right);
  const fixes: Fix[] = [];
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const at of instants) {
    if (at === previousAt) {
      continue;
    }
    previousAt = at;
    const latitude = carryBack(latitudeRows, at);
    const longitude = carryBack(longitudeRows, at);
    if (latitude !== null && longitude !== null) {
      fixes.push({ latitudeDeg: latitude.value, longitudeDeg: longitude.value, at });
    }
  }
  return fixes;
}

/**
 * The jump gate, and whether it actually judged.
 *
 * ⚠️ It fails OPEN far more often than it looks. MIN_FIX_INTERVAL_MS is 1 s and this hub
 * delivers fixes at ~1.8 Hz, so most consecutive pairs are under the gate's own floor and
 * implausibleJumpKmh() answers null without comparing anything. The bike ran the same gate
 * against the same cadence, so reproducing that is correct — but a report must not print
 * "cleared the jump gate" when the gate declined to look. docs/waypoints.md has the rate.
 */
function judgeJump(fixes: Fix[], fireAt: number): { jump: number | null; judged: boolean } {
  let previous: Fix | null = null;
  let current: Fix | null = null;
  for (const fix of fixes) {
    if (fix.at > fireAt) {
      break;
    }
    previous = current;
    current = fix;
  }
  if (previous === null || current === null) {
    return { jump: null, judged: false };
  }
  const judged = current.at - previous.at >= 1000;
  return { jump: implausibleJumpKmh(previous, current), judged };
}

function nearestRow(rows: LogRow[], at: number): LogRow | null {
  let best: LogRow | null = null;
  for (const row of rows) {
    if (best === null || Math.abs(row.ts - at) < Math.abs(best.ts - at)) {
      best = row;
    }
  }
  return best;
}

function refused(press: RecoveredPress, fireAt: number, refusal: WaypointRefusal): RecoveryVerdict {
  return { press, fireAt, outcome: RECOVERY_OUTCOME.REFUSED, refusal, jumpGateJudged: false };
}

export { FIX_MAX_AGE_MS, WAYPOINT_REFUSAL, distanceKm, implausibleJumpKmh, isPositionOnEarth };
export type { Fix, WaypointRefusal };
