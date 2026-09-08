import { simulateVcuMicros } from "./simulated-vcu-micro.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";
import { LIFETIME_READ_PAYLOADS } from "./captured-lifetime-reads.ts";
import { startLifetimeRead } from "../src/vcu/lifetime-read.ts";
import { arrivalLatencyMs, frameArrival } from "../src/can/frame-arrival.ts";
import { loadLifetimeStatistics, writeLifetimeRead } from "../src/vcu/lifetime-store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The in-service lifetime read, driven end to end against a simulated A8 — session,
// request, First Frame, our flow control, Consecutive Frames, reassembly, decode, store.
// Run by `npm test` via scripts/run-checks.ts.
//
//   node --experimental-strip-types scripts/check-lifetime-read.ts
//
// ⚠️ WHAT EACH PART OF THIS IS WORTH, because an item that quietly degrades to "the
// function exists" is worse than one that is not claimed:
//
//   §1 END-TO-END. The real client, the real reassembler, the real flow control, and
//      the captured 2026-09-08 payloads as what the double serves.
//   §2 END-TO-END for the retry, using the double's own silence modelling.
//   §3 PURE. The arrival-latency arithmetic, including the two clock-step refusals.
//   §4 PLUMBING ONLY, and it says so where it runs: the double's `deliverFrame` emits
//      no `ts_sec`, and a 2 ms reply delay on an idle loop proves nothing whatever
//      about the number this feature exists to measure. That number comes from the
//      bike, once, and nothing here can stand in for it.
//
// ⚠️ And what the double itself is worth: its reply half is a double of a guess
// (scripts/simulated-vcu-micro.ts's own header). Passing here proves this client is
// well-behaved against the framing this repo believes in. It does not prove the bike
// behaves that way.

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

/** The two captured payloads, as the double will serve them. */
const FREEZE_FRAMES = new Map(
  LIFETIME_READ_PAYLOADS.map(entry => [entry.component, parseHexFrame(entry.payloadHex)] as const)
);

// ── §1 The read, end to end against the double ──────────────────────────────
console.log("── §1 the whole read against a simulated A8 ───────────────────────");

const bus = simulateVcuMicros([{ target: "A8", records: new Map(), freezeFrames: FREEZE_FRAMES }]);
const read = startLifetimeRead({ channel: bus.channel });
bus.channel.addListener("onMessage", message => read.handleFrame(message.id, message.data, frameArrival(message)));
const result = await read.finished;

check(result.replies.length === 2, `both components should be asked about, got ${result.replies.length}`);
for (const reply of result.replies) {
  check(reply.payloadHex !== null, `component ${reply.component} should have answered, got ${reply.failure}`);
}
for (const expected of LIFETIME_READ_PAYLOADS) {
  const reply = result.replies.find(candidate => candidate.component === expected.component);
  check(
    reply?.payloadHex === expected.payloadHex,
    `component ${expected.component} should reassemble to the captured payload, got ${reply?.payloadHex}`
  );
}
// ⚠️ Both of these segment — 26 and 20 bytes against a 6-byte single frame — so the
// flow control genuinely went out, and the double records it.
// `sentFrames` is hex text, and a flow control is `A8 30 …` — the tester address then
// the 0x30 PCI. Matched as text rather than parsed, the way the double records it.
const flowControls = bus.sentFrames.filter(frame => /^A8 30/.test(frame));
check(flowControls.length >= 2, `each segmented reply needs a flow control, saw ${flowControls.length}`);
console.log(`  both components reassembled; ${flowControls.length} flow-control frames went out`);

// The store round-trips what the read produced.
const directory = await mkdtemp(join(tmpdir(), "cool-eva-lifetime-read-"));
const stored = await writeLifetimeRead(directory, { readAt: Date.now(), source: "service", replies: result.replies });
check(stored.stored, `a two-component reading should be stored, got ${stored.reason}`);
const reloaded = await loadLifetimeStatistics(directory);
check(reloaded?.statistics.complete === true, "the stored reading should be complete");
check(reloaded?.source === "service", "…and should say it came from the service");
check(
  reloaded?.statistics.rows.find(row => row.key === "odometer_km")?.value === 18440.5,
  "the odometer should survive the whole path"
);
await rm(directory, { recursive: true, force: true });

// ── §2 The retry, which exists because 0x17 is idempotent and 0x36 is not ───
console.log("\n── §2 the retry ──────────────────────────────────────────────────");

// The double answers nothing for `0x17`, so every attempt times out. What is asserted
// is that the read still RESOLVES, with both components reported as failures carrying
// their status — never a throw into the caller, and never a silent empty reading.
const silent = simulateVcuMicros([{ target: "A8", records: new Map(), silentServices: [0x17] }]);
const silentRead = startLifetimeRead({ channel: silent.channel, attempts: 2 });
silent.channel.addListener("onMessage", message => silentRead.handleFrame(message.id, message.data));
const silentResult = await silentRead.finished;
check(silentResult.replies.length === 2, "a silent micro still produces one reply record per component");
check(
  silentResult.replies.every(reply => reply.payloadHex === null && reply.failure !== null),
  `every reply should carry a failure, got ${JSON.stringify(silentResult.replies)}`
);
check(silentResult.flowControl === null, "no flow control can have been measured when nothing answered");
// ⚠️ COUNT THE REQUESTS, because "it resolved with failures" is equally true of a read
// that never retried — the first version of this section passed with the retry deleted.
// `A8 03 17 …` is the 0x17 request: two components × two attempts.
const asked = silent.sentFrames.filter(frame => /^A8 03 17/.test(frame));
check(asked.length === 4, `two components at two attempts each should ask four times, got ${asked.length}`);
// And the happy path must NOT retry — a component that answered is not asked twice.
const askedOnce = bus.sentFrames.filter(frame => /^A8 03 17/.test(frame));
check(askedOnce.length === 2, `a reply first time should be asked once per component, got ${askedOnce.length}`);
console.log(
  `  a silent micro gives ${silentResult.replies.map(reply => reply.failure).join(", ")} after ${asked.length}` +
    ` requests; the answering one is asked ${askedOnce.length} times`
);

// ── §3 The arrival arithmetic, and its two refusals ────────────────────────
console.log("\n── §3 arrival latency ────────────────────────────────────────────");

check(frameArrival({}) === null, "a frame with no kernel stamp has no arrival");
check(frameArrival({ ts_sec: 0, ts_usec: 0 }) === null, "a ZERO stamp is absent, not 1970 — that is the trap");
const at = { ts_sec: 1_757_000_000, ts_usec: 500_000 };
const latency = arrivalLatencyMs(frameArrival(at), 1_757_000_000_500 + 7);
check(latency.known && Math.abs(latency.ms - 7) < 1e-6, `7 ms should measure as 7, got ${JSON.stringify(latency)}`);
// ⚠️ The two a stepped CLOCK_REALTIME produces. Both refuse rather than answer.
const backwards = arrivalLatencyMs(frameArrival(at), 1_757_000_000_500 - 1000);
check(!backwards.known && backwards.reason.includes("stepped"), "a frame arriving in the future must be refused");
const forwards = arrivalLatencyMs(frameArrival(at), 1_757_000_000_500 + 600_000);
check(!forwards.known && forwards.reason.includes("stepped"), "a ten-minute gap is a clock step, not a dispatch delay");
check(
  !arrivalLatencyMs(null, Date.now()).known,
  "no stamp must read as unmeasured — never as 0.0 ms, which is what success looks like"
);
console.log("  7 ms reads as 7; a backwards step, a forwards step and an absent stamp are each refused by name");

// ── §4 The measurement's plumbing — and ONLY its plumbing ──────────────────
console.log("\n── §4 the measurement, plumbing only ─────────────────────────────");

// ⚠️ READ THIS BEFORE BELIEVING THE NUMBER BELOW. The double emits frames with no
// `ts_sec`, so `frameArrival` returns null and the latency is correctly "unmeasured".
// That is the assertion worth making here: the path carries the refusal rather than a
// zero. The real number needs a kernel stamp on a real socket, which needs the bike.
check(
  result.flowControl !== null,
  "a segmented reply must produce a flow-control latency record, even an unmeasured one"
);
check(
  result.flowControl !== null && !result.flowControl.known,
  `the double supplies no kernel stamp, so this must read as unmeasured, got ${JSON.stringify(result.flowControl)}`
);
check(typeof result.loopDelayMs === "number", "the event-loop delay is always available — it needs no stamp");
console.log(
  `  latency correctly unmeasured against the double; event-loop delay ${result.loopDelayMs?.toFixed(2)} ms` +
    " (an idle laptop, and worth nothing as evidence about the Pi)"
);

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ both components read, reassembled and stored through the real client and reassembler against a simulated" +
    " A8; a silent micro produces failures rather than a throw; and the arrival arithmetic refuses an absent stamp" +
    " and a stepped clock by name rather than reporting them as 0.0 ms"
);
