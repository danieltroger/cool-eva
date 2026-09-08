import { holdObdPoller, obdPollerHeldBy, startObdPoller } from "../src/can/obd.ts";
import { troubleCodeTransferInFlight } from "../src/can/obd-dtc.ts";
import { monotonicNow, since } from "../src/monotonic.ts";

// The OBD poller's hold — the thing an in-service multi-frame read needs, and the
// riskiest new mechanism in that feature. Run by `npm test` via scripts/run-checks.ts.
//
//   node --experimental-strip-types scripts/check-obd-poller-hold.ts
//
// ⚠️ THE REAL LOOP, WITH NO CHANNEL, AND SO NO SOCKET. `initObd` is never called, so
// `requestPid` short-circuits and `readTroubleCodeLists` returns before it can send —
// the loop runs its rounds and reaches its park points and puts nothing on any bus.
// That is what makes the hold testable at all: it is pure control flow over a loop.
//
// ⚠️ WHY THIS EXISTS AT ALL. A leaked hold takes speed, rpm, the temperatures, the 12 V
// rail and the whole stored-DTC list off the dashboard AND out of the log, with a
// healthy-looking journal, on a bike parked where there is no reception —
// src/can/obd.ts says so itself. It was shipped with no automated coverage, and two
// functions were exported with docstrings promising a check that did not exist.

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const stopPoller = startObdPoller(50);

// ── §1 It acknowledges rather than announces ────────────────────────────────
console.log("── §1 the hold is granted only once the loop has parked ───────────");

check(obdPollerHeldBy() === null, "nothing holds the poller before anyone asks");
const first = await holdObdPoller("a lifetime-statistics read");
check(first !== null, "a hold should be granted against a running loop");
check(obdPollerHeldBy() === "a lifetime-statistics read", `the holder is named, got ${obdPollerHeldBy()}`);
// ⚠️ The implication the whole design rests on: parked means nothing of ours is in
// flight. Asserted directly rather than trusted, which is what obd-dtc.ts's exported
// query was added for.
check(!troubleCodeTransferInFlight(), "a parked loop must have no trouble-code transfer in flight");
console.log("  granted, named, and nothing in flight at the park point");

// ── §2 One at a time, and releasing is idempotent ───────────────────────────
console.log("\n── §2 a second holder is refused ─────────────────────────────────");

const second = await holdObdPoller("a second read", { waitMs: 200 });
check(second === null, "a second hold must be refused while the first stands");
check(obdPollerHeldBy() === "a lifetime-statistics read", "…and must not steal the name");
first?.release();
check(obdPollerHeldBy() === null, "releasing frees it");
first?.release();
check(obdPollerHeldBy() === null, "releasing twice is safe — a `finally` on a retried path does exactly that");
// ⚠️ AND A LATE RELEASE MUST NOT FREE SOMEBODY ELSE'S HOLD. A promise that settles
// after its own `finally` has run does exactly this, and it is the hazard
// src/vcu/bus-lease.ts's identity check exists for — the same shape, one layer down.
const superseded = await holdObdPoller("a read that will be superseded");
superseded?.release();
const successor = await holdObdPoller("the read that came after");
check(obdPollerHeldBy() === "the read that came after", "the successor holds it");
superseded?.release();
check(
  obdPollerHeldBy() === "the read that came after",
  `a late release from a finished holder must not free the successor's hold, got ${obdPollerHeldBy()}`
);
successor?.release();
check(obdPollerHeldBy() === null, "and the successor's own release still works");
console.log("  second holder refused, release idempotent, a late release frees nobody else");

// ── §3 The cap is enforced by the loop, not by the holder ───────────────────
console.log("\n── §3 a leaked hold is taken back ────────────────────────────────");

// ⚠️ THE FAILURE THAT MATTERS. A caller that never releases must not park the poller
// forever, and the cap has to belong to the loop: a caller-enforced timeout is the
// flag-versus-acknowledgement mistake pointed the other way.
// A 600 ms cap rather than the real 15 s: this asserts that the LOOP takes it back,
// which is the property, not how long it waits first.
const leaked = await holdObdPoller("a read that never releases", { maxHoldMs: 600 });
check(leaked !== null, "the leaked hold is granted");
check(obdPollerHeldBy() !== null, "…and is held");
console.log("  waiting out an injected 600 ms cap with the hold deliberately never released…");
const reclaimedBy = await waitForRelease(5000);
check(reclaimedBy !== null, "the loop must take the poller back on its own past the cap");
check(obdPollerHeldBy() === null, "…and clear the holder");
// And the poller is usable again afterwards, rather than wedged.
const afterwards = await holdObdPoller("a read after the leak");
check(afterwards !== null, "a fresh hold must be granted after a leaked one was reclaimed");
afterwards?.release();
console.log(`  reclaimed after ${reclaimedBy} ms, and a fresh hold works afterwards`);

stopPoller();

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ the hold is granted only once the loop has parked and nothing of ours is in flight, a second holder is" +
    " refused by name, release is idempotent, and a hold nobody releases is taken back BY THE LOOP and leaves the" +
    " poller usable"
);

/** How long until the loop takes the poller back, or null if it never does. */
async function waitForRelease(limitMs: number): Promise<number | null> {
  // monotonicNow, not Date.now: the rule exists so nobody has to work out per site that
  // this particular clock will not step.
  const startedAt = monotonicNow();
  while (since(startedAt) < limitMs) {
    if (obdPollerHeldBy() === null) {
      return Math.round(since(startedAt));
    }
    await sleep(100);
  }
  return null;
}
