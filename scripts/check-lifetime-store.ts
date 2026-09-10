import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIFETIME_READ_PAYLOADS } from "./captured-lifetime-reads.ts";
import { loadLifetimeStatistics, writeLifetimeRead } from "../src/vcu/lifetime-store.ts";

// Checks how the last lifetime reading is kept: what gets written, what is refused, and
// what a damaged file does. Run by `npm test` via scripts/run-checks.ts.
//
//   node --experimental-strip-types scripts/check-lifetime-store.ts
//
// ⚠️ THE REFUSALS ARE THE POINT, not the round trip. Taking a reading needs the service
// stopped and can0 up ACTIVE, so the likeliest run of all is the one where the bike was
// asleep and NOTHING answered — and writing that would destroy payloads that cost a
// service stop and a trip to the garage, and cannot be reconstructed from anything.
// src/vcu/snapshot-store.ts rule 5, same argument.

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const ODOMETER_KM = 18440.5;
const storeDirectory = await mkdtemp(join(tmpdir(), "cool-eva-lifetime-"));

// ⚠️ FIRST, on an EMPTY directory: once a file exists the "worse than what is there"
// guard also catches this, masking the loss of the guard under test. See the header.
const NOTHING_ANSWERED = [
  { component: 51, payloadHex: null, failure: "no-session" },
  { component: 52, payloadHex: null, failure: "no-session" },
];
const intoNothing = await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 9, 0, 0, 0),
  source: "read-freeze-frame.ts",
  replies: NOTHING_ANSWERED,
});
check(!intoNothing.stored, "a zero-answer reading must not be written even when there is nothing to lose");
// ⚠️ …but it still leaves a trace. snapshot-store.ts rule 1: refusing to overwrite the
// good file is right, and leaving the refused run's bytes in terminal scrollback only is
// how #160 lost a set of payloads that cost a service stop to get.
check(
  (await readdir(storeDirectory)).some(name => name.startsWith("lifetime-") && name !== "lifetime.json"),
  `a refused write must still archive what it read, found ${JSON.stringify(await readdir(storeDirectory))}`
);
check(
  (await loadLifetimeStatistics(storeDirectory)) === null,
  "…and must leave the directory with no reading at all, which is also what an empty one reads as"
);

await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 8, 13, 18, 0),
  source: "read-freeze-frame.ts",
  replies: LIFETIME_READ_PAYLOADS.map(entry => ({
    component: entry.component,
    payloadHex: entry.payloadHex,
    failure: null,
  })),
});
// ⚠️ A REFUSAL IS NOT AN ANSWER, and it is the shape a first read during a live charge is
// likeliest to produce. `7F A8 22` arrives as a successful exchange carrying a negative
// answer, so the reply has BOTH bytes and a failure — the one shape where `payloadHex !==
// null` and `failure === null` disagree. Counting the bytes made two refusals look like two
// answers, enough to clear the "would replace" guard and overwrite a good reading. Every
// site was reverted in review and no fixture noticed, because none of them built this shape.
const REFUSAL_HEX = "7FA822";
const twoRefusals = await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 9, 22, 10, 0),
  source: "service",
  replies: LIFETIME_READ_PAYLOADS.map(entry => ({
    component: entry.component,
    payloadHex: REFUSAL_HEX,
    failure: "refused: conditionsNotCorrect (NRC 0x22)",
  })),
});
check(!twoRefusals.stored, `two refusals must not be stored as two answers, got: ${twoRefusals.reason}`);
// The sharpest form of it: a good 2-of-2 reading is already on disk here, so counting the
// refusals' bytes as answers would clear `answered < previousAnswered` and destroy it.
const survivor = await loadLifetimeStatistics(storeDirectory);
check(
  survivor !== null && survivor.statistics.rows.find(row => row.key === "odometer_km")?.value === ODOMETER_KM,
  "…and the good reading that was already stored must survive them untouched"
);
check(
  (await readdir(storeDirectory)).some(name => name.startsWith("lifetime-2026-09-09")),
  "…while still archiving the refusal's own bytes, because a refused run leaves a trace too"
);

const restored = await loadLifetimeStatistics(storeDirectory);
check(
  restored !== null && restored.source === "read-freeze-frame.ts",
  "the stored reading should say where it came from"
);
check(restored?.statistics.complete === true, "a stored reading of both components should be complete");
check(
  restored?.statistics.rows.find(row => row.key === "odometer_km")?.value === ODOMETER_KM,
  "the odometer should survive the round trip"
);
check(
  restored?.statistics.rows.find(row => row.key === "exchanged_ah")?.status === "unscaled",
  "the refusal must survive the round trip — the store keeps BYTES so today's decode is not frozen into the file"
);

// The same refusal again, now that there IS something to lose. See the header.
const nothingAnswered = await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 9, 0, 0, 0),
  source: "read-freeze-frame.ts",
  replies: NOTHING_ANSWERED,
});
check(!nothingAnswered.stored, "a reading where nothing answered must not be written");
check(
  (await loadLifetimeStatistics(storeDirectory))?.statistics.rows.find(row => row.key === "odometer_km")?.value ===
    ODOMETER_KM,
  "the previous reading must still be there after a failed read"
);

const halfAnswered = await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 9, 0, 0, 0),
  source: "read-freeze-frame.ts",
  replies: [
    { component: 51, payloadHex: LIFETIME_READ_PAYLOADS[0].payloadHex, failure: null },
    { component: 52, payloadHex: null, failure: "no-response" },
  ],
});
check(!halfAnswered.stored, "one answered reply must not replace two");
console.log(`  refused a zero-answer write and a 1-of-2 write: ${halfAnswered.reason}`);

// ⚠️ Every element, not just the array. A block on a debug tab must not be able to kill
// the service: on the Pi this runs inside an HTTP handler with no try around it, in a
// process with no unhandledRejection hook. Caught here so it REPORTS rather than dies.
await writeFile(join(storeDirectory, "lifetime.json"), JSON.stringify({ readAt: 1, replies: [null] }), "utf-8");
try {
  check(
    (await loadLifetimeStatistics(storeDirectory)) === null,
    "a reading whose replies are not replies must read as none"
  );
} catch (err) {
  failures.push(`loading a file whose replies are not replies THREW, which would take the service down: ${err}`);
}

// A stored payload that is not hex. ⚠️ The parser this uses rejects rather than coercing
// — `Number.parseInt("ZZ", 16)` is NaN and `Uint8Array.from` would make it a confident
// 0x00, a field the dashboard would then show as a reading.
await writeFile(
  join(storeDirectory, "lifetime.json"),
  JSON.stringify({ readAt: 1, replies: [{ component: 52, payloadHex: "57 01 ZZ 34", failure: null }] }),
  "utf-8"
);
const notHex = await loadLifetimeStatistics(storeDirectory);
check(
  notHex?.statistics.rows.every(row => row.status === "missing") ?? false,
  "a stored payload that is not hex must decode to nothing, not to coerced zeroes"
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
  "\n✓ a reading round-trips through the stored BYTES rather than the rendered numbers;" +
    " a run where nothing answered and a run worse than the file are both refused with a reason;" +
    " and a damaged file, or one whose replies are not replies, reads as no reading rather than taking the service down"
);
