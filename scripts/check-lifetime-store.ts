import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

// ⚠️ FIRST, on an EMPTY directory. A zero-answer write is also caught by the
// "worse than what is there" guard once a file exists, which would mask the loss of
// this one — and the empty case is the one a fresh Pi meets.
const intoNothing = await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 9, 0, 0, 0),
  source: "read-freeze-frame.ts",
  replies: [
    { component: 51, payloadHex: null, failure: "no-session" },
    { component: 52, payloadHex: null, failure: "no-session" },
  ],
});
check(!intoNothing.stored, "a zero-answer reading must not be written even when there is nothing to lose");
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

// ⚠️ A worse run must not clobber a good file. Taking a reading needs the service
// stopped and can0 up ACTIVE, so "nothing answered" is the likeliest run of all, and
// writing it would destroy payloads that cost a trip to the garage.
const nothingAnswered = await writeLifetimeRead(storeDirectory, {
  readAt: Date.UTC(2026, 8, 9, 0, 0, 0),
  source: "read-freeze-frame.ts",
  replies: [
    { component: 51, payloadHex: null, failure: "no-session" },
    { component: 52, payloadHex: null, failure: "no-session" },
  ],
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

// ⚠️ Every element, not just the array: a `replies: [null]` reaching the decoder would
// throw inside an HTTP handler that is not wrapped in a try, in a process with no
// unhandledRejection hook. A block on a debug tab must not be able to kill the service.
await writeFile(join(storeDirectory, "lifetime.json"), JSON.stringify({ readAt: 1, replies: [null] }), "utf-8");
// Caught rather than awaited bare, so this REPORTS the fault instead of dying of it —
// which is the whole point: on the Pi this path runs inside an HTTP handler that is not
// wrapped in a try, in a process with no unhandledRejection hook.
try {
  check(
    (await loadLifetimeStatistics(storeDirectory)) === null,
    "a reading whose replies are not replies must read as none"
  );
} catch (err) {
  failures.push(`loading a file whose replies are not replies THREW, which would take the service down: ${err}`);
}

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
