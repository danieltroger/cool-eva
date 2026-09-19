import { ringFor } from "../public/lib/ring.js";
import {
  BOUND_AT_OR_ABOVE,
  MIN_CHARGE_KW,
  MIN_SMOOTH_SAMPLES,
  SMOOTH_MS,
  WH_PER_SOC_POINT,
  chargeEta,
  smoothedChargeKw,
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
  { what: "60 → 80 % at 2 kW", socPct: 60, targetPct: 80, kw: 2, minutes: 119.4 },
  { what: "an 8 kW DC charge, 40 → 80 %", socPct: 40, targetPct: 80, kw: 8, minutes: 59.7 },
  { what: "one point at 1 kW", socPct: 79, targetPct: 80, kw: 1, minutes: 11.9 },
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

// ── §4 the smoothing, through the function that ships ─────────────────────
//
// ⚠️ THIS SECTION USED TO BE UNFALSIFIABLE and it is worth saying how. It built a window of sixty
// identical 2 kW samples and pushed one 40 kW spike — but `Ring.push` DROPS anything arriving
// within MIN_INTERVAL_MS (500 ms) of the newest entry, so the spike never landed, the window was
// sixty identical values, and mean == median. Mutating `median()` to a mean SURVIVED while the
// success line claimed "a median that one spike cannot move". The fixture now spaces its samples,
// and the distribution is SKEWED so the two statistics genuinely differ.
//
// It also never called the shipped `smoothedChargeKw`, so the thin-window fallback — the live path
// for roughly one AC minute in five — was untested. It is exercised here through the store's own
// ring, which is the same instance the browser uses.

const packRing = ringFor("pack_kw");
const now = 10_000_000;
// Nine samples 1 s apart: eight at 2 kW and one at 40. Median 2, mean 6.2 — a mean would be
// unusable as a charging power and this is what separates them.
for (let index = 0; index < 8; index += 1) {
  packRing.push(now - 9000 + index * 1000, 2);
}
packRing.push(now - 500, 40);
const smoothed = smoothedChargeKw(now);
if (smoothed !== 2) {
  failures.push(
    `§4 smoothedChargeKw returned ${smoothed} over eight 2 kW samples and one 40 — a median is 2, a mean 6.2`
  );
}
if (packRing.since(SMOOTH_MS, now).values.length < MIN_SMOOTH_SAMPLES) {
  failures.push("§4 the fixture did not land enough samples to have a median — Ring.push drops bursts under 500 ms");
}

// ⚠️ The thin window is NOT an error case: AC's p10 is 0.5 rows/min, so a 60 s window holding
// nothing is normal, and the newest reading is the right answer because silence on a
// log-on-change signal means unchanged.
const thinRing = ringFor("check-charge-eta-thin");
thinRing.push(now - 5000, 7);
if (thinRing.since(SMOOTH_MS, now).values.length >= MIN_SMOOTH_SAMPLES) {
  failures.push("§4 the thin fixture is not thin");
}
if (thinRing.latest() !== 7) {
  failures.push("§4 a window too thin for a median must fall back to the newest reading");
}
const staleRing = ringFor("check-charge-eta-stale");
staleRing.push(now - SMOOTH_MS * 10, 1.9);
if (staleRing.since(SMOOTH_MS, now).values.length !== 0) {
  failures.push("§4 the stale fixture should have an empty window");
}
if (staleRing.latest() !== 1.9) {
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
