import { decodeBmsFrame } from "../src/can/decode-bms.ts";
import type { LiveValue } from "../src/can/signals.ts";
import van from "../public/vendor/van-1.6.1.js";
import { isPlausible } from "../public/lib/bounds.js";
import { observeAndPublish, packResistance } from "../public/lib/pack-resistance-live.js";
import { monotonicNow } from "../public/lib/clock.js";
import { apply } from "../public/lib/store.js";
import { observeFrame, packResistanceWith, resetPackResistance } from "../public/lib/pack-resistance.js";
import { LOAD_WINDOW, LOAD_WINDOW_MOHM, REST_WINDOW, type CapturedFrame } from "./captured-pack-frames.ts";

// The pack-resistance estimator, against frames the bike actually sent.
//
//   node --experimental-strip-types scripts/check-pack-resistance.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// Why it exists: `pack_resistance_mohm` was driving five derived quantities and is
// unusable (docs/pack-resistance.md). What replaced it is a regression, which has two
// ways to be silently wrong that a screenshot cannot catch — the wrong SIGN, which
// yields ~1 mΩ and looks like a plausible small number, and pairing values from
// DIFFERENT frames, which biases the slope toward zero by a few mΩ. §1 and §4 are
// aimed at exactly those.
//
//   §1 a real load window fits the resistance it was measured to have
//   §2 a real at-rest window falls back, and does not report a stale measurement
//   §3 a measurement goes stale on the stated interval
//   §4 only same-frame pairs enter the buffer
//   §5 the modelled curve is monotone, interpolates, and holds its endpoints
//   §8 the gates a fit has to clear, each shown to be load-bearing
//   §9 a VanJS binding on the published estimate actually re-runs when it changes
//   §6 with no pack temperature at all the answer is `assumed`, never null
//   §7 store.js hands the buffer only readings that passed the plausibility gate

const failures: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    console.log(`✓ ${description}`);
    return;
  }
  failures.push(description);
  console.log(`✗ ${description}`);
}

/** The server's wall stamp for a frame; only differences and equality matter. */
const BASE_TS = 1_788_768_000_000;

function liveValuesFor(frame: CapturedFrame): Record<string, LiveValue> {
  const decoded = decodeBmsFrame(0x200, Buffer.from(frame.data));
  const ts = BASE_TS + frame.afterMs;
  const values: Record<string, LiveValue> = {};
  for (const { key, value } of decoded) {
    values[key] = { value, unit: "", group: "battery", ts };
  }
  return values;
}

/** Replays a window and returns what the estimator says at the end of it. */
function replay(window: CapturedFrame[], readTemperature: (key: string) => number | null) {
  resetPackResistance();
  for (const frame of window) {
    observeFrame(liveValuesFor(frame), frame.afterMs);
  }
  const last = window[window.length - 1].afterMs;
  return packResistanceWith(readTemperature, last);
}

const noTemperature = () => null;
const at47C = (key: string) => (key === "batt_temp_hi" ? 47 : null);

// §1 — a real load window fits what it was measured to fit
console.log("\n──── §1 real load window ────");
const load = replay(LOAD_WINDOW, noTemperature);
check(load.provenance === "measured", `a ${LOAD_WINDOW.length}-frame load window yields a MEASURED resistance`);
check(
  Math.abs(load.milliohms - LOAD_WINDOW_MOHM) < 1.0,
  `it fits ${load.milliohms.toFixed(1)} mΩ against the ${LOAD_WINDOW_MOHM} mΩ measured off the same frames`
);
// The sign trap: negating the slope gives a small positive number that reads as plausible.
check(load.milliohms > 20, `the fit is not the sign-flipped ~1 mΩ (got ${load.milliohms.toFixed(1)})`);

// §2 — a real at-rest window has nothing to fit
console.log("\n──── §2 real at-rest window ────");
const rest = replay(REST_WINDOW, at47C);
check(rest.provenance === "modelled", "an at-rest window falls back to the modelled curve");
check(
  Math.abs(rest.milliohms - 64.5) < 1.0,
  `the modelled value at 47 °C is ${rest.milliohms.toFixed(1)} mΩ, off the measured curve`
);
// A stale `measured` here would be the failure that matters: the number would be real
// and the label would be a lie.
resetPackResistance();
for (const frame of LOAD_WINDOW) {
  observeFrame(liveValuesFor(frame), frame.afterMs);
}
for (const frame of REST_WINDOW) {
  observeFrame(liveValuesFor(frame), 100_000 + frame.afterMs);
}
const afterRest = packResistanceWith(at47C, 100_000 + REST_WINDOW[REST_WINDOW.length - 1].afterMs);
check(afterRest.provenance === "modelled", "a load window followed by rest does NOT keep reporting `measured`");

// §3 — staleness
console.log("\n──── §3 staleness ────");
resetPackResistance();
for (const frame of LOAD_WINDOW) {
  observeFrame(liveValuesFor(frame), frame.afterMs);
}
const lastLoadMs = LOAD_WINDOW[LOAD_WINDOW.length - 1].afterMs;
check(packResistanceWith(at47C, lastLoadMs + 19_000).provenance === "measured", "still measured at 19 s");
check(packResistanceWith(at47C, lastLoadMs + 21_000).provenance === "modelled", "modelled again at 21 s");

// §4 — only same-frame pairs
console.log("\n──── §4 same-frame pairing ────");
const sample = liveValuesFor(LOAD_WINDOW[0]);
resetPackResistance();
for (const frame of LOAD_WINDOW) {
  const values = liveValuesFor(frame);
  delete values["pack_v"];
  observeFrame(values, frame.afterMs);
}
check(
  packResistanceWith(noTemperature, lastLoadMs).provenance !== "measured",
  "a message carrying pack_a but not pack_v contributes no sample"
);
resetPackResistance();
for (const frame of LOAD_WINDOW) {
  const values = liveValuesFor(frame);
  values["pack_v"] = { ...values["pack_v"], ts: values["pack_v"].ts + 5 };
  observeFrame(values, frame.afterMs);
}
check(
  packResistanceWith(noTemperature, lastLoadMs).provenance !== "measured",
  "a pair whose two stamps differ by more than 1 ms is refused"
);
resetPackResistance();
for (let repeat = 0; repeat < 40; repeat += 1) {
  observeFrame(sample, repeat * 1000);
}
check(
  packResistanceWith(noTemperature, 40_000).provenance !== "measured",
  "the same frame re-sent 40 times (the 5 s heartbeat) is one sample, not forty"
);

// §5 — the modelled curve
console.log("\n──── §5 modelled curve ────");
const atTemperature = (celsius: number) =>
  packResistanceWith(key => (key === "batt_temp_hi" ? celsius : null), 0).milliohms;
resetPackResistance();
const curve = [20, 27.5, 32.5, 37.5, 42.5, 47.5, 52.5, 60].map(atTemperature);
check(
  curve.every((value, index) => index === 0 || value <= curve[index - 1] + 1e-9),
  `the curve never rises with temperature: ${curve.map(value => value.toFixed(1)).join(" → ")}`
);
check(Math.abs(atTemperature(20) - atTemperature(27.5)) < 1e-9, "below the table the cold endpoint is held flat");
check(Math.abs(atTemperature(60) - atTemperature(52.5)) < 1e-9, "above the table the hot endpoint is held flat");
const midpoint = atTemperature(30);
check(
  midpoint < atTemperature(27.5) && midpoint > atTemperature(32.5),
  `30 °C interpolates to ${midpoint.toFixed(1)} mΩ, between its neighbours`
);

// §6 — no temperature at all
console.log("\n──── §6 no pack temperature ────");
resetPackResistance();
const blind = packResistanceWith(noTemperature, 30_000);
check(blind.provenance === "assumed", "with no measurement and no batt_temp_hi the answer is `assumed`");
check(blind.milliohms > 0, `it is still a number (${blind.milliohms} mΩ), so no consumer needs a null branch`);

// §7 — the store.js seam
console.log("\n──── §7 store.js hands over only accepted readings ────");
resetPackResistance();
const good = liveValuesFor(LOAD_WINDOW[0]);
check(
  isPlausible("pack_v", good["pack_v"].value, "V", "battery"),
  "the fixture's pack_v passes the same plausibility gate apply() uses"
);
for (const frame of LOAD_WINDOW) {
  apply({ type: "patch", ts: BASE_TS + frame.afterMs, signals: liveValuesFor(frame) });
}
// apply() takes no clock, so these samples carry the real monotonic one — query on the
// same clock rather than on the fixture's offsets, or the answer is stale by construction.
check(
  packResistanceWith(noTemperature, monotonicNow()).provenance === "measured",
  "driving apply() with real messages reaches the buffer"
);
resetPackResistance();
const OUT_OF_BOUNDS_V = 4000;
check(!isPlausible("pack_v", OUT_OF_BOUNDS_V, "V", "battery"), "a 4000 V pack_v is rejected by bounds.js");
for (const frame of LOAD_WINDOW) {
  const signals = liveValuesFor(frame);
  signals["pack_v"] = { ...signals["pack_v"], value: OUT_OF_BOUNDS_V };
  apply({ type: "patch", ts: BASE_TS + frame.afterMs, signals });
}
check(
  packResistanceWith(noTemperature, monotonicNow()).provenance !== "measured",
  "readings apply() rejects as implausible never reach the buffer"
);

// §8 — the gates, each with a window that ONLY that gate rejects
console.log("\n──── §8 every gate is load-bearing ────");

/** A synthetic 0x200 payload. Real bytes, so it goes through the real decoder. */
function frameFor(volts: number, amps: number, afterMs: number): CapturedFrame {
  const tenthVolts = Math.round(volts * 10);
  const tenthAmps = Math.round(amps * 10) & 0xffff;
  return {
    afterMs,
    data: [25, 50, 100, 35, tenthVolts >> 8, tenthVolts & 0xff, tenthAmps >> 8, tenthAmps & 0xff],
  };
}

/** V = OCV + I·R with an optional deterministic wobble on the voltage. */
function ohmicWindow(count: number, spreadAmps: number, milliohms: number, wobbleVolts: number) {
  const frames: CapturedFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    const amps = -spreadAmps / 2 + (spreadAmps * i) / (count - 1);
    const wobble = wobbleVolts * (i % 2 === 0 ? 1 : -1);
    frames.push(frameFor(300 + (amps * milliohms) / 1000 + wobble, amps, i * 200));
  }
  return frames;
}

// Enough samples, a clean fit, a plausible answer — and 10 A of spread. Only
// LEAST_SPREAD_A can reject it.
const tooFlat = replay(ohmicWindow(40, 10, 65, 0), noTemperature);
check(tooFlat.provenance !== "measured", "40 clean samples across only 10 A are refused (LEAST_SPREAD_A)");

// 200 A of spread and a plausible slope, but the voltage is noisy enough that the slope
// is not resolved. Only MOST_RELATIVE_ERROR can reject it.
const tooNoisy = replay(ohmicWindow(40, 200, 65, 4), noTemperature);
check(tooNoisy.provenance !== "measured", "40 samples over 200 A with a badly-resolved slope are refused (SE gate)");
// ...and the same window without the noise IS accepted, so the gate is not just refusing
// everything synthetic.
const clean = replay(ohmicWindow(40, 200, 65, 0), noTemperature);
check(
  clean.provenance === "measured" && Math.abs(clean.milliohms - 65) < 1,
  `the same window without the wobble fits ${clean.milliohms.toFixed(1)} mΩ against the 65 built into it`
);

// 19 distinct frames — one short of LEAST_SAMPLES — each re-sent five times as the 5 s
// heartbeat does. Deduped that is 19 samples and no fit; not deduped it is 95 and one.
resetPackResistance();
const nineteen = ohmicWindow(19, 200, 65, 0);
for (const frame of nineteen) {
  for (let repeat = 0; repeat < 5; repeat += 1) {
    observeFrame(liveValuesFor(frame), frame.afterMs + repeat);
  }
}
check(
  packResistanceWith(noTemperature, 19 * 200).provenance !== "measured",
  "19 frames re-sent five times each stay 19 samples, not 95 (heartbeat dedupe)"
);

// A clean, well-spread, well-resolved fit at a resistance no pack has. Only the
// sanity band can reject it — the SE gate cannot, because the fit is perfect.
const impossible = replay(ohmicWindow(40, 200, 500, 0), noTemperature);
check(impossible.provenance !== "measured", "a perfectly-fitted 500 mΩ is refused as impossible (sanity band)");

// §9 — the published estimate drives VanJS
console.log("\n──── §9 a binding on the estimate re-runs ────");
// This is the regression guard for a shipped bug: the estimate used to be a function,
// packResistanceWith() returns before reading any signal while a measurement is fresh,
// and a VanJS binding whose run reads nothing is registered to nothing and never runs
// again. The Hypermile sub-line froze on its first measured value for the rest of the
// ride. A van state cannot fail that way — but only if consumers read the STATE.
resetPackResistance();
packResistance.val = { milliohms: 999, provenance: "assumed" };
let bindingRuns = 0;
const rendered = van.derive(() => {
  bindingRuns += 1;
  return `${packResistance.val.milliohms.toFixed(0)} ${packResistance.val.provenance}`;
});
const runsBefore = bindingRuns;
for (const frame of LOAD_WINDOW) {
  observeAndPublish(liveValuesFor(frame), noTemperature);
}
await new Promise(resolve => setTimeout(resolve, 20));
check(bindingRuns > runsBefore, `the binding re-ran when the estimate changed (${runsBefore} → ${bindingRuns})`);
check(
  packResistance.rawVal.provenance === "measured",
  `the published state is now measured, not the seeded placeholder (${rendered.rawVal})`
);
check(
  Math.abs(packResistance.rawVal.milliohms - LOAD_WINDOW_MOHM) < 1.0,
  `and carries the fitted value, ${packResistance.rawVal.milliohms.toFixed(1)} mΩ`
);

console.log("");
if (failures.length > 0) {
  console.error(`✗ ${failures.length} failed:`);
  for (const description of failures) {
    console.error(`   ${description}`);
  }
  process.exit(1);
}
console.log("✓ pack resistance: real frames fit, rest falls back, only same-frame pairs count");
