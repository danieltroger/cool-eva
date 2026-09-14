import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  a8FirmwareRows,
  describeFirmwareRow,
  firmwareRowFor,
  type A8FirmwareRow,
} from "../src/vcu/a8-firmware-rows.ts";
import { interpretRecord } from "../src/vcu/param-codec.ts";
import {
  KNOWN_TABLE_TYPES,
  parameterAtIndex,
  parameterTable,
  parameterTableFor,
  recordLengthFor,
  type VcuMicro,
} from "../src/vcu/param-table.ts";
import { openPartialSweepLog } from "../src/vcu/snapshot-store.ts";
import { SERVICE_STAMP_IDENTIFIERS } from "../src/vcu/service-actions.ts";
import { describeProbe } from "../src/vcu/probe.ts";
import { retableSnapshot, reportTableType, toParameterRow, type VcuParameterRow } from "../src/vcu/snapshot.ts";
import { snapshotToBackupCsv } from "../src/vcu/backup-csv.ts";
import { writeTargets } from "../src/vcu/write-targets.ts";
import { startParameterSweep } from "../src/vcu/sweep.ts";
import { sweepTargets } from "../src/vcu/sweep-targets.ts";
import type { VcuProbeOutcome, VcuReadOutcome } from "../src/vcu/kwp-client.ts";
import type { ObdPollerHold } from "../src/can/obd-hold.ts";
import { simulateVcuMicros } from "./simulated-vcu-micro.ts";
import { parseHexBytes } from "./captured-vcu-records.ts";

// The 25 bank-1 parameters A8 serves that `params.ecf` does not describe (#219): that they
// are described, that they stay OUT of the name table and out of the write targets, that a
// reply is checked against the width A8's firmware claims, and that a sweep parks the OBD
// poller for exactly those 25 and for nothing else.
//
//   node --experimental-strip-types scripts/check-a8-block.ts
//
// ⚠️ Its own file rather than a §18 of scripts/check-vcu-params.ts, which is already 3200
// lines. The transport sections there cover a client; §7 here drives a whole SWEEP, which
// is new — nothing in scripts/ did that before — and needs a temp directory, an injected
// gate and an injected poller hold to do it.
//
// Every assertion below was mutation-tested: the source was broken and the check confirmed
// RED BY EXIT CODE, since failures print on stderr and a harness grepping stdout would
// report a false green. The mutations are named where they are not obvious.

const failures: string[] = [];

// ── 1. The registry: 25 rows, and the widths are LITERALS ───────────────────
// Widths written out rather than derived from the module under test: a budget taken from
// the thing it is judging cannot fail. These come from #219's read of A8's firmware
// parameter table, which is the only source there is for them.
const EXPECTED_WIDTHS = new Map<number, string>([
  [278, "DWORD"],
  [279, "DWORD"],
  [613, "WORD"],
  [614, "WORD"],
  [615, "WORD"],
  [616, "WORD"],
  [617, "WORD"],
  [618, "WORD"],
  [619, "WORD"],
  [620, "WORD"],
  [621, "WORD"],
  [622, "WORD"],
  [623, "WORD"],
  [624, "WORD"],
  [625, "WORD"],
  [626, "DWORD"],
  [627, "BYTE"],
  [1000, "WORD"],
  [1001, "WORD"],
  [1002, "WORD"],
  [1003, "WORD"],
  [1004, "WORD"],
  [1005, "WORD"],
  [1006, "WORD"],
  [1007, "WORD"],
]);

const rows = a8FirmwareRows();
expect(rows.length === 25, `the block should hold 25 rows, holds ${rows.length}`);
expect(
  rows.map(row => row.index).join(",") === [...EXPECTED_WIDTHS.keys()].join(","),
  "the block's indices should be exactly 278, 279, 613-627 and 1000-1007, ascending"
);
for (const row of rows) {
  const expected = EXPECTED_WIDTHS.get(row.index);
  expect(row.type === expected, `index ${row.index} should be typed ${expected}, the module says ${row.type}`);
  expect(
    row.identifier === 0x1000 + row.index,
    `index ${row.index} should carry identifier 0x${(0x1000 + row.index).toString(16)}`
  );
  expect(row.micro === "A8", `index ${row.index} should be an A8 row; A9 serves none of these`);
  expect(
    row.signed === null,
    `index ${row.index} must carry no sign — the firmware entry types the width and nothing else`
  );
}
expect(
  rows.filter(row => row.type === "DWORD").length === 3,
  "exactly three rows are DWORD — 278, 279 and 626, the only replies here that cannot fit one frame"
);

// The lookup is keyed on the micro and the bank, not on the index alone. A probe can name
// any target and any bank from a phone, and A8 bank 1 index 1000 is the only one of these
// three that is the service date's low word.
expect(firmwareRowFor("A8", 1, 1000)?.index === 1000, "A8 bank 1 index 1000 should resolve");
expect(firmwareRowFor("A9", 1, 1000) === null, "A9 bank 1 index 1000 must NOT resolve — the table is A8's");
expect(firmwareRowFor("A8", 2, 1000) === null, "A8 bank 2 index 1000 must NOT resolve — bank 2 is live data");
expect(firmwareRowFor("A8", 1, 254) === null, "a named A8 parameter must not also resolve as a firmware row");
expect(
  describeFirmwareRow(firmwareRowFor("A8", 1, 617) as A8FirmwareRow).includes("nothing traced"),
  "a row with nothing traced should say so rather than leaving an absence"
);

// ── 2. Isolation: not in any table, and not a write target ──────────────────
// ⚠️ THE ASSERTION THIS FILE EXISTS FOR. scripts/check-vcu-params.ts:1771 asserts the write
// targets' COUNT against `parameterTable().length` — a budget derived from the table — so
// if these 25 were ever merged into the name table, that check would stay green while 25
// new write targets appeared, the odometer master among them.
expect(
  parameterTable().length === 277,
  `the active name table should still hold 277 rows, holds ${parameterTable().length}`
);
expect(writeTargets().length === 269, `there should still be 269 write targets, there are ${writeTargets().length}`);
const blockIndices = new Set(rows.map(row => row.index));
const targetsInBlock = writeTargets().filter(target => blockIndices.has(target.index));
expect(
  targetsInBlock.length === 0,
  `no write target may address the block; found ${targetsInBlock.map(target => `${target.index} ${target.name}`).join(", ")}`
);

// ⚠️ Against EVERY carried table, not against the active 277. Two of the 29 (61451, 61452)
// carry a 278th row at index 300 `MOTORING_MAP`, so a collision check against the active
// table only would be green on the one table that has a row outside 1…277.
const everyDescribedIndex = new Set<number>();
for (const tableType of KNOWN_TABLE_TYPES) {
  for (const parameter of parameterTableFor(tableType)?.parameters ?? []) {
    everyDescribedIndex.add(parameter.index);
  }
}
expect(KNOWN_TABLE_TYPES.length === 29, `29 tables should be carried, the catalogue has ${KNOWN_TABLE_TYPES.length}`);
expect(
  Math.max(...everyDescribedIndex) === 300,
  "the union should reach index 300 (MOTORING_MAP on 61451/61452) — otherwise this check never looked at the 278-row tables"
);
const collisions = [...blockIndices].filter(index => everyDescribedIndex.has(index));
expect(collisions.length === 0, `no block index may be one any carried table describes; collides at ${collisions}`);

// ── 3. Interpretation: the width is checked, the value is withheld ──────────
// A firmware row types the width and says nothing about sign, so there is never a typed
// value — only raw bytes and an unsigned reading. Mutation: give a row `signed: false` and
// the first of these goes red.
const serviceDateLow = firmwareRowFor("A8", 1, 1000) as A8FirmwareRow;
const asWord = interpretRecord(parseHexBytes("00 00"), serviceDateLow);
expect(
  asWord.value === null && asWord.unsigned === 0 && !asWord.widthMismatch,
  "a 2-byte reply to a WORD row agrees with the width, and still carries no typed value"
);
const odometerHalf = firmwareRowFor("A8", 1, 278) as A8FirmwareRow;
const asDword = interpretRecord(parseHexBytes("00 02 99 90"), odometerHalf);
expect(
  asDword.unsigned === 170384 && asDword.value === null && !asDword.widthMismatch,
  `a 4-byte reply to a DWORD row reads big-endian unsigned, got ${asDword.unsigned}`
);
const tooNarrow = interpretRecord(parseHexBytes("00 02"), odometerHalf);
expect(
  tooNarrow.widthMismatch && tooNarrow.value === null && tooNarrow.rawHex === "00 02",
  "a 2-byte reply to a DWORD row is a width mismatch, value withheld, raw kept"
);
// The named half of the same function must keep working — the argument widened, the
// behaviour for a table row did not.
expect(
  interpretRecord(parseHexBytes("07 BF"), parameterAtIndex(254)).value === 1983,
  "a named WORD parameter still reads as a typed value"
);

// ── 4. Rows, probes and the export ──────────────────────────────────────────
const blockRow = toParameterRow(readOutcome(1000, parseHexBytes("00 00")));
expect(blockRow.name === null, "a block row stays UNNAMED — it is not a params.ecf name");
expect(blockRow.type === "WORD", "…but it carries the width A8's firmware table claims");
expect(blockRow.value === null && blockRow.unsigned === 0, "…and a raw reading rather than a typed one");
expect(
  blockRow.note?.includes("last-service date") === true && blockRow.note?.includes("not in params.ecf") === true,
  `a block row says what is known about it, got ${JSON.stringify(blockRow.note)}`
);
const mismatchedRow = toParameterRow(readOutcome(626, parseHexBytes("00 02")));
expect(
  mismatchedRow.widthMismatch && mismatchedRow.note?.includes("A8's firmware table says DWORD") === true,
  `a wrong-width block reply names WHICH width it contradicts, got ${JSON.stringify(mismatchedRow.note)}`
);
expect(
  toParameterRow(readOutcome(258, parseHexBytes("4B"))).note === null,
  "a clean read of a NAMED parameter still carries no note"
);

// The export another owner's tool reads must never carry these: it is keyed by name and
// restored by value, and a block row has neither.
const exported = snapshotToBackupCsv({
  readAt: 0,
  complete: true,
  micros: ["A8"],
  rows: [blockRow, toParameterRow(readOutcome(254, parseHexBytes("07 BF")))],
});
expect(!exported.includes("0x3E8"), "a block row must not reach vcu_backup.csv");
expect(exported.includes("SPEED_ODO_REARWHEEL_C"), "…while a named row still does");

// A probe of the same identifier says the same thing; a probe of the same INDEX on the
// other micro, or in the other bank, must not.
const probed = describeProbe(probeOutcome("A8", 1, 1000, parseHexBytes("00 00")));
expect(probed.name === null && probed.note?.includes("last-service date") === true, "a probe carries what is known");
const probedOnA9 = describeProbe(probeOutcome("A9", 1, 1000, parseHexBytes("00 00")));
expect(
  probedOnA9.note?.includes("nothing in the name table describes this identifier") === true,
  "the same index on A9 gets the honest “nothing describes this” note, not A8's provenance"
);

// ── 5. Re-tabling: the width survives a serve, and a contradicted micro loses it ──
// /vcu-params re-tables on EVERY serve, so an unhandled block row would lose its width on
// the first page load. Mutation: drop the firmware fallback in retableRow and the first
// of these goes red; drop the `contradictedBy` guard and the second does.
/** One snapshot through the re-table both `writeSnapshot` and every /vcu-params serve perform. */
function served(rows: VcuParameterRow[]): VcuParameterRow[] {
  const snapshot = { readAt: 0, complete: true, micros: ["A8", "A9"] as VcuMicro[], rows };
  return retableSnapshot(snapshot, reportTableType(snapshot)).rows;
}

const stamped = (tableType: string): VcuParameterRow[] => [
  toParameterRow(readOutcome(277, parseHexBytes(tableType), "A8")),
  toParameterRow(readOutcome(276, parseHexBytes(tableType), "A9")),
  blockRow,
];
const retabledBlock = served([...stamped("40 17"), blockRow]).find(row => row.index === 1000);
expect(retabledBlock?.type === "WORD", "a block row keeps its firmware width across a re-table");
expect(
  retabledBlock?.note?.includes("last-service date") === true,
  "…and keeps what is known about it, which is the only place a flat row can carry it"
);
// ⚠️ A COUNT, not an `includes`. Re-tabling happens on the way to disk and again on every
// /vcu-params serve, so a note that gains a copy each time is invisible to `includes` and
// renders three deep in the value cell of a row that never answered. Mutation: put `known`
// back into retableRow's two preserved-note branches and this goes red at 2.
const silentBlockRow = toParameterRow({
  micro: "A8",
  index: 613,
  identifier: 0x1265,
  status: "no-response",
  flowControlLatency: null,
});
// Twice, because that is what the real path does: once on the way to disk and once per
// /vcu-params serve.
const servedNote = served(served([silentBlockRow, ...stamped("40 17")])).find(row => row.index === 613)?.note ?? "";
expect(
  occurrences(servedNote, "A8's own firmware table types index 613") === 1,
  `a silent block row says what it is ONCE however often it is re-tabled, said ${occurrences(servedNote, "A8's own firmware table types index 613")} times`
);
expect(
  servedNote.includes("no reply in an open session") && servedNote.includes("nothing traced"),
  "…and still carries BOTH the reason it did not answer and what is known about it"
);
const contradictedBlock = served([...stamped("FF FF"), blockRow]).find(row => row.index === 1000);
expect(
  contradictedBlock?.type === null,
  "a micro naming a table this software does not carry loses the firmware width too — we cannot assert its build either"
);
expect(contradictedBlock?.rawHex === "00 00", "…while the bike's own bytes survive, as they always do");

// ── 6. Agreement with the service stamp, which named 1000-1003 first ────────
// src/vcu/service-actions.ts has carried these four since the service-stamp work. Two
// modules naming the same cells must not drift; this is what stops them.
for (const [half, identity] of Object.entries(SERVICE_STAMP_IDENTIFIERS)) {
  const row = firmwareRowFor("A8", 1, identity.index);
  expect(
    row?.identifier === identity.identifier,
    `the block disagrees with SERVICE_STAMP_IDENTIFIERS about ${half} (index ${identity.index})`
  );
}

// ── 7. Replay of the five live probes, 2026-09-14 ───────────────────────────
// ⚠️ THE FILE IS TRUNCATED. Every line is cut at ~700 bytes, mid-`gate` object, so
// JSON.parse over a line gets nothing. The `reading` object comes first and survives
// intact, so it is brace-matched out of each prefix. The COUNT is asserted before
// anything else: a re-recorded or re-truncated file must fail loudly rather than silently
// leave the assertions below with nothing to run on.
const readings = await recordedProbeReadings("evidence/probes-20260914.txt");
expect(
  readings.length === 5,
  `the 2026-09-14 evidence should yield 5 readings, brace-matching found ${readings.length}`
);

const recorded1000 = readings.find(reading => reading.index === 1000);
const replayed = toParameterRow(readOutcome(1000, parseHexBytes(recorded1000?.rawHex ?? "")));
expect(
  replayed.type === "WORD" && !replayed.widthMismatch,
  "the 2 bytes A8 really answered at index 1000 agree with the WORD the firmware table claims"
);
expect(
  replayed.value === null && replayed.unsigned === 0,
  "…and still produce no typed value, because the sign is unknown"
);

const recorded254 = readings.find(reading => reading.index === 254);
expect(
  recorded254?.name === "SPEED_ODO_REARWHEEL_C" && recorded254.value === 1983,
  "the control probe still names a params.ecf parameter and its value — that is what makes the rest believable"
);

// ⚠️ A DOC-CITATION GUARD, NOT A TEST. These two read a committed file and assert what is
// in it; no mutation of src/ can turn them red. They exist because docs/vcu-parameters.md
// §9 quotes both statuses verbatim, and a re-recorded evidence file would rot the quote.
expect(
  readings.find(reading => reading.index === 278)?.status === "multi-frame",
  "the evidence file still records 278 as the pre-#231 `multi-frame` outcome that §9 quotes"
);
expect(
  readings.find(reading => reading.index === 613)?.status === "no-session",
  "…and 613 as `no-session`, the transport failure §2 and the probe plan both rest on"
);

// ── 8. The sweep: the list, and the poller park ─────────────────────────────
const targets = sweepTargets();
expect(targets.length === 302, `a sweep should ask about 302 identifiers (277 + 25), its list holds ${targets.length}`);
expect(
  targets.filter(target => target.widthUnverified).length === 25,
  "exactly the 25 firmware rows are marked as such — that flag is what decides the park"
);
expect(
  targets.filter(target => target.widthUnverified).every(target => blockIndices.has(target.index)),
  "…and every marked target is one of the block's"
);
expect(
  targets.findIndex(target => target.micro === "A8") > targets.findLastIndex(target => target.micro === "A9"),
  "A9 first, then A8: the two hold separate sessions and hopping between them would idle each one out"
);

await checkTheSweepParks();

/**
 * One whole sweep against the simulated micros, and two more with the resume file
 * pre-filled so only the block is left to read.
 *
 * ⚠️ The three behaviours here cannot be reached any other way: the hold is taken inside
 * the sweep's own loop, and whether a frame went out when it was refused is a question
 * about the bus. The first run is a FULL sweep (302 reads, ~3 s) because "parked for 25
 * and for none of the other 277" is a statement about the whole list.
 */
async function checkTheSweepParks(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-a8-block-"));
  try {
    const full = await runSweepAgainstDouble(directory, { hold: "granted" });
    expect(
      full.holdReasons.length === 25,
      `the poller should be parked 25 times in a full sweep, was parked ${full.holdReasons.length}`
    );
    expect(
      full.holdReasons.every(reason => [...blockIndices].some(index => reason.includes(` ${index}`))),
      `every park should name a block index; got ${full.holdReasons.slice(0, 3).join(" | ")}`
    );
    const odometer = full.rows.find(row => row.index === 278);
    expect(
      odometer?.status === "read" && odometer.rawHex === "00 02 99 90",
      `278's 4-byte record should assemble through the flow control, got ${JSON.stringify(odometer?.rawHex)}`
    );
    expect(
      full.sentFrames.some(frame => frame.startsWith("A8 30 FF 00")),
      "…which means a flow control really went out for it"
    );
    expect(full.rows.length === 302, `a full sweep should record 302 rows, recorded ${full.rows.length}`);
    // ⚠️ The HANDLE's number, not the target list's. `read-runner.ts` renders this one as
    // "n of N read" and no longer computes its own, so a regression here says "302 of 277"
    // on the service sheet and nothing else in the suite notices. Mutation: revert
    // sweep.ts's `expected` to `parameterTable().length` and this goes red at 277.
    expect(
      full.expected === 302,
      `the sweep handle should promise 302 — what the page renders — it promised ${full.expected}`
    );

    // ── a refused park ──────────────────────────────────────────────────────
    // ⚠️ ONE refusal, not 25. `holdObdPoller` waits up to 6 s before giving up, so asking
    // once per row would be 150 s of a sweep doing nothing. Mutation: drop `pollerRefusal`
    // and this goes red at 25.
    await prefillResumeFile(directory);
    const refused = await runSweepAgainstDouble(directory, { hold: "refused" });
    expect(
      refused.holdReasons.length === 1,
      `a refused park should end the block after ONE attempt, made ${refused.holdReasons.length}`
    );
    const blockRows = refused.rows.filter(row => blockIndices.has(row.index));
    expect(
      blockRows.length === 25 && blockRows.every(row => row.status === "not-sent"),
      `all 25 block rows should be recorded not-sent, ${blockRows.filter(row => row.status === "not-sent").length} were`
    );
    expect(
      blockRows.every(row => row.note?.includes("would not go quiet") === true),
      "…each carrying the poller's own refusal sentence, not a claim about the bike"
    );
    // ⚠️ And a sentence that is true of THIS row. The reason the hold reported names the
    // row it was refused for — always the first of the block — and stamping that verbatim
    // on the other 24 made index 1007 say the poller would not park for a read of 278.
    // Mutation: store `held.reason` instead of the generic sentence and this goes red.
    // The refusal is the half of the note before the firmware sentence, which legitimately
    // names indices (279's says "see 278"). It must be the SAME sentence on all 25 and must
    // name no index at all.
    const refusals = new Set(blockRows.map(row => row.note?.split(" — not in params.ecf")[0] ?? ""));
    expect(refusals.size === 1, `all 25 refusals should read alike; got ${refusals.size} different sentences`);
    const refusal = [...refusals][0] ?? "";
    expect(
      !/index \d+/.test(refusal),
      `a refusal is stamped on 25 rows, so it must name no index at all; got ${JSON.stringify(refusal)}`
    );
    expect(
      !refused.sentRequests.some(request => namesABlockIndex(request)),
      `nothing may reach the bus for a block row when the poller would not park; sent ${refused.sentRequests.join(" | ")}`
    );
    // ⚠️ Strictly stronger, and it is what proves the resume file was understood: the 277
    // are on record as read, the 25 were never asked, so this run must put NO parameter
    // read on the bus at all. Without it a prefill that silently did nothing would leave
    // every other assertion in this block green while the sweep read all 302.
    expect(
      noReadsReached(refused.sentRequests),
      `a resumed sweep whose park was refused should ask for nothing; sent ${refused.sentRequests.join(" | ")}`
    );

    // ── the gate closing MID-SWEEP, which is the auto-exit itself ───────────
    // ⚠️ Pre-existing behaviour with no assertion anywhere until now: I disabled
    // `sweep.ts`'s per-parameter `mayContinue` and ran the whole suite — **all 56 checks
    // stayed green** while a sweep would have carried on transmitting to a motorcycle that
    // had started moving. It is the half of the auto-exit that runs between the loop and
    // the socket, and this harness is the only thing in scripts/ that drives a real sweep,
    // so it is closed here rather than left for the next person to rediscover.
    // ⚠️ NOT prefilled, deliberately. With only the block left to read, every row goes
    // through the post-park `mayContinue` and that one alone would satisfy this — which it
    // did, hiding the loop's check from the mutation. A full sweep reads named rows first,
    // where the loop's check is the only thing between the gate and the socket.
    await clearResumeFile(directory);
    const movedOff = await runSweepAgainstDouble(directory, { hold: "granted", gateSafeForChecks: 3 });
    expect(
      movedOff.stoppedBecause?.includes("the bike started moving") === true,
      `a gate that closes mid-sweep should stop it, said ${JSON.stringify(movedOff.stoppedBecause)}`
    );
    const readsAfterTheGateShut = movedOff.sentRequests.filter(request => request.split(" ")[1] === "22").length;
    expect(
      readsAfterTheGateShut <= 3,
      `a sweep must not keep reading once the gate shuts; it put ${readsAfterTheGateShut} reads on the bus`
    );

    // ── the gate closing during the park ────────────────────────────────────
    // Mutation: drop the re-check inside `readWithPollerParked` and this goes red — the
    // read is transmitted on a decision taken up to 6 s before the frame.
    await prefillResumeFile(directory);
    const closed = await runSweepAgainstDouble(directory, { hold: "granted", closeGateOnPark: true });
    expect(
      !closed.sentRequests.some(request => namesABlockIndex(request)) && noReadsReached(closed.sentRequests),
      `a gate that closes while the poller parks must stop the read; sent ${closed.sentRequests.join(" | ")}`
    );
  } finally {
    // Warned rather than thrown: the assertions above are already recorded, and a temp
    // directory that outlives this process is a tidiness problem, not a failed check.
    await rm(directory, { recursive: true, force: true }).catch((err: unknown) =>
      console.warn("check-a8-block: could not remove the temp directory:", err)
    );
  }
}

interface SweepRun {
  rows: VcuParameterRow[];
  holdReasons: string[];
  sentRequests: string[];
  sentFrames: string[];
  /** What the handle promised the page, which is what `read-runner.ts` now renders. */
  expected: number;
  /** Null when the sweep asked about everything on its list. */
  stoppedBecause: string | null;
}

async function runSweepAgainstDouble(
  directory: string,
  behaviour: { hold: "granted" | "refused"; closeGateOnPark?: boolean; gateSafeForChecks?: number }
): Promise<SweepRun> {
  const bus = simulateVcuMicros([
    { target: "A9", records: recordsFor("A9") },
    { target: "A8", records: recordsFor("A8") },
  ]);
  const holdReasons: string[] = [];
  let safe = true;
  let gateChecks = 0;
  const sweep = startParameterSweep({
    channel: bus.channel,
    directory,
    checkGate: () => {
      gateChecks += 1;
      const stillSafe = safe && gateChecks <= (behaviour.gateSafeForChecks ?? Number.POSITIVE_INFINITY);
      return {
        safe: stillSafe,
        blockers: stillSafe ? [] : ["the bike started moving"],
        checks: [],
        chargingEvidence: null,
      };
    },
    acquirePollerHold: async (reason: string): Promise<ObdPollerHold | null> => {
      holdReasons.push(reason);
      if (behaviour.closeGateOnPark) {
        // The bike starts moving WHILE the poller is going quiet — the window the
        // re-check on the far side of the park exists for.
        safe = false;
      }
      return behaviour.hold === "granted" ? { release: () => undefined } : null;
    },
  });
  bus.channel.addListener("onMessage", message => sweep.handleFrame(message.id, message.data));
  const result = await runQuietly(() => sweep.finished);
  return {
    rows: result.snapshot.rows,
    holdReasons,
    sentRequests: bus.sentRequests,
    sentFrames: bus.sentFrames,
    expected: sweep.expected,
    stoppedBecause: result.stoppedBecause,
  };
}

/** Every identifier the sweep will ask this micro about, answered at the width it expects. */
function recordsFor(micro: "A8" | "A9"): Map<number, Uint8Array> {
  const records = new Map<number, Uint8Array>();
  for (const parameter of parameterTable()) {
    if (parameter.micro === micro) {
      records.set(parameter.index, new Uint8Array(recordLengthFor(parameter.type)));
    }
  }
  // 276/277 answer 0x4017 = 16407, this bike's own table, so the sweep's closing report
  // is the one a real sweep would print. Zeroes there make it shout about a table nothing
  // carries, which buries the run in a warning that is about the double and not the code.
  records.set(micro === "A9" ? 276 : 277, parseHexBytes("40 17"));
  if (micro === "A8") {
    for (const row of a8FirmwareRows()) {
      // 170384 = 17038.4 km, the shape this bike's odometer really has — so a wrong
      // assembly shows up as a wrong number rather than as an arbitrary one.
      records.set(
        row.index,
        row.index === 278 ? parseHexBytes("00 02 99 90") : new Uint8Array(recordLengthFor(row.type))
      );
    }
  }
  return records;
}

/**
 * Marks the 277 named parameters as already read, so the next sweep asks only about the
 * block — 25 reads instead of 302 for the two runs that are about the park rather than
 * about the list.
 *
 * ⚠️ Written through `openPartialSweepLog` and `toParameterRow` rather than as a JSON
 * literal, and that is not tidiness: the filename and the line shape belong to
 * ../src/vcu/snapshot-store.ts, and a hand-written copy that drifted from either would
 * leave the sweep reading all 302 while both assertions below STAYED GREEN — the refusal
 * latch fires on the first block row either way, and 25 block rows are recorded either
 * way. `noReadsReached` is what actually proves the resume took.
 */
async function prefillResumeFile(directory: string): Promise<void> {
  const partial = await openPartialSweepLog(directory);
  try {
    for (const parameter of parameterTable()) {
      // 276/277 carry 0x4017, this bike's own table: a resumed sweep re-reports the table
      // type from its rows, and zeroes there make it shout about a table nothing carries.
      const namesTheTable = parameter.index === 276 || parameter.index === 277;
      const record = namesTheTable ? parseHexBytes("40 17") : new Uint8Array(recordLengthFor(parameter.type));
      await partial.append(toParameterRow(readOutcome(parameter.index, record, parameter.micro)));
    }
  } finally {
    await partial.close();
  }
}

/** Throws the resume file away, so the next run is a full sweep rather than a resumed one. */
async function clearResumeFile(directory: string): Promise<void> {
  await rm(join(directory, "sweep.partial.jsonl"), { force: true });
}

/** True when no parameter read reached the bus at all — which is what a resumed-then-refused sweep must do. */
function noReadsReached(sentRequests: string[]): boolean {
  return !sentRequests.some(request => request.split(" ")[1] === "22");
}

/** `A8 22 13 E8` → true for any of the block's identifiers. */
function namesABlockIndex(request: string): boolean {
  const bytes = request.split(" ");
  if (bytes.length < 4 || bytes[1] !== "22") {
    return false;
  }
  const identifier = Number.parseInt(`${bytes[2]}${bytes[3]}`, 16);
  return blockIndices.has(identifier & 0x0fff) && identifier >> 12 === 1;
}

/**
 * Runs something that prints 300 lines per sweep, and only shows them if it threw.
 *
 * ⚠️ Nothing is swallowed: the captured lines are re-played on a throw, which is the one
 * time they are worth reading. Without this, three sweeps bury this file's own output in
 * ~900 rows of `vcu-sweep:` and the check becomes unreadable in CI.
 */
async function runQuietly<T>(body: () => Promise<T>): Promise<T> {
  const captured: unknown[][] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const failuresBefore = failures.length;
  console.log = (...args: unknown[]) => captured.push(args);
  console.warn = (...args: unknown[]) => captured.push(args);
  try {
    return await body();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    // ⚠️ Replayed when a failure was RECORDED as well as when one was thrown. This file
    // reports by pushing to `failures` and exiting non-zero — it never throws — so
    // replaying only on a throw would discard the 300 sweep lines in exactly the run whose
    // failure they explain. Nothing is swallowed either way; a green run is just quiet.
    if (failures.length > failuresBefore) {
      for (const line of captured) {
        realLog(...line);
      }
    }
  }
}

/** One probe that answered. Its identity is a TARGET, a bank and an index — never a micro. */
function probeOutcome(target: "A8" | "A9", bank: number, index: number, record: Uint8Array): VcuProbeOutcome {
  return { target, bank, index, identifier: (bank << 12) | index, status: "read", record, flowControlLatency: null };
}

/** One read that answered, in the shape the sweep hands to `toParameterRow`. */
function readOutcome(index: number, record: Uint8Array, micro: "A8" | "A9" = "A8"): VcuReadOutcome {
  return { micro, index, identifier: 0x1000 + index, status: "read", record, flowControlLatency: null };
}

/** What one probe recorded in the evidence file, as much of it as the truncation left. */
interface RecordedReading {
  index: number;
  status: string;
  rawHex: string | null;
  name: string | null;
  value: number | null;
}

/**
 * The `reading` object out of each truncated record.
 *
 * Brace-matched rather than parsed line by line, and string-aware: a `{` inside a quoted
 * note would otherwise unbalance the count. `fs/promises`, never a `*Sync` — this file runs
 * in the same suite as everything else and the rule is repo-wide.
 */
async function recordedProbeReadings(path: string): Promise<RecordedReading[]> {
  const text = await readFile(path, "utf-8");
  const found: RecordedReading[] = [];
  const key = '"reading":';
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + key.length)) {
    const slice = balancedObjectAt(text, at + key.length);
    if (slice === null) {
      continue;
    }
    found.push(JSON.parse(slice) as RecordedReading);
  }
  return found;
}

/** The `{…}` that starts at or after `from`, or null when the text runs out mid-object. */
function balancedObjectAt(text: string, from: number): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let at = from; at < text.length; at += 1) {
    const character = text[at];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) {
        start = at;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, at + 1);
      }
    }
  }
  return null;
}

/** How many times a sentence appears. `includes` is green at one copy or at five. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ the 25 A8 firmware-table rows: their widths, that they stay out of all 29 name tables and out of the 269 " +
    "write targets, the width check and the withheld value, the re-table, the service-stamp agreement, the " +
    "2026-09-14 evidence replayed, and a sweep that parks the OBD poller for those 25 and for none of the other 277"
);
