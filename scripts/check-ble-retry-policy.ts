import { readFile } from "fs/promises";
import {
  ADAPTER_BUSY_MESSAGE,
  ADAPTER_RESET_AFTER_BUSY_FAILURES,
  ADAPTER_RESET_MIN_INTERVAL_MS,
  BleRetryPolicy,
  ESCALATE_AFTER_RESETS,
  LOG_REPEAT_INTERVAL_MS,
  MAX_RECONNECT_DELAY_MS,
  RECONNECT_DELAY_MS,
  describeKnownHub,
} from "../src/ble/recovery.ts";

// What the service does while the Pi's Bluetooth adapter is wedged (#299). On a laptop,
// against a synthetic clock, with no D-Bus and no bike.
//
//   node --experimental-strip-types scripts/check-ble-retry-policy.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ WHAT THIS EXISTS TO CATCH. On 2026-09-15..19 the journal carried 20 632
// `Operation already in progress` lines — 14.9 % of every line it held — in 14 episodes,
// NOT ONE of which recovered before its boot ended. Three behaviours answer that, and each
// has a way of failing silently: a rate limiter that drops the count instead of carrying it,
// a reset cooldown that outlives the wedge it is meant to space out, and a reset gate that
// fires on failures a power-cycle cannot fix. §7 is the one the plan's reviewer required: the journal probe must never throw,
// because its error would replace the busy reply and disarm the gate keyed on it.

const failures: string[] = [];
const NOT_BUSY = "le-connection-abort-by-local";

/** The longest wedge in the archive: boot 2026-09-17T18:42:47, 18:53:36 → 09-18T06:36:02. */
const LONGEST_EPISODE_MS = 42_146_000;

interface Printed {
  atMs: number;
  line: string;
}

/** Drive a wedge for `durationMs`, stepping the clock by whatever delay the policy asks for. */
function driveWedge(
  durationMs: number,
  message: string
): { printed: Printed[]; tail: Printed[]; failureCount: number } {
  const policy = new BleRetryPolicy();
  const printed: Printed[] = [];
  let nowMs = 0;
  let failureCount = 0;
  while (nowMs <= durationMs) {
    const plan = policy.onFailure(message, nowMs);
    failureCount += 1;
    for (const line of plan.logLines) {
      printed.push({ atMs: nowMs, line });
    }
    nowMs += plan.delayMs;
  }
  const tail = policy.flush(nowMs).map(line => ({ atMs: nowMs, line }));
  return { printed, tail, failureCount };
}

/** Failures at a fixed spacing, for the case where the window always elapses. */
function driveWedgeAtFixedSpacing(spacingMs: number, count: number): { printed: Printed[] } {
  const policy = new BleRetryPolicy();
  const printed: Printed[] = [];
  for (let i = 0; i < count; i += 1) {
    for (const line of policy.onFailure(ADAPTER_BUSY_MESSAGE, i * spacingMs).logLines) {
      if (line.includes("session failed")) {
        printed.push({ atMs: i * spacingMs, line });
      }
    }
  }
  return { printed };
}

/** Every `×N more` the policy printed, so suppressed failures can be conserved. */
function countedInLines(printed: Printed[]): number {
  let total = 0;
  for (const { line } of printed) {
    const match = line.match(/×(\d+) more/);
    if (match) {
      total += Number(match[1]);
    }
  }
  return total;
}

// --- §1 the backoff sequence -------------------------------------------------------
const expectedDelays = [5_000, 10_000, 20_000, 30_000, 30_000];
const policy1 = new BleRetryPolicy();
const actualDelays = expectedDelays.map(() => policy1.onFailure(ADAPTER_BUSY_MESSAGE, 0).delayMs);
if (JSON.stringify(actualDelays) !== JSON.stringify(expectedDelays)) {
  failures.push(`§1 backoff should be ${expectedDelays.join(", ")}, got ${actualDelays.join(", ")}`);
}
if (MAX_RECONNECT_DELAY_MS <= RECONNECT_DELAY_MS) {
  failures.push("§1 MAX_RECONNECT_DELAY_MS must exceed RECONNECT_DELAY_MS or there is no backoff at all");
}
// ⚠️ Pinned as literals for the same reason as the threshold in §5: every assertion below
// that scales with one of these is true for ANY value of it. A diff reviewer's mutants
// widened the log window to 5 min and the cooldown to an hour, and both survived a version
// of this file that only ever compared the policy against its own constants.
const PINNED: [string, number, number][] = [
  ["RECONNECT_DELAY_MS", RECONNECT_DELAY_MS, 5_000],
  ["MAX_RECONNECT_DELAY_MS", MAX_RECONNECT_DELAY_MS, 30_000],
  ["LOG_REPEAT_INTERVAL_MS", LOG_REPEAT_INTERVAL_MS, 60_000],
  ["ADAPTER_RESET_MIN_INTERVAL_MS", ADAPTER_RESET_MIN_INTERVAL_MS, 600_000],
  ["ESCALATE_AFTER_RESETS", ESCALATE_AFTER_RESETS, 3],
];
for (const [name, actual, expected] of PINNED) {
  if (actual !== expected) {
    failures.push(`§1 ${name} is ${actual}, not ${expected} — docs/ble-adapter-wedge.md argues each of these`);
  }
}

// --- §2 a small, hand-checkable rate-limit case ------------------------------------
// Ten failures pinned to one instant: the window never elapses, so exactly one line is
// printed and the other nine survive as a count in the flush. Hand-computed, not observed.
const policy2 = new BleRetryPolicy();
const printed2: string[] = [];
for (let i = 0; i < 10; i += 1) {
  printed2.push(...policy2.onFailure(ADAPTER_BUSY_MESSAGE, 0).logLines.filter(line => line.includes("session failed")));
}
printed2.push(...policy2.flush(0));
if (printed2.length !== 2) {
  failures.push(`§2 ten failures inside one window should print 2 lines (first + flush), got ${printed2.length}`);
}
if (!printed2.at(-1)?.includes("×9 more")) {
  failures.push(`§2 the flush should carry the nine suppressed failures, got ${printed2.at(-1)}`);
}

// --- §3 the long episode: bounded volume, and nothing lost -------------------------
const long = driveWedge(LONGEST_EPISODE_MS, ADAPTER_BUSY_MESSAGE);
const messageLines = long.printed.filter(entry => entry.line.includes("session failed"));
const accountedFor = messageLines.length + countedInLines(long.printed) + countedInLines(long.tail);
if (accountedFor !== long.failureCount) {
  failures.push(
    `§3 conservation: ${long.failureCount} failures, ${accountedFor} accounted for ` +
      `(${messageLines.length} printed + ${countedInLines(long.printed)} counted + ` +
      `${countedInLines(long.tail)} in the stop flush) — the difference was swallowed`
  );
}
// A window that elapses with nothing suppressed must still print: a session slower to
// fail than the window is wide would otherwise report nothing at all, silently.
const slow = driveWedgeAtFixedSpacing(LOG_REPEAT_INTERVAL_MS * 2, 5);
if (slow.printed.length !== 5) {
  failures.push(`§3 five failures spaced wider than the window should print 5 lines, got ${slow.printed.length}`);
}
// Independent of the implementation: a rate limiter promising one line per window cannot
// print more than one per window, plus the first.
const windows = Math.ceil(LONGEST_EPISODE_MS / LOG_REPEAT_INTERVAL_MS) + 1;
if (messageLines.length > windows) {
  failures.push(`§3 ${messageLines.length} lines over ${windows} windows — the rate limit is not holding`);
}
if (messageLines.length < 2) {
  failures.push(
    `§3 only ${messageLines.length} line(s) over 11 h 42 min — the failure has gone quiet, not rate-limited`
  );
}
for (let i = 1; i < messageLines.length; i += 1) {
  const gap = messageLines[i].atMs - messageLines[i - 1].atMs;
  if (gap < LOG_REPEAT_INTERVAL_MS) {
    failures.push(`§3 two lines ${gap} ms apart, closer than the ${LOG_REPEAT_INTERVAL_MS} ms window`);
    break;
  }
}

// --- §4 a changed message is never held back --------------------------------------
const policy4 = new BleRetryPolicy();
policy4.onFailure(ADAPTER_BUSY_MESSAGE, 0);
policy4.onFailure(ADAPTER_BUSY_MESSAGE, 1_000);
const switched = policy4.onFailure(NOT_BUSY, 2_000);
if (!switched.logLines.some(line => line.includes(NOT_BUSY))) {
  failures.push("§4 a different failure must print immediately, not wait for the window");
}
if (!switched.logLines.some(line => line.includes("×1 more"))) {
  failures.push("§4 switching message must flush the previous count first");
}

// --- §5 the reset gate: when it fires, and when it must not -----------------------
// ⚠️ The literal 3 is the point. Looping to ADAPTER_RESET_AFTER_BUSY_FAILURES and
// asserting the reset lands on it is true for EVERY value of that constant — an
// assertion that cannot fail, and both mutants (999 and 1) survived a version of §5
// that did exactly that. Changing the threshold must edit this number too; the
// argument for 3 is in docs/ble-adapter-wedge.md — no episode has ever self-recovered.
if (ADAPTER_RESET_AFTER_BUSY_FAILURES !== 3) {
  failures.push(`§5 the reset threshold is 3 busy replies, found ${ADAPTER_RESET_AFTER_BUSY_FAILURES}`);
}
const policy5 = new BleRetryPolicy();
const resetAt: number[] = [];
for (let i = 0; i < 8; i += 1) {
  if (policy5.onFailure(ADAPTER_BUSY_MESSAGE, i * 1_000).resetAdapter) {
    resetAt.push(i + 1);
  }
}
if (JSON.stringify(resetAt) !== JSON.stringify([3])) {
  failures.push(`§5 over eight busy replies the reset should fire once, on the 3rd; fired on ${resetAt}`);
}
const policy5b = new BleRetryPolicy();
for (let i = 0; i < 20; i += 1) {
  if (policy5b.onFailure(NOT_BUSY, i * 1_000).resetAdapter) {
    failures.push(`§5 a power-cycle cannot fix ${NOT_BUSY} and must never be triggered by it (failure ${i + 1})`);
    break;
  }
}

// --- §6 the cooldown applies to failed remedies, and a connect clears it ----------
const policy6 = new BleRetryPolicy();
let sixthResets = 0;
for (let step = 0; step < 6; step += 1) {
  for (let i = 0; i < 3; i += 1) {
    if (policy6.onFailure(ADAPTER_BUSY_MESSAGE, step * 60_000 + i).resetAdapter) {
      sixthResets += 1;
    }
  }
}
if (sixthResets !== 1) {
  failures.push(`§6 six minutes of unrelieved wedge should bounce once, not ${sixthResets} times`);
}
const policy6b = new BleRetryPolicy();
let clearedResets = 0;
for (let step = 0; step < 6; step += 1) {
  for (let i = 0; i < 3; i += 1) {
    if (policy6b.onFailure(ADAPTER_BUSY_MESSAGE, step * 60_000 + i).resetAdapter) {
      clearedResets += 1;
    }
  }
  policy6b.onSessionConnected(step * 60_000 + 500);
}
if (clearedResets !== 6) {
  failures.push(
    `§6 a connect after each bounce proves the remedy worked, so the next wedge is a fresh ` +
      `event: expected 6 bounces, got ${clearedResets} — the cooldown is outliving its purpose`
  );
}
if (ADAPTER_RESET_MIN_INTERVAL_MS <= LOG_REPEAT_INTERVAL_MS) {
  failures.push("§6 the cooldown must outlast the log window or a failed remedy is retried every minute");
}
// After a bounce the busy run starts again from zero, so the SECOND bounce needs three
// fresh busy replies and not just one once the cooldown expires. Without this, dropping
// `consecutiveBusyFailures = 0` from the reset block changed nothing any assertion saw.
const policy6c = new BleRetryPolicy();
const bounceAt: number[] = [];
const schedule = [
  0,
  1,
  2,
  ADAPTER_RESET_MIN_INTERVAL_MS + 1,
  ADAPTER_RESET_MIN_INTERVAL_MS + 2,
  ADAPTER_RESET_MIN_INTERVAL_MS + 3,
];
for (const [index, at] of schedule.entries()) {
  if (policy6c.onFailure(ADAPTER_BUSY_MESSAGE, at).resetAdapter) {
    bounceAt.push(index + 1);
  }
}
if (JSON.stringify(bounceAt) !== JSON.stringify([3, 6])) {
  failures.push(
    `§6 the second bounce needs three fresh busy replies after the cooldown, not one: ` +
      `expected bounces on busy replies 3 and 6, got ${JSON.stringify(bounceAt)}`
  );
}

// --- §7 the journal probe must never throw, and never disarm the gate -------------
const thrower = async (): Promise<never> => {
  throw new Error("org.bluez disappeared mid-probe");
};
const probeResults = [
  await describeKnownHub(thrower, async () => "Energica BT", /energica/i),
  await describeKnownHub(async () => ["AA:BB"], thrower, /energica/i),
  await describeKnownHub(
    async () => ["AA:BB"],
    async () => "Energica BT",
    /energica/i
  ),
  await describeKnownHub(
    async () => [],
    async () => "",
    /energica/i
  ),
];
for (const [index, result] of probeResults.entries()) {
  if (typeof result !== "string" || result.length === 0) {
    failures.push(`§7 probe case ${index} returned ${JSON.stringify(result)} instead of a description`);
  }
}
if (!probeResults[2].includes("still holds")) {
  failures.push(`§7 a name-matching device must be reported as held, got ${probeResults[2]}`);
}
if (probeResults[3].includes("still holds")) {
  failures.push(`§7 an empty device list must not report the hub as held, got ${probeResults[3]}`);
}
// The gate is keyed on the busy message, so a throwing probe must leave it armed.
const policy7 = new BleRetryPolicy();
let armedAfterProbeFailure = false;
for (let i = 0; i < 3; i += 1) {
  const note = await describeKnownHub(thrower, thrower, /energica/i);
  armedAfterProbeFailure = policy7.onFailure(ADAPTER_BUSY_MESSAGE, i * 1_000, note).resetAdapter;
}
if (!armedAfterProbeFailure) {
  failures.push("§7 a probe that threw must still leave the reset armed on the third consecutive busy reply");
}

// --- §8 stop() does not drop the final partial window -----------------------------
const policy8 = new BleRetryPolicy();
policy8.onFailure(ADAPTER_BUSY_MESSAGE, 0);
policy8.onFailure(ADAPTER_BUSY_MESSAGE, 1_000);
policy8.onFailure(ADAPTER_BUSY_MESSAGE, 2_000);
if (policy8.flush(3_000).length !== 1) {
  failures.push("§8 stop() must emit the counted-but-unprinted tail — 13 of 14 episodes ended at a reboot");
}

// --- §10 the escalation, and the flush on connect ----------------------------------
// Three bounces that bought nothing must stop reading as routine, and a connect must not
// swallow the tail of the window it ends. Mutants that made ESCALATE_AFTER_RESETS
// unreachable and that removed the flush from onSessionConnected both survived without this.
const policy10 = new BleRetryPolicy();
const escalations: string[] = [];
for (let round = 0; round < 4; round += 1) {
  for (let i = 0; i < 3; i += 1) {
    const at = round * (ADAPTER_RESET_MIN_INTERVAL_MS + 1_000) + i;
    for (const line of policy10.onFailure(ADAPTER_BUSY_MESSAGE, at).logLines) {
      if (line.includes("Only a reboot")) {
        escalations.push(line);
      }
    }
  }
}
if (escalations.length !== 4 - ESCALATE_AFTER_RESETS + 1) {
  failures.push(
    `§10 four unrelieved bounces should escalate on the 3rd and 4th, got ${escalations.length} escalation line(s)`
  );
}
const policy10b = new BleRetryPolicy();
policy10b.onFailure(ADAPTER_BUSY_MESSAGE, 0);
policy10b.onFailure(ADAPTER_BUSY_MESSAGE, 1_000);
const onConnect = policy10b.onSessionConnected(2_000);
if (!onConnect.some(line => line.includes("more in the last"))) {
  failures.push(`§10 a connect must flush the window it ends, got ${JSON.stringify(onConnect)}`);
}

// --- §9 the caller passes the MONOTONIC clock -------------------------------------
// ⚠️ Not visible to anything above: the policy takes nowMs, so a synthetic clock passes
// either way. This Pi steps its wall clock from GPS (src/monotonic.ts), and a backwards
// step against a cooldown deadline is d3a9c05 all over again. Whitespace is collapsed so a
// Prettier rewrap cannot turn this red.
const clientSource = await readFile(new URL("../src/ble/client.ts", import.meta.url), "utf8");
const collapsedClient = clientSource.replace(/\s+/g, " ");
const WIRING = [
  {
    needle: "retryPolicy.onFailure((error as Error).message, monotonicNow(), hubObjectNote)",
    why: "the backoff and the cooldown are durations",
  },
  {
    needle: "logAll(plan.logLines)",
    why: "without it every line this whole feature computes is discarded, silently, with the suite green",
  },
  {
    needle: "retryPolicy.onSessionConnected(monotonicNow())",
    why: "a connect clears the cooldown, and must stamp it monotonically",
  },
  { needle: "logAll(retryPolicy.flush(monotonicNow()))", why: "stop()'s flush prints an elapsed time" },
  {
    needle: "if (plan.resetAdapter) { await resetBluetoothAdapter(); }",
    why: "the decision would be computed and discarded",
  },
];
for (const { needle, why } of WIRING) {
  if (!collapsedClient.includes(needle)) {
    failures.push(`§9 src/ble/client.ts no longer contains \`${needle}\` — ${why}`);
  }
}
const wallClock = clientSource.split("\n").filter(line => !line.trim().startsWith("//") && line.includes("Date.now()"));
if (wallClock.length > 0) {
  failures.push(`§9 src/ble/client.ts measures with Date.now(): ${wallClock.map(line => line.trim()).join(" / ")}`);
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `\n✓ backoff, rate limit over the 11 h 42 min episode (${long.failureCount} failures → ` +
    `${messageLines.length} lines, none lost), the busy-only reset gate, the cooldown, ` +
    `the never-throwing journal probe, and the monotonic wiring`
);
