import assert from "node:assert/strict";
import {
  chargeAllowance,
  chargeCeiling,
  chargeWindow,
  chargeCurvePoints,
  CHARGE_CAP_INTERSECTIONS,
  CHARGE_CURVE,
} from "../public/lib/charge-curve.js";
import { chargeReply } from "../public/lib/charge-command-display.js";
import { worstStatus, statusWord, type ReadingStatus } from "../public/lib/reading-status.js";
assert.equal(CHARGE_CAP_INTERSECTIONS.length, 2);
assert.ok(Math.abs(CHARGE_CAP_INTERSECTIONS[0] - 9.358974358974359) < 1e-12);
assert.ok(Math.abs(CHARGE_CAP_INTERSECTIONS[1] - 34.642857142857146) < 1e-12);
assert.deepEqual(CHARGE_CURVE, [
  [-30, 0],
  [-10, 2],
  [0, 2],
  [10, 80],
  [25, 120],
  [40, 50],
  [65, 0],
]);
for (const [temperature, amps] of [
  [-30, 0],
  [-20, 1],
  [-10, 2],
  [0, 2],
  [3, 25.4],
  [7, 56.6],
  [10, 75],
  [25, 75],
  [33, 75],
  [35, 73 + 1 / 3],
  [40, 50],
  [43, 44],
  [47, 36],
  [65, 0],
] as const) {
  assert.ok(Math.abs((chargeAllowance(temperature) ?? -1) - amps) < 1e-9);
}
for (const value of [-31, 66, NaN, Infinity, null]) {
  assert.equal(chargeAllowance(value), null, "Off-curve inputs cannot be clamped into a plausible allowance.");
}
assert.equal(chargeCeiling(43, 47), 36, "Both reports must bound the ceiling.");
assert.equal(chargeCeiling(33, 33), 75);
assert.equal(chargeCeiling(-20, 47), 1, "The cold extreme can govern.");
assert.equal(chargeCeiling(65, 33), 0);
assert.equal(chargeCeiling(null, 33), null, "Missing reports cannot infer an allowance.");
for (const [values, expected] of [
  [{ outside: 28, physicalLow: 43, physicalHigh: 47, reportedLow: 43, reportedHigh: 47 }, [15, 65]],
  [{ outside: -5, physicalLow: 3, physicalHigh: 7, reportedLow: 3, reportedHigh: 7 }, [-15, 20]],
  [{ outside: 28, physicalLow: 43, physicalHigh: 47, reportedLow: 33, reportedHigh: 33 }, [15, 60]],
] as const) {
  const window = chargeWindow(values);
  assert.deepEqual([window.low, window.high], expected);
  assert.equal(window.fixed, false);
  const points = chargeCurvePoints(window);
  assert.equal(points[0].temperature, window.low);
  assert.equal(points.at(-1)?.temperature, window.high);
  for (const crossing of CHARGE_CAP_INTERSECTIONS.filter(value => value >= window.low && value <= window.high)) {
    assert.ok(
      points.some(point => point.temperature === crossing && point.amps === 75),
      "Exact cap crossings must survive path construction."
    );
  }
}
for (const temperature of [-30, -29, -20, -10, 0, 3, 10, 25, 33, 40, 60, 65]) {
  const window = chargeWindow({
    outside: temperature,
    physicalLow: temperature,
    physicalHigh: temperature,
    reportedLow: temperature,
    reportedHigh: temperature,
  });
  assert.ok(window.high - window.low >= 30, "The frame retains at least 30 degrees.");
  assert.ok(window.low >= -30 && window.high <= 65);
  assert.ok(temperature >= window.low && temperature <= window.high);
  assert.equal(window.low % 5 === 0, true);
  assert.equal(window.high % 5 === 0, true);
}
for (const key of ["outside", "physicalLow", "physicalHigh", "reportedLow", "reportedHigh"]) {
  const window = chargeWindow({
    ...{ outside: 28, physicalLow: 43, physicalHigh: 47, reportedLow: 43, reportedHigh: 47 },
    [key]: null,
  });
  assert.deepEqual(window, { low: -30, high: 65, fixed: true });
}
assert.deepEqual(chargeWindow({ outside: 28, physicalLow: 43, physicalHigh: 47, reportedLow: 33, reportedHigh: 70 }), {
  low: -30,
  high: 65,
  fixed: true,
});
assert.equal(chargeReply({ kind: "waiting", elapsedMs: 12 }), "Waiting");
assert.equal(chargeReply({ kind: "took", fromAmps: 50, toAmps: 32, latencyMs: 10 }), 32);
assert.equal(chargeReply({ kind: "not-acknowledged", heldAmps: 50 }), 50);
assert.equal(chargeReply({ kind: "station-limited", askedAmps: 60, gotAmps: 40 }), 40);
assert.equal(chargeReply({ kind: "no-evidence" }), "Unknown");
assert.equal(chargeReply(null), "—");
for (const [states, expected] of [
  [["fresh", "fresh"], "fresh"],
  [["stale", "missing"], "missing"],
  [["fault", "missing"], "fault"],
  [["fresh", "stale"], "stale"],
] as const) {
  assert.equal(
    worstStatus(["left", "right"], false, key => states[key === "left" ? 0 : 1] as ReadingStatus),
    expected,
    "Shared fault/missing/stale priority must hold."
  );
}
assert.equal(statusWord("missing"), "—");
assert.equal(statusWord("fault"), "fault");
assert.equal(statusWord("fresh"), "—");
assert.equal(statusWord("missing", "unavailable"), "unavailable");
console.log(
  "✓ Exact observed curve, cap intersections, both extremes, known zero, adaptive/fallback windows, command replies and shared status priority"
);
