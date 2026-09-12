import {
  RECOVERY_OUTCOME,
  WAYPOINT_REFUSAL,
  buildFixTimeline,
  carryBack,
  judgeHolds,
  matchLiveWaypoints,
  pairPresses,
  type LogRow,
} from "../src/gps/recover-holds.ts";

// The waypoint recovery, checked with no bike, no Pi and no ride log.
//
//   node --experimental-strip-types scripts/check-recover-waypoints.ts
//
// ⚠️ SYNTHETIC FIXTURES ON PURPOSE. scripts/run-checks.ts forbids depending on local-only
// files, and the real logs are not in the repo — so every rule below is planted as rows
// rather than replayed from Daniel's data. The calibration against the 28 waypoints the
// bike really saved is the script's own --validate mode, which is evidence in the PR and
// cannot be a CI check. docs/waypoints.md has both halves.
//
// ⚠️ What this is really guarding is that the recovery reproduces what the BIKE would have
// done. Every rule here was a wrong answer first: the pairing was miscounted twice, a
// freshness gate was invented for a failure that cannot happen, and a press whose start
// was never observed was counted as a press.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

const SECOND = 1000;
const BASE = Date.parse("2026-09-07T12:00:00Z");

/** A button edge. `seq` is the write order, which is what pairing must sort on. */
function edge(atMs: number, value: number, sessionId = 1, seq = atMs): LogRow {
  return { ts: BASE + atMs, value, sessionId, seq };
}

/** A fix pair logged at one instant, as gps_lat and gps_lon rows. */
function fixRows(atMs: number, lat: number, lon: number): { lat: LogRow; lon: LogRow } {
  return {
    lat: { ts: BASE + atMs, value: lat, sessionId: 1, seq: atMs },
    lon: { ts: BASE + atMs, value: lon, sessionId: 1, seq: atMs },
  };
}

console.log("\n1. pairing presses out of a log's edges");

const simple = pairPresses([edge(0, 0), edge(1000, 1), edge(1900, 0)]);
check("a watched 0→1→0 is one press of its real length", simple.length === 1 && simple[0].durationMs === 900);

// ⚠️ THE RULE THAT COST A WRONG COUNT. record() always logs the first value of a key in a
// process, so a restart-heavy day writes one baseline row per boot — and a session that
// opens with the button already down never watched the press begin.
const midPress = pairPresses([edge(0, 1), edge(900, 0), edge(1000, 1), edge(1900, 0)]);
check(
  "⚠️  a session whose FIRST row is already 1 contributes no press from it",
  midPress.length === 1 && midPress[0].durationMs === 900
);

const unterminated = pairPresses([edge(0, 0), edge(1000, 1)]);
check("a press still open when the log ends is discarded, not closed", unterminated.length === 0);

// ⚠️ Cross-session pairing would turn two boots into one absurd hold. `ts` is wall clock
// and the Pi steps it, so the ordering is (session, seq) and the pairing is per session.
const twoSessions = pairPresses([edge(0, 0, 1), edge(100, 1, 1), edge(200, 0, 2, 5), edge(300, 1, 2, 6)]);
check("⚠️  a press open at the end of one session is not closed by the next session's row", twoSessions.length === 0);

const outOfOrder = pairPresses([edge(1900, 0, 1, 3), edge(1000, 1, 1, 2), edge(0, 0, 1, 1)]);
check("rows are ordered by seq, not by arrival", outOfOrder.length === 1 && outOfOrder[0].durationMs === 900);

console.log("\n2. which holds already produced a waypoint");

const presses = pairPresses([edge(0, 0), edge(1000, 1), edge(2400, 0), edge(3000, 1), edge(4400, 0)]);
const oneLive = matchLiveWaypoints(presses, [{ ts: BASE + 2050, value: 1, sessionId: 1, seq: 1 }], 200);
check("a waypoint inside a press belongs to that press", oneLive.size === 1 && oneLive.has(presses[0]));

// ⚠️ FORWARD IN TIME, and one waypoint to one press. Matching by nearest instant lets a
// single waypoint vouch for several holds — the error that miscounted the same four holds
// twice, first as three losses and then as the wrong fourth.
const twoLive = matchLiveWaypoints(presses, [{ ts: BASE + 2050, value: 1, sessionId: 1, seq: 1 }], 200);
check("⚠️  …and it vouches for ONE press, not for every press near it", twoLive.size === 1);

const before = matchLiveWaypoints(presses, [{ ts: BASE + 500, value: 1, sessionId: 1, seq: 1 }], 200);
check("a waypoint BEFORE a press cannot have come from it", before.size === 0);

console.log("\n3. carrying the position back");

const rows: LogRow[] = [
  { ts: BASE + 1000, value: 57.7, sessionId: 1, seq: 1 },
  { ts: BASE + 5000, value: 57.8, sessionId: 1, seq: 2 },
];
check("the last value at or before the instant is the one", carryBack(rows, BASE + 4000)?.value === 57.7);
check("…and an instant on a row takes that row", carryBack(rows, BASE + 5000)?.value === 57.8);
check("…and nothing before the first row", carryBack(rows, BASE - 1) === null);

// ⚠️ A pair at EVERY lat OR lon row, carrying the other axis back — the shape
// src/gps/waypoint.ts's onFixChanged() produces. Pairing consecutive gps_lat rows instead
// feeds the jump gate pairs the bike never held, because the two axes are deadbanded apart.
const timeline = buildFixTimeline(
  [
    { ts: BASE + 1000, value: 57.7, sessionId: 1, seq: 1 },
    { ts: BASE + 3000, value: 57.71, sessionId: 1, seq: 3 },
  ],
  [{ ts: BASE + 2000, value: 11.97, sessionId: 1, seq: 2 }]
);
check(
  "⚠️  a fix pair is formed at every lat OR lon row, with the other axis carried back",
  timeline.length === 2 && timeline[0].at === BASE + 2000 && timeline[1].latitudeDeg === 57.71
);

console.log("\n4. the gates, as the bike would have run them");

function judge(overrides: Partial<Parameters<typeof judgeHolds>[0]> = {}) {
  const hold = [edge(0, 0), edge(1000, 1), edge(2400, 0)];
  const here = fixRows(900, 57.7, 11.97);
  return judgeHolds({
    cancelRows: hold,
    latitudeRows: [here.lat],
    longitudeRows: [here.lon],
    epochRows: [{ ts: BASE + 900, value: 1_788_000_000, sessionId: 1, seq: 1 }],
    waypointRows: [],
    holdMs: 500,
    liveToleranceMs: 200,
    ...overrides,
  });
}

check("a clean hold with a fresh fix is recovered", judge()[0].outcome === RECOVERY_OUTCOME.RECOVERED);
check(
  "a hold with no position at all is refused as NO_FIX",
  judge({ latitudeRows: [], longitudeRows: [] })[0].refusal === WAYPOINT_REFUSAL.NO_FIX
);

// ⚠️ THE ONE GATE THAT SURVIVED. gps_epoch_s is the liveness witness because gps_lat and
// gps_lon are deadbanded: src/can/signals.ts compares against the LAST LOGGED value, so a
// carried-back position is within one deadband of the live fix at ANY row age. What that
// bound cannot see is a receiver that went silent while the bike kept moving, and this is it.
check(
  "⚠️  a receiver silent for longer than FIX_MAX_AGE_MS is refused as FIX_STALE",
  judge({ epochRows: [{ ts: BASE - 60_000, value: 1, sessionId: 1, seq: 1 }] })[0].refusal ===
    WAYPOINT_REFUSAL.FIX_STALE
);
check(
  "a coordinate off the planet is refused by the range gate",
  judge({ longitudeRows: [{ ts: BASE + 900, value: 999, sessionId: 1, seq: 1 }] })[0].refusal ===
    WAYPOINT_REFUSAL.FIX_NOT_ON_EARTH
);

// ⚠️ The jump gate FAILS OPEN below MIN_FIX_INTERVAL_MS, and this hub's fixes are mostly
// closer together than that, so it usually declines to judge. The bike ran the same gate in
// the same regime — reproducing that is correct — but the verdict records whether it looked,
// because a report saying "cleared the jump gate" about a gate that never ran is a lie.
const tooClose = judge({
  latitudeRows: [
    { ts: BASE + 400, value: 57.7, sessionId: 1, seq: 1 },
    { ts: BASE + 900, value: 57.7, sessionId: 1, seq: 2 },
  ],
  longitudeRows: [
    { ts: BASE + 400, value: 11.97, sessionId: 1, seq: 1 },
    { ts: BASE + 900, value: 130.3, sessionId: 1, seq: 2 },
  ],
});
check(
  "⚠️  fixes closer than the gate's floor are NOT judged, and the verdict says so",
  tooClose[0].outcome === RECOVERY_OUTCOME.RECOVERED && !tooClose[0].jumpGateJudged
);

const jumped = judge({
  latitudeRows: [
    { ts: BASE - 2000, value: 57.7, sessionId: 1, seq: 1 },
    { ts: BASE + 900, value: 57.7, sessionId: 1, seq: 2 },
  ],
  longitudeRows: [
    { ts: BASE - 2000, value: 11.97, sessionId: 1, seq: 1 },
    { ts: BASE + 900, value: 130.3, sessionId: 1, seq: 2 },
  ],
});
check(
  "…and a real 8 000 km jump across a judgeable gap IS refused",
  jumped[0].refusal === WAYPOINT_REFUSAL.FIX_IMPLAUSIBLE && jumped[0].jumpGateJudged
);

const live = judge({ waypointRows: [{ ts: BASE + 1600, value: 1, sessionId: 1, seq: 1 }] });
check("a hold that already saved a waypoint is not recovered again", live[0].outcome === RECOVERY_OUTCOME.ALREADY_LIVE);

const shortPress = judgeHolds({
  cancelRows: [edge(0, 0), edge(1000, 1), edge(1300, 0)],
  latitudeRows: [fixRows(900, 57.7, 11.97).lat],
  longitudeRows: [fixRows(900, 57.7, 11.97).lon],
  epochRows: [{ ts: BASE + 900, value: 1, sessionId: 1, seq: 1 }],
  waypointRows: [],
  holdMs: 500,
  liveToleranceMs: 200,
});
check("a 300 ms tap is below the threshold and is not a hold at all", shortPress.length === 0);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ presses pair per session on a watched 0→1 and are discarded when a session ends mid-press; a live");
  console.log("  waypoint vouches for one press and only forward in time; the position is carried back from the last");
  console.log("  row at or before the fire; and every gate the bike would have run is reproduced, including the jump");
  console.log("  gate declining to judge fixes closer together than its own floor");
}
