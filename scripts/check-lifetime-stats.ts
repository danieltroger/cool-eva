import { CAPTURED_FREEZE_FRAMES, capturedFreezeFramePayload } from "./captured-freeze-frames.ts";
import {
  CAPTURED_EXCHANGE_53,
  CAPTURED_EXCHANGE_54,
  CAPTURED_EXCHANGE_60,
  capturedExchangePayload,
  frameIntervalMs,
  EXPECTED_20260808_C51,
  EXPECTED_20260808_C52,
  EXPECTED_20260908_C51,
  EXPECTED_20260908_C52,
  lifetimeReadPayload,
} from "./captured-lifetime-reads.ts";
import { readFile, readdir } from "fs/promises";
import { infokeysFor } from "../src/diagnostics/fault-infokeys.ts";
import {
  decodeFreezeFrameResponse,
  expectedFreezeFramePayloadBytes,
  type FreezeFrameResponse,
} from "../src/diagnostics/freeze-frame.ts";
import { lookupInfokey, scaleInfokeyValue } from "../src/diagnostics/infokey-table.ts";
import { summariseLifetimeStatistics, type LifetimeRow } from "../src/diagnostics/lifetime-stats.ts";
import { HOW_TO_READ, HOW_TO_READ_WITH_SERVICE_STOPPED } from "../src/vcu/lifetime-store.ts";
import { parseFreezeFrameArguments } from "./freeze-frame-args.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";
import { bandFor } from "../src/diagnostics/lifetime-bands.ts";
import { boundsFor } from "../public/lib/bounds.js";

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
  ["2026-08-08 c51", before51],
  ["2026-08-08 c52", before52],
  ["2026-09-08 c51", after51],
  ["2026-09-08 c52", after52],
] as const) {
  check(response.kind === "frame", `${label} should decode to a frame, got ${response.kind}`);
}

// ⚠️ EVERY field of both components, not a representative handful. Bit-flipping the
// fixtures showed 16 of component 51's 26 bytes leaving this check green while its
// banner claimed "field for field" — cell voltages, ids, SOC, pack volts and amps all
// sat unasserted. The expected values live beside the bytes they describe, the way
// scripts/freeze-frame-fixtures.ts keeps FREEZE_FRAME_P0514_EXPECTED beside its frames.
for (const [label, response, expected] of [
  ["2026-08-08 c51", before51, EXPECTED_20260808_C51],
  ["2026-09-08 c51", after51, EXPECTED_20260908_C51],
  ["2026-08-08 c52", before52, EXPECTED_20260808_C52],
  ["2026-09-08 c52", after52, EXPECTED_20260908_C52],
] as const) {
  for (const [name, raw] of Object.entries(expected)) {
    check(rawOf(response, name) === raw, `${label} ${name} raw should be ${raw}, got ${rawOf(response, name)}`);
  }
}

check(
  valueOf(before51, "V_ODOMETER") === BEFORE.odometerKm && valueOf(after51, "V_ODOMETER") === AFTER.odometerKm,
  `the odometer should scale to ${BEFORE.odometerKm} and ${AFTER.odometerKm} km`
);

// The header bytes the fields sit behind. A status or a record count decoded out of the
// wrong byte would shift the symptom, and with it the shortlist the fields are read by.
for (const [label, response] of [
  ["2026-08-08 c51", before51],
  ["2026-08-08 c52", before52],
  ["2026-09-08 c51", after51],
  ["2026-09-08 c52", after52],
] as const) {
  const frame = response.kind === "frame" ? response.frame : null;
  check(frame?.status === 0x05, `${label} status should be 0x05, got ${frame?.status}`);
  check(frame?.symptom === 0, `${label} symptom should be 0, got ${frame?.symptom}`);
  check(frame?.recordCount === 1, `${label} recordCount should be 1, got ${frame?.recordCount}`);
  check(frame?.truncated === false, `${label} should not be truncated`);
  // #102: the flag reads false for a reply at activity 3 that plainly has a frame. Both
  // of these are activity 2 so it does not bite here — asserted so a future read that
  // comes back at activity 3 is noticed rather than quietly gated out.
  check(frame?.flags.hasFreezeFrame === true, `${label} should report a freeze frame`);
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

// ── §5 The trailing cycle counter, and that it stays outside the fields ────
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
check(
  depthAfter === EXPECTED_20260908_C52.AvgDOD,
  "AvgDOD should read the two bytes before the trailing one, not through it"
);

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
  "both components should report five cycles since the record was stored"
);

// A sentinel-filled reply is shown as a fault, not clamped into something plausible.
// ⚠️ B_SOC is 0xFF here as well as the cells. It is gated but appears only in the
// detail line, so a fixture with a plausible 99 % leaves its band unexercised.
const sentinel = decodeFreezeFrameResponse(
  parseHexFrame("57 01 00 33 05 7C FF 63 64 FF FF FF FF 0D 1B FF FE FF FF FF FF 00 02 D0 55 05"),
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
// ⚠️ 65535 − 65535 = 0, the most reassuring number this tile can show, made of two dead
// cells. A rejected spread carries no number at all.
check(spread?.raw === null, `a rejected spread must not carry its computed value, got ${spread?.raw}`);
// Each of the three cell bands is consulted in a different place — two in the reject
// decision, the average only in the detail line — so each is asserted where it is used.
check(
  (spread?.detail[0] ?? "").includes("⚠ 65535"),
  `the average cell must be marked as a sentinel too, got ${spread?.detail[0]}`
);
check(
  (spread?.detail[3] ?? "").includes("⚠ 255"),
  `an impossible state of charge must be marked, not printed as a percentage, got ${spread?.detail[3]}`
);

// A replaced pack reads zero, and the odometer divided by no packs at all is Infinity.
// ⚠️ All three candidate scales, because the guard lived in the helper and the third
// sentence had been hand-inlined past it.
// ⚠️ WITH component 51, because the odometer lives there. Without it `odometerKm` is
// null, no kilometres-per-pack is computed at all, and the division never happens — the
// first version of this case passed against an unguarded divide.
const replacedPack = summariseLifetimeStatistics(0, [
  { component: 51, response: after51 },
  {
    component: 52,
    response: decodeFreezeFrameResponse(
      parseHexFrame("57 01 00 34 05 00 00 00 00 03 FA 03 C9 00 11 01 26 64 3A 05"),
      52
    ),
  },
]).rows.find(row => row.key === "exchanged_ah");
check(
  !/Infinity|NaN/.test(JSON.stringify(replacedPack)),
  `a counter reading zero must not put Infinity on the tile: ${JSON.stringify(replacedPack)}`
);

// ⚠️ And ONE dead cell, not three. With every constituent a sentinel, each band masks
// the other two — widening any single one leaves the row rejected by its neighbours, so
// none of the three is actually covered. This is the real 2026-09-08 payload with only
// B_MIN_CELL replaced by 0xFFFF.
const oneDeadCell = decodeFreezeFrameResponse(
  parseHexFrame("57 01 00 33 05 7C 63 63 64 10 82 04 39 0D 1B FF FE 10 8F FF FF 00 02 D0 55 05"),
  51
);
const oneDeadSpread = summariseLifetimeStatistics(0, [{ component: 51, response: oneDeadCell }]).rows.find(
  row => row.key === "cell_spread_mv"
);
check(oneDeadSpread?.status === "rejected", "one cell at 0xFFFF must reject the spread on its own");
check(
  (oneDeadSpread?.detail[1] ?? "").includes("⚠ 65535"),
  `the weakest cell must be the one marked, got ${oneDeadSpread?.detail[1]}`
);
check(
  (oneDeadSpread?.detail[2] ?? "").includes("4239"),
  `the strongest cell is still a real reading and must be shown as one, got ${oneDeadSpread?.detail[2]}`
);

// A half reading is kept and labelled, never presented as whole.
const half = summariseLifetimeStatistics(0, [
  { component: 51, response: after51 },
  { component: 52, response: { kind: "unrecognised", reason: "no reply", rawHex: "" } satisfies FreezeFrameResponse },
]);
check(!half.complete, "a reading missing component 52 must not be complete");
// ⚠️ Every row the missing component owns says so. Dropping them instead would look
// like a bike with fewer statistics rather than a read that half failed.
for (const key of ["charges", "exchanged_ah", "average_battery_temp_c", "average_depth_of_discharge"]) {
  const row = half.rows.find(candidate => candidate.key === key);
  check(row?.status === "missing", `${key} must be present and marked missing when component 52 does not answer`);
  // ⚠️ And say WHAT it answered. A component-mismatch is not hypothetical on this bus,
  // and "did not answer with a frame" alone would hide it.
  check(
    (row?.note ?? "").includes("unrecognised"),
    `${key}'s note must carry what the component actually said, got ${row?.note}`
  );
}

// A component that answers somebody else's question must say so by name.
const mismatched = summariseLifetimeStatistics(0, [
  { component: 51, response: after51 },
  { component: 52, response: decodeFreezeFrameResponse(parseHexFrame("57 01 00 3E 05 52 00 00 06 C4 00 C0 01"), 52) },
]);
check(
  (mismatched.rows.find(row => row.key === "charges")?.note ?? "").includes("component-mismatch"),
  `a reply about another component must be named as one, got ${mismatched.rows.find(row => row.key === "charges")?.note}`
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

// ── §7a The bands this repo keeps in two places must agree ────────────────
console.log("\n── §7a plausibility bands ────────────────────────────────────────");

// ⚠️ ASSERTED, not asserted-in-prose. lifetime-bands.ts's header says the cell band is
// "the band public/lib/bounds.js gates the live cell voltages with, quoted rather than
// re-invented" — and until this ran, widening one left the other silently behind. The
// same pinning scripts/check-fan-fun.ts does for FAN_MODE_CODE.
for (const [key, liveKey, group] of [
  ["cell_avg_mv", "cell_avg_mv", "battery"],
  ["cell_min_mv", "cell_min_mv", "battery"],
  ["cell_max_mv", "cell_max_mv", "battery"],
  ["cell_spread_mv", "cell_spread_mv", "battery"],
] as const) {
  const live = boundsFor(liveKey, "mV", group);
  const ours = bandFor(key);
  check(
    live !== null && ours !== null && live[0] === ours[0] && live[1] === ours[1],
    `${key} is ${JSON.stringify(ours)} here and ${JSON.stringify(live)} in bounds.js — they gate the same quantity`
  );
}
console.log("  the four cell bands match public/lib/bounds.js");

// ── §7b The instruction the dashboard shows must be a command that runs ────
console.log("\n── §7b the on-screen instruction ──────────────────────────────────");

// ⚠️ PARSED, not eyeballed. The first version of this string named `--components 51,52`,
// a flag that has never existed, and it is what a Pi that has never taken a reading
// shows as its only instruction. The guard follows the COMMAND, which since #187 is the
// footnote rather than the headline.
const instruction = HOW_TO_READ_WITH_SERVICE_STOPPED.replace(/,.*$/, "").split(/\s+/);
const scriptIndex = instruction.findIndex(word => word.endsWith("read-freeze-frame.ts"));
check(
  scriptIndex !== -1,
  `the service-stopped instruction should name the script, got ${JSON.stringify(HOW_TO_READ_WITH_SERVICE_STOPPED)}`
);
const parsed = parseFreezeFrameArguments(instruction.slice(scriptIndex + 1));
check(
  parsed !== null && parsed.kind === "lifetime" && parsed.save,
  `it must parse as a saving lifetime read, got ${JSON.stringify(parsed)}`
);
console.log(`  "${HOW_TO_READ_WITH_SERVICE_STOPPED}" parses as ${JSON.stringify(parsed)}`);

// ⚠️ And the headline must NOT be a command. #177 put the read on a button and this
// sentence did not move with it, leaving an instruction unfollowable on the phone that is
// showing it. A revert would be silent otherwise, because a shell command in this slot
// looks exactly like what used to be correct.
check(
  !HOW_TO_READ.includes("node ") && !HOW_TO_READ.includes(".ts"),
  `HOW_TO_READ is what a rider does in the app, not a shell command, got ${JSON.stringify(HOW_TO_READ)}`
);
check(
  HOW_TO_READ.includes("Service mode"),
  `HOW_TO_READ should name the service sheet that carries the button, got ${JSON.stringify(HOW_TO_READ)}`
);

// ⚠️ And no SHELL-facing caller may print it. This is the regression the split actually
// caused: HOW_TO_READ changed meaning from "the command" to "the in-app path", two of its
// three consumers were updated, and read-freeze-frame.ts's own --help went on
// interpolating it — so the tool you reach for BECAUSE the service is stopped, and the app
// therefore is not running, answered a question about --save by saying "open the app".
// The assertions above cannot see that: the string is fine, its caller was not.
//
// Swept over the whole directory rather than that one file: every script here runs from a
// shell by definition, so any of them printing the in-app path is the same bug.
//
// ⚠️ Named exceptions rather than a cleverer pattern. The two below reference the constant
// for reasons that are not printing it, and a regex that tried to tell "interpolated into
// a usage string" from "assigned to a payload field" would be guessing at intent from
// punctuation. A list makes every new reference a decision somebody had to make on
// purpose, which is the same argument scripts/check-all-view-tiles.ts makes for MUST_LATCH.
// `_` is a word character, so \b already refuses to match HOW_TO_READ_WITH_SERVICE_STOPPED.
const MAY_NAME_HOW_TO_READ: Record<string, string> = {
  "build-service-preview.ts":
    "builds the /lifetime-stats payload for the preview — it serves the string, it does not print it",
  "freeze-frame-args.ts": "names it in a comment, pointing at where the instruction lives",
  "check-lifetime-stats.ts": "this file",
};
const scriptsDirectory = new URL(".", import.meta.url);
const shellCallers: string[] = [];
for (const entry of await readdir(scriptsDirectory)) {
  if (!entry.endsWith(".ts") || entry in MAY_NAME_HOW_TO_READ) {
    continue;
  }
  const source = await readFile(new URL(entry, scriptsDirectory), "utf-8");
  if (/\bHOW_TO_READ\b/.test(source)) {
    shellCallers.push(entry);
  }
}
check(
  shellCallers.length === 0,
  `no script may print HOW_TO_READ — its reader has no app running, and ${shellCallers.join(", ")} does`
);
console.log(`  headline: "${HOW_TO_READ}"`);

// ⚠️ And the control it names must exist. HOW_TO_READ quotes the service sheet's button
// verbatim; rename that button and a never-read Pi's only instruction points at a control
// that is not there — the --components 51,52 failure again, moved to the in-app half.
const lifetimeReadView = await readFile(new URL("../public/views/lifetime-read.js", import.meta.url), "utf-8");
const quotedLabel = HOW_TO_READ.match(/"([^"]+)"/)?.[1] ?? "";
check(
  quotedLabel !== "" && lifetimeReadView.includes(quotedLabel),
  `HOW_TO_READ quotes "${quotedLabel}", which public/views/lifetime-read.js no longer renders`
);
console.log(`  and "${quotedLabel}" is a button the service sheet renders`);

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
    " classified; AvgDOD's two candidate readings are discriminated; the trailing cycle counter stays outside" +
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
