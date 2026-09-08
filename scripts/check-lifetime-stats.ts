import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURED_FREEZE_FRAMES, capturedFreezeFramePayload } from "./captured-freeze-frames.ts";
import {
  CAPTURED_EXCHANGE_53,
  CAPTURED_EXCHANGE_54,
  CAPTURED_EXCHANGE_60,
  LIFETIME_READ_PAYLOADS,
  capturedExchangePayload,
  frameIntervalMs,
  lifetimeReadPayload,
} from "./captured-lifetime-reads.ts";
import { infokeysFor } from "../src/diagnostics/fault-infokeys.ts";
import {
  decodeFreezeFrameResponse,
  expectedFreezeFramePayloadBytes,
  type FreezeFrameResponse,
} from "../src/diagnostics/freeze-frame.ts";
import { lookupInfokey, scaleInfokeyValue } from "../src/diagnostics/infokey-table.ts";
import { summariseLifetimeStatistics, type LifetimeRow } from "../src/diagnostics/lifetime-stats.ts";
import { loadLifetimeStatistics, writeLifetimeRead } from "../src/vcu/lifetime-store.ts";

// Checks the lifetime battery statistics against the only two readings that exist —
// 2026-08-08 (scripts/captured-freeze-frames.ts, before the clear) and 2026-09-08
// (scripts/captured-lifetime-reads.ts, after it), 967.6 km apart. Run by `npm test`.
//
//   node --experimental-strip-types scripts/check-lifetime-stats.ts
//
// ⚠️ §2 IS THE ONE THAT MATTERS. It is a regression guard against anything silently
// putting a scale on `TotalExchangedAh` — not a verification of any particular scale,
// because there isn't one. Restore origin/main's infokey table, which APPLIES
// Energica's ×0.1, and §2 goes red.
//
// ⚠️ The measurement §2 tests against comes from rides.db, which is NOT in this repo
// and never will be. The number is a constant here with its derivation in
// docs/lifetime-battery-statistics.md; that doc is the primary evidence, not this file.

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

/**
 * Gross pack throughput measured from this bike's own log over the same 967.6 km:
 * 0.472 Ah/km, stable across reversal filters from 0.2 to 5 Ah, and the same in both
 * directions. docs/lifetime-battery-statistics.md has the query and the caveats.
 */
const MEASURED_AH_PER_KM = 0.472;

/** The two reads, decoded. Everything below is derived from these. */
const BEFORE = { odometerKm: 17472.9, at: "2026-08-08" };
const AFTER = { odometerKm: 18440.5, at: "2026-09-08" };

const before51 = decodeCaptured(51);
const before52 = decodeCaptured(52);
const after51 = decodeFreezeFrameResponse(lifetimeReadPayload(51), 51);
const after52 = decodeFreezeFrameResponse(lifetimeReadPayload(52), 52);

// ── §1 Both reads decode, field for field ───────────────────────────────────
console.log("── §1 the two readings ────────────────────────────────────────────");

for (const [label, response] of [
  ["2026-08-08 component 51", before51],
  ["2026-08-08 component 52", before52],
  ["2026-09-08 component 51", after51],
  ["2026-09-08 component 52", after52],
] as const) {
  check(response.kind === "frame", `${label} should decode to a frame, got ${response.kind}`);
}

check(
  rawOf(before51, "V_ODOMETER") === 174729,
  `2026-08-08 odometer raw should be 174729, got ${rawOf(before51, "V_ODOMETER")}`
);
check(
  rawOf(after51, "V_ODOMETER") === 184405,
  `2026-09-08 odometer raw should be 184405, got ${rawOf(after51, "V_ODOMETER")}`
);
check(
  valueOf(before51, "V_ODOMETER") === BEFORE.odometerKm,
  `2026-08-08 odometer should scale to ${BEFORE.odometerKm} km`
);
check(
  valueOf(after51, "V_ODOMETER") === AFTER.odometerKm,
  `2026-09-08 odometer should scale to ${AFTER.odometerKm} km`
);
check(
  rawOf(before51, "B_SOH") === 100 && rawOf(after51, "B_SOH") === 100,
  "state of health should read 100 % on both reads"
);

for (const [label, response, expected] of [
  [
    "2026-08-08",
    before52,
    {
      TotalExchangedAh: 624512,
      CompletedCharges: 946,
      CompletedACCharges: 901,
      CompletedDCCharges: 14,
      AvgBattTemp: 330,
      AvgDOD: 2875,
    },
  ],
  [
    "2026-09-08",
    after52,
    {
      TotalExchangedAh: 658112,
      CompletedCharges: 1018,
      CompletedACCharges: 969,
      CompletedDCCharges: 17,
      AvgBattTemp: 294,
      AvgDOD: 25658,
    },
  ],
] as const) {
  for (const [name, raw] of Object.entries(expected)) {
    check(rawOf(response, name) === raw, `${label} ${name} raw should be ${raw}, got ${rawOf(response, name)}`);
  }
}
console.log(
  `  odometer ${BEFORE.odometerKm} → ${AFTER.odometerKm} km, ${(AFTER.odometerKm - BEFORE.odometerKm).toFixed(1)} km apart`
);

// ── §2 The scale is refused, and Energica's is impossible ───────────────────
console.log("\n── §2 TotalExchangedAh: refused, not scaled ───────────────────────");

const exchanged = lookupInfokey(80);
check(exchanged !== null && exchanged.name === "TotalExchangedAh", "infokey 80 should be TotalExchangedAh");
if (exchanged) {
  check(exchanged.equation === "f(x)=x*0.1", "Energica's equation must stay in the table verbatim, refused or not");
  // A non-empty STRING, not merely "not null": the reason is shown on screen, and a
  // table that had dropped the property entirely would still satisfy `!== null`.
  check(
    typeof exchanged.refusedScaling === "string" && exchanged.refusedScaling.length > 0,
    "infokey 80's scaling must be refused, with a reason — see docs/lifetime-battery-statistics.md"
  );
  check(!scaleInfokeyValue(exchanged, 1).applied, "scaleInfokeyValue must not put a unit on TotalExchangedAh");
}
check(valueOf(after52, "TotalExchangedAh") === null, "a decoded TotalExchangedAh must carry no scaled value");

// The physics, from the two reads and nothing else: what Energica's own scale claims
// this pack moved per kilometre, against what the pack actually moved.
const rawAdvance = (rawOf(after52, "TotalExchangedAh") ?? 0) - (rawOf(before52, "TotalExchangedAh") ?? 0);
const kilometres = AFTER.odometerKm - BEFORE.odometerKm;
const energicaAhPerKm = (rawAdvance * 0.1) / kilometres;
check(
  energicaAhPerKm / MEASURED_AH_PER_KM > 5,
  `Energica's ×0.1 should be refuted by a wide margin; it claims ${energicaAhPerKm.toFixed(3)} Ah/km against ${MEASURED_AH_PER_KM} measured`
);
console.log(
  `  raw +${rawAdvance} over ${kilometres.toFixed(1)} km → ×0.1 claims ${energicaAhPerKm.toFixed(3)} Ah/km,` +
    ` ${(energicaAhPerKm / MEASURED_AH_PER_KM).toFixed(1)}× the ${MEASURED_AH_PER_KM} Ah/km this pack measured`
);

// ⚠️ n = 2, and the delta is IMPLIED by the two values rather than independent of
// them. Asserted because a third read is what would break it — cheaply, and for free.
for (const [label, value] of [
  ["2026-08-08", rawOf(before52, "TotalExchangedAh") ?? 0],
  ["2026-09-08", rawOf(after52, "TotalExchangedAh") ?? 0],
  ["the advance", rawAdvance],
] as const) {
  check(
    value % 64 === 0,
    `${label} raw ${value} is no longer a multiple of 64 — the ÷64 reading is dead, update the doc`
  );
}
console.log(
  `  both raws and the advance are multiples of 64 (${(rawOf(before52, "TotalExchangedAh") ?? 0) / 64},` +
    ` ${(rawOf(after52, "TotalExchangedAh") ?? 0) / 64}, ${rawAdvance / 64})`
);

// ── §3 The counters, and the residue that does not classify ─────────────────
console.log("\n── §3 charge counters ─────────────────────────────────────────────");

// ⚠️ Derived from the DECODED frames, not from literals. Arithmetic on constants
// would still pass with the counters decoded out of the wrong bytes, which is the
// only thing this section could plausibly catch.
const residueBefore = residueOf(before52);
const residueAfter = residueOf(after52);
const totalAdvance = counterOf(after52, "CompletedCharges") - counterOf(before52, "CompletedCharges");
const alternatingAdvance = counterOf(after52, "CompletedACCharges") - counterOf(before52, "CompletedACCharges");
const directAdvance = counterOf(after52, "CompletedDCCharges") - counterOf(before52, "CompletedDCCharges");
check(residueBefore === 31, `2026-08-08 residue should be 31, got ${residueBefore}`);
check(residueAfter === 32, `2026-09-08 residue should be 32, got ${residueAfter}`);
check(
  totalAdvance === 72 && alternatingAdvance === 68 && directAdvance === 3,
  `the counter advances should be +72 total, +68 AC, +3 DC; got +${totalAdvance}, +${alternatingAdvance}, +${directAdvance}`
);
check(residueAfter - residueBefore === 1, "the residue should have grown by exactly one while 71 charges classified");
console.log(
  `  residue ${residueBefore} → ${residueAfter} while ${alternatingAdvance + directAdvance} of ${totalAdvance} new charges classified`
);

const charges = rowOf(after52, 52, "charges");
check(charges.status === "ok" && charges.value === 1018, `the charges row should show 1018, got ${charges.value}`);
check(
  charges.detail.join(" · ") === "969 AC · 17 DC · 32 neither",
  `the split must be shown as numbers rather than buried in prose, got ${charges.detail.join(" · ")}`
);

// ── §4 AvgDOD: the two candidate readings, discriminated ────────────────────
console.log("\n── §4 AvgDOD ──────────────────────────────────────────────────────");

const depth = lookupInfokey(86);
check(depth !== null && !scaleInfokeyValue(depth, 1).applied, "AvgDOD's malformed equation must stay unapplied");
const depthBefore = rawOf(before52, "AvgDOD") ?? 0;
const depthAfter = rawOf(after52, "AvgDOD") ?? 0;
check((depthBefore & 0xff) === 59 && (depthAfter & 0xff) === 58, "x & 255 should read 59 then 58");
check(((depthBefore >> 8) & 0xff) === 11 && ((depthAfter >> 8) & 0xff) === 100, "x >> 8 & 255 should read 11 then 100");
console.log("  x & 255 → 59 then 58 (an average moving by one); x >> 8 & 255 → 11 then 100 (not an average)");

// ── §5 The trailing key-cycle counter, and that it stays outside the fields ─
console.log("\n── §5 the trailing byte ───────────────────────────────────────────");

for (const [label, response, expected] of [
  ["2026-08-08 c51", before51, "FF"],
  ["2026-08-08 c52", before52, "FF"],
  ["2026-09-08 c51", after51, "05"],
  ["2026-09-08 c52", after52, "05"],
] as const) {
  check(trailingOf(response) === expected, `${label} trailing byte should be ${expected}, got ${trailingOf(response)}`);
}
check(
  trailingOf(decodeFreezeFrameResponse(capturedExchangePayload(CAPTURED_EXCHANGE_53), 53)) === "01",
  "2026-09-08 c53 trailing byte should be 01"
);
check(
  trailingOf(decodeFreezeFrameResponse(capturedExchangePayload(CAPTURED_EXCHANGE_60), 60)) === "05",
  "2026-09-08 c60 trailing byte should be 05"
);

// ⚠️ NOT proof of the layout — docs §11.3.1's bounds analysis is that. What this
// pins is that the trailing byte is accounted for OUTSIDE the fields: the payload is
// header + shortlist + exactly one byte, on both components and both dates. Drop that
// byte from the arithmetic and all four go wrong by one.
for (const [label, response, component] of [
  ["2026-08-08 c51", before51, 51],
  ["2026-08-08 c52", before52, 52],
  ["2026-09-08 c51", after51, 51],
  ["2026-09-08 c52", after52, 52],
] as const) {
  const shortlist = infokeysFor(component, 0);
  const expected = shortlist === null ? null : expectedFreezeFramePayloadBytes(shortlist);
  const actual = response.kind === "frame" ? response.frame.rawHex.split(" ").length : null;
  check(expected !== null && actual === expected, `${label} payload should be ${expected} bytes, got ${actual}`);
}
check(depthAfter === 0x643a, "AvgDOD should read the two bytes before the trailing one, not through it");

// ── §6 The rows the dashboard shows ────────────────────────────────────────
console.log("\n── §6 presentation ────────────────────────────────────────────────");

const reading = summariseLifetimeStatistics(Date.UTC(2026, 8, 8, 13, 18, 0), [
  { component: 51, response: after51 },
  { component: 52, response: after52 },
]);
check(reading.complete, "both components answered, so the reading is complete");
const exchangedRow = reading.rows.find(row => row.key === "exchanged_ah");
check(
  exchangedRow?.status === "unscaled" && exchangedRow.value === null,
  "the charge-moved row must carry no scaled value"
);
check(exchangedRow?.raw === 658112, "the charge-moved row must carry the raw count");
check(
  (exchangedRow?.detail.some(entry => entry.includes("×0.01")) ?? false) &&
    (exchangedRow?.detail.some(entry => entry.includes("÷64")) ?? false),
  `the charge-moved row must name both candidate scales on screen, got ${exchangedRow?.detail.join(" · ")}`
);
// The rider-legible form: a number somebody who rides this bike has an opinion about.
check(
  exchangedRow?.detail.some(entry => entry.includes("km each")) ?? false,
  "each candidate must be shown in kilometres per full pack, not only in amp-hours"
);
check(
  (exchangedRow?.note ?? "").includes("bracketing"),
  "the charge-moved row must say on screen what would settle it — the next person is standing at the bike"
);
check(
  reading.components.every(entry => entry.cyclesSinceStored === 5),
  "both components should report five key cycles since the record was stored"
);

// A sentinel-filled reply is shown as a fault, not clamped into something plausible.
const sentinel = decodeFreezeFrameResponse(
  Uint8Array.from([
    0x57, 0x01, 0x00, 0x33, 0x05, 0x7c, 0x63, 0x63, 0x64, 0xff, 0xff, 0xff, 0xff, 0x0d, 0x1b, 0xff, 0xfe, 0xff, 0xff,
    0xff, 0xff, 0x00, 0x02, 0xd0, 0x55, 0x05,
  ]),
  51
);
const sentinelReading = summariseLifetimeStatistics(0, [{ component: 51, response: sentinel }]);
const spread = sentinelReading.rows.find(candidate => candidate.key === "cell_spread_mv");
check(
  spread?.status === "rejected" && spread.value === null,
  "a spread computed from 0xFFFF must be rejected, not shown"
);
check(
  spread?.detail.some(entry => entry.includes("⚠ 65535")) ?? false,
  `the rejected cell voltages must stay visible as the sentinels they are, got ${spread?.detail.join(" · ")}`
);

// A half reading is kept and labelled, never presented as whole.
const half = summariseLifetimeStatistics(0, [
  { component: 51, response: after51 },
  { component: 52, response: { kind: "unrecognised", reason: "no reply", rawHex: "" } satisfies FreezeFrameResponse },
]);
check(!half.complete, "a reading missing component 52 must not be complete");
check(
  half.rows.some(row => row.key === "charges" && row.status === "missing"),
  "the missing counters must say so"
);
check(
  half.rows.some(row => row.key === "odometer_km" && row.status === "ok"),
  "what did answer must still be shown"
);

// ── §7 The exchanges the frames survive for ────────────────────────────────
console.log("\n── §7 captured exchanges ──────────────────────────────────────────");

const sixty = decodeFreezeFrameResponse(capturedExchangePayload(CAPTURED_EXCHANGE_60), 60);
check(
  sixty.kind === "frame" && sixty.frame.values.length === 0,
  "component 60 (INFO3) should decode to a frame with no fields"
);
// `57 00` means "no stored record for that component". The decoder keeps the bytes but
// does not name that meaning yet — asserted as it behaves, described as what it is.
const fiftyFour = decodeFreezeFrameResponse(capturedExchangePayload(CAPTURED_EXCHANGE_54), 54);
check(
  fiftyFour.kind === "unrecognised",
  `component 54's "no stored record" reply should be kept but not decoded, got ${fiftyFour.kind}`
);

// The flow-control budget, as measured rather than as hoped. These are what a
// dedicated single-tester script achieved; the micro's own tolerance is unknown.
const firstFrameToFlowControl = frameIntervalMs(CAPTURED_EXCHANGE_53, 3, 4);
const flowControlToConsecutive = frameIntervalMs(CAPTURED_EXCHANGE_53, 4, 5);
check(
  closeEnough(firstFrameToFlowControl, 3.153),
  `First Frame → flow control should be 3.153 ms, got ${firstFrameToFlowControl}`
);
check(
  closeEnough(flowControlToConsecutive, 26.868),
  `flow control → Consecutive Frame should be 26.868 ms, got ${flowControlToConsecutive}`
);
check(
  flowControlToConsecutive > firstFrameToFlowControl,
  "the micro waits longer than we do — this channel's timescale is tens of ms, not sub-millisecond"
);
console.log(
  `  First Frame → our flow control ${firstFrameToFlowControl.toFixed(3)} ms · then the micro waited ${flowControlToConsecutive.toFixed(3)} ms`
);

// ── §8 The store, round-tripped ────────────────────────────────────────────
console.log("\n── §8 the store ───────────────────────────────────────────────────");

const storeDirectory = await mkdtemp(join(tmpdir(), "cool-eva-lifetime-"));
check((await loadLifetimeStatistics(storeDirectory)) === null, "an empty directory should read as no reading at all");

await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 8, 13, 18, 0),
  source: "read-freeze-frame.ts",
  replies: LIFETIME_READ_PAYLOADS.map(entry => ({
    component: entry.component,
    payloadHex: entry.payloadHex,
    failure: null,
  })),
});
const restored = await loadLifetimeStatistics(storeDirectory);
check(
  restored !== null && restored.source === "read-freeze-frame.ts",
  "the stored reading should say where it came from"
);
check(restored?.statistics.complete === true, "a stored reading of both components should be complete");
check(
  restored?.statistics.rows.find(row => row.key === "odometer_km")?.value === AFTER.odometerKm,
  "the odometer should survive the round trip"
);
check(
  restored?.statistics.rows.find(row => row.key === "exchanged_ah")?.status === "unscaled",
  "the refusal must survive the round trip — the store keeps BYTES so today's decode is not frozen into the file"
);

// A damaged file reads as no reading rather than as a half one. ⚠️ The warning it
// logs on the way past is the point of the test, not noise in it: CLAUDE.md forbids
// swallowing this, and "no reading" and "the file is damaged" are different problems.
await writeFile(join(storeDirectory, "lifetime.json"), "{ not json", "utf-8");
check((await loadLifetimeStatistics(storeDirectory)) === null, "a damaged store file should read as no reading");
await rm(storeDirectory, { recursive: true, force: true });
console.log("  written, re-decoded from the stored bytes, and a damaged file refused");

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ both dated readings decode field for field; TotalExchangedAh is refused rather than scaled and Energica's" +
    " ×0.1 is refuted by 7.4× against this pack's own logged current; the charge residue grew by one while 71" +
    " classified; AvgDOD's two candidate readings are discriminated; the trailing key-cycle counter stays outside" +
    " the fields; sentinels are shown as faults and a half reading is labelled"
);

/** One captured 2026-08-08 reply, decoded. Throws if the fixture lost it. */
function decodeCaptured(component: number): FreezeFrameResponse {
  const entry = CAPTURED_FREEZE_FRAMES.find(candidate => candidate.component === component);
  if (!entry) {
    throw new Error(`check-lifetime-stats: the 2026-08-08 capture has no component ${component}`);
  }
  return decodeFreezeFrameResponse(capturedFreezeFramePayload(entry), component);
}

function rawOf(response: FreezeFrameResponse, name: string): number | null {
  return response.kind === "frame" ? (response.frame.values.find(value => value.name === name)?.raw ?? null) : null;
}

function valueOf(response: FreezeFrameResponse, name: string): number | null {
  return response.kind === "frame" ? (response.frame.values.find(value => value.name === name)?.value ?? null) : null;
}

/** One counter, or 0 when the frame did not carry it — the caller's assertion then fails loudly. */
function counterOf(response: FreezeFrameResponse, name: string): number {
  return rawOf(response, name) ?? 0;
}

/** Charges counted in the total but in neither subtotal. */
function residueOf(response: FreezeFrameResponse): number {
  return (
    counterOf(response, "CompletedCharges") -
    counterOf(response, "CompletedACCharges") -
    counterOf(response, "CompletedDCCharges")
  );
}

function trailingOf(response: FreezeFrameResponse): string | null {
  return response.kind === "frame" ? response.frame.trailingHex : null;
}

function rowOf(response: FreezeFrameResponse, component: number, key: string): LifetimeRow {
  const rows = summariseLifetimeStatistics(0, [{ component, response }]).rows;
  const row = rows.find(candidate => candidate.key === key);
  if (!row) {
    throw new Error(`check-lifetime-stats: no row ${key}`);
  }
  return row;
}

/** Milliseconds compare to the microsecond the capture recorded, so this is tight on purpose. */
function closeEnough(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 1e-6;
}
