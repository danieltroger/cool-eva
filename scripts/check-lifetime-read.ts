import { simulateVcuMicros } from "./simulated-vcu-micro.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";
import { LIFETIME_READ_PAYLOADS } from "./captured-lifetime-reads.ts";
import { startLifetimeRead, worseOf } from "../src/vcu/lifetime-read.ts";
import { arrivalLatencyMs, frameArrival } from "../src/can/frame-arrival.ts";
import { loadLifetimeStatistics, writeLifetimeRead } from "../src/vcu/lifetime-store.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  // `failure === null`, not `payloadHex !== null`: a refusal carries bytes, so the old
  // predicate called `7F A8 22` an answer — the exact bug this file would have to catch.
  check(reply.failure === null, `component ${reply.component} should have answered, got ${reply.failure}`);
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
silent.channel.addListener("onMessage", message =>
  silentRead.handleFrame(message.id, message.data, frameArrival(message))
);
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

// And `attempts` has to MEAN something: one attempt asks once per component even when
// nothing answers. Without this the option is exported configurability with no behaviour.
const once = simulateVcuMicros([{ target: "A8", records: new Map(), silentServices: [0x17] }]);
const onceRead = startLifetimeRead({ channel: once.channel, attempts: 1 });
once.channel.addListener("onMessage", message => onceRead.handleFrame(message.id, message.data, frameArrival(message)));
await onceRead.finished;
const askedTwice = once.sentFrames.filter(frame => /^A8 03 17/.test(frame));
check(askedTwice.length === 2, `attempts: 1 should ask twice in total, not four times, got ${askedTwice.length}`);
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

// ⚠️ READ THIS BEFORE BELIEVING THE NUMBER BELOW. It is an idle laptop answering in
// 2 ms and it is worth NOTHING as evidence about the Pi. What these assertions hold down
// is the PLUMBING: that the stamp the double puts on a frame reaches the transfer
// through index.ts → read-runner → kwp-client → multiframe-transfer, and that the
// measurement is taken after the transmit rather than before it. Without a stamp on the
// double's frames every one of these passed whether the chain was connected or not.
check(result.flowControl !== null, "a segmented reply must produce a flow-control latency record");
check(
  result.flowControl !== null && result.flowControl.known,
  `the double stamps its frames, so the chain must deliver a real latency, got ${JSON.stringify(result.flowControl)}`
);
// A plausible dispatch delay: not negative, and not the seconds a broken chain or a
// stepped clock would produce.
check(
  result.flowControl?.known === true && result.flowControl.ms >= 0 && result.flowControl.ms < 1000,
  `an idle laptop's dispatch should be well under a second, got ${JSON.stringify(result.flowControl)}`
);
check(result.loopDelayMs === null || result.loopDelayMs >= 0, "the event-loop delay is a duration or nothing");
console.log(
  `  flow control measured ${result.flowControl?.known ? `${result.flowControl.ms.toFixed(2)} ms` : "NOT AT ALL"}` +
    ` after the double's own stamp; event-loop delay ${result.loopDelayMs?.toFixed(2) ?? "not sampled"} ms` +
    " — plumbing only, an idle laptop, no evidence about the Pi"
);

// And the absent-stamp path, which no longer happens by accident: a frame with no
// `ts_sec` must still read as unmeasured rather than as 0.0 ms.
const unstamped = simulateVcuMicros([{ target: "A8", records: new Map(), freezeFrames: FREEZE_FRAMES }]);
const unstampedRead = startLifetimeRead({ channel: unstamped.channel });
// ⚠️ Deliberately NOT passing the arrival: this is the listener that has no stamp to give.
unstamped.channel.addListener("onMessage", message => unstampedRead.handleFrame(message.id, message.data, null));
const unstampedResult = await unstampedRead.finished;
check(
  unstampedResult.flowControl !== null && !unstampedResult.flowControl.known,
  `a frame with no stamp must read as unmeasured, got ${JSON.stringify(unstampedResult.flowControl)}`
);
console.log(
  `  and with no stamp threaded: "${unstampedResult.flowControl?.known ? "?" : unstampedResult.flowControl?.reason}"`
);

// ── §5 The ordering no runtime check can see ───────────────────────────────
console.log("\n── §5 the measurement stays after the transmit ───────────────────");

// ⚠️ ASSERTED AGAINST THE SOURCE, the way scripts/check-arming.ts asserts the shape of
// its firing sites, because no runtime observation distinguishes a Date.now() taken
// microseconds before a transmit from one taken microseconds after — and the rule that
// nothing may sit between a First Frame and its answer is the one this transport is
// built around. Moving the measurement up would pass every other check in this file.
const transfer = await readFile(new URL("../src/vcu/multiframe-transfer.ts", import.meta.url), "utf-8");
const flowControlCase = transfer.slice(transfer.indexOf('case "flow-control-required":'));
const transmitAt = flowControlCase.indexOf("transmit(context, buildFlowControlFrame");
const measureAt = flowControlCase.indexOf("flowControlLatency = arrivalLatencyMs");
check(transmitAt !== -1, "the flow-control case must still transmit");
check(measureAt !== -1, "…and must still measure");
check(
  transmitAt !== -1 && measureAt !== -1 && measureAt > transmitAt,
  "the measurement must come AFTER the transmit — nothing may sit between a First Frame and its answer"
);
console.log("  the Date.now() sits after the flow control is on the wire, not before it");

// ── §6 worseOf, which decides which number survives ────────────────────────
console.log("\n── §6 the worst latency wins ─────────────────────────────────────");

const known = (ms: number) => ({ known: true as const, ms });
const unknown = { known: false as const, reason: "no stamp" };
check(worseOf(known(3), known(9))?.known === true, "two known readings still give a known one");
check((worseOf(known(3), known(9)) as { ms: number }).ms === 9, "…and it is the SLOWER of the two");
check((worseOf(known(9), known(3)) as { ms: number }).ms === 9, "…whichever order they arrive in");
// ⚠️ An unmeasured reading beats a measured one. "We could not measure it" is the answer
// that has to reach the doc, rather than being hidden by the transfer that could.
check(worseOf(known(3), unknown)?.known === false, "an unmeasured reading beats a measured one");
check(worseOf(unknown, known(3))?.known === false, "…in either order");
check(worseOf(null, known(3))?.known === true, "and nothing at all yields to something");
console.log("  the slower reading wins, and an unmeasured one beats both");

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
