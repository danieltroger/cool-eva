import { Ring } from "../public/lib/ring.js";
import {
  BOUND_AT_OR_ABOVE,
  MIN_CHARGE_KW,
  MIN_SMOOTH_SAMPLES,
  SMOOTH_MS,
  WH_PER_SOC_POINT,
  chargeEta,
} from "../public/lib/charge-eta.js";

// The charge ETA's arithmetic and its refusals, on a laptop, with no bike and no browser.
//
//   node --experimental-strip-types scripts/check-charge-eta.ts
//
// ⚠️ §3 is the one that decides whether the number on the phone is right rather than merely
// present: the boundary between an estimate and a lower bound sits at target 100 and NOWHERE ELSE.
// Measured predicted/actual by target across the archive — 88 → 0.81 DC / 0.95 AC, 90 → 0.82/0.96,
// 99 → 0.68/0.92, 100 → 0.39/0.78 — one discontinuity, between 99 and 100. A boundary at 88 would
// refuse a real time for exactly the range the charge limit sets. docs/charge-eta.md.

const failures: string[] = [];

// ── §1 the arithmetic, against figures worked by hand ─────────────────────

const CASES = [
  { what: "60 → 80 % at 2 kW", socPct: 60, targetPct: 80, kw: 2, minutes: 114 },
  { what: "an 8 kW DC charge, 40 → 80 %", socPct: 40, targetPct: 80, kw: 8, minutes: 57 },
  { what: "one point at 1 kW", socPct: 79, targetPct: 80, kw: 1, minutes: 11.4 },
];
for (const c of CASES) {
  const eta = chargeEta(c);
  const got = eta.kind === "none" ? null : Math.round(eta.minutes * 10) / 10;
  if (got !== c.minutes) {
    failures.push(
      `§1 ${c.what}: got ${got ?? `none (${eta.kind === "none" ? eta.why : ""})`}, expected ${c.minutes} min`
    );
  }
}
// The constant, asserted through the arithmetic rather than by reading it back: one point at
// exactly 190 W must take exactly an hour.
const anHour = chargeEta({ socPct: 50, targetPct: 51, kw: WH_PER_SOC_POINT / 1000 });
if (anHour.kind === "none" || Math.abs(anHour.minutes - 60) > 1e-9) {
  failures.push(`§1 one point at ${WH_PER_SOC_POINT} W should take 60 min, got ${JSON.stringify(anHour)}`);
}

// ── §2 every "—" condition, one at a time ─────────────────────────────────

const REFUSALS = [
  { what: "no SOC", input: { socPct: null, targetPct: 80, kw: 2 } },
  { what: "no target", input: { socPct: 60, targetPct: null, kw: 2 } },
  { what: "already past the target", input: { socPct: 85, targetPct: 80, kw: 2 } },
  { what: "exactly at the target", input: { socPct: 80, targetPct: 80, kw: 2 } },
  { what: "no power reading", input: { socPct: 60, targetPct: 80, kw: null } },
  { what: "a discharging pack", input: { socPct: 60, targetPct: 80, kw: -3 } },
  { what: "a stalled charge below the floor", input: { socPct: 60, targetPct: 80, kw: 0.02 } },
  { what: "NaN power", input: { socPct: 60, targetPct: 80, kw: Number.NaN } },
];
for (const r of REFUSALS) {
  if (chargeEta(r.input).kind !== "none") {
    failures.push(`§2 ${r.what} produced an answer`);
  }
}
// ⚠️ And the floor is a FLOOR, not a zero test: just above it must answer, just below must not.
if (chargeEta({ socPct: 60, targetPct: 80, kw: MIN_CHARGE_KW }).kind === "none") {
  failures.push(`§2 exactly ${MIN_CHARGE_KW} kW is refused; the floor must be inclusive`);
}
if (chargeEta({ socPct: 60, targetPct: 80, kw: MIN_CHARGE_KW - 0.001 }).kind !== "none") {
  failures.push(`§2 just below ${MIN_CHARGE_KW} kW still answers — a 0.02 kW trickle gives a forty-day ETA`);
}

// ── §3 estimate below the boundary, bound at and above it ─────────────────

for (const target of [50, 80, 88, 90, 95, 99]) {
  const eta = chargeEta({ socPct: 40, targetPct: target, kw: 2 });
  if (eta.kind !== "estimate") {
    failures.push(
      `§3 target ${target} % gave "${eta.kind}", expected a point estimate — the archive measures 0.92-0.96 on AC there`
    );
  }
}
for (const target of [100, 101]) {
  const eta = chargeEta({ socPct: 40, targetPct: target, kw: 2 });
  if (eta.kind !== "bound") {
    failures.push(
      `§3 target ${target} % gave "${eta.kind}", expected a lower bound — the last point alone runs 3.4-76.9 min on AC`
    );
  }
}
if (BOUND_AT_OR_ABOVE !== 100) {
  failures.push(
    `§3 the boundary is ${BOUND_AT_OR_ABOVE}, not 100 — it was MEASURED at 100 and is not SOC_RATE_TRUSTED_BELOW's 88 to borrow`
  );
}

// ── §4 the smoothing, including the window that is legitimately empty ─────

const now = 10_000_000;
const full = new Ring();
for (let age = SMOOTH_MS - 1000; age >= 0; age -= 1000) {
  full.push(now - age, 2);
}
full.push(now - 500, 40); // one spike, which a median must ignore and a mean would not
if (medianOf(full) !== 2) {
  failures.push(`§4 a single 40 kW spike moved the median to ${medianOf(full)} — it must not`);
}
const thin = new Ring();
thin.push(now - 5000, 7);
if (thin.length >= MIN_SMOOTH_SAMPLES) {
  failures.push("§4 the thin fixture is not thin — it must have fewer samples than the smoothing needs");
}
if (thin.latest() !== 7) {
  failures.push("§4 a window too thin to have a median must fall back to the newest reading");
}
// ⚠️ The case that is NOT an error: AC's p10 is 0.5 rows/min, so a 60 s window holding NOTHING is
// normal. Silence on a log-on-change signal means unchanged, so the newest reading is the answer.
const stale = new Ring();
stale.push(now - SMOOTH_MS * 10, 1.9);
if (stale.since(SMOOTH_MS, now).values.length !== 0) {
  failures.push("§4 the stale fixture should have an empty window");
}
if (stale.latest() !== 1.9) {
  failures.push("§4 an empty window must still yield the newest reading rather than nothing");
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-eta failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ the ETA prices a point at ${WH_PER_SOC_POINT} Wh and divides by measured power (one point at ` +
    `${WH_PER_SOC_POINT} W takes exactly an hour), refuses all ${REFUSALS.length} no-answer cases including a ` +
    `stalled charge below the ${MIN_CHARGE_KW} kW floor, gives a point estimate for every target up to 99 and a ` +
    `lower bound only at ${BOUND_AT_OR_ABOVE}, and smooths power with a median that one spike cannot move — ` +
    "falling back to the newest reading when the window is thin, which on AC it often legitimately is"
);

/** The median of a ring's whole window, the way smoothedChargeKw computes it. */
function medianOf(ring: Ring): number {
  const sorted = [...ring.since(SMOOTH_MS, now).values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
