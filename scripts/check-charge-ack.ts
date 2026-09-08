import {
  ACK_FIXTURE_COMMANDS,
  ACK_FIXTURE_COMMAND_TIMES_MS,
  ACK_FIXTURE_SAMPLES,
  ACK_SYNTHETIC_CASES,
} from "./charge-ack-fixtures.ts";
import {
  ACK_SETTLE_MS,
  ACK_TIMEOUT_MS,
  CHARGE_ACK_CODE,
  judgeChargeCommand,
  type ChargeAckVerdict,
} from "../src/charge/acknowledge.ts";

// Holds the acknowledgement adjudicator against the session it exists for: 2026-09-07, where three
// commands provably did nothing and two provably worked, on the same saw-toothing bus.
//
//   node --experimental-strip-types scripts/check-charge-ack.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ THE POINT OF THIS CHECK is that a plausible design gets it exactly backwards. A
// first-crossing test — "did the request reach the commanded value inside the window" — scores the
// 47 A and 40 A commands as `took` at 8.664 s and 8.909 s, because the BMS clamp released ~8.7 s
// after each and the request swept down through both values on its way to 20 A. Two true negatives
// reported as successes, which is the direction that lets a broken transmit path look healthy. §1
// asserts the real outcomes; §2 asserts that the naive test really would have failed, so nobody
// simplifies the envelope back out.

const failures: string[] = [];

// ── §1 the real verdicts ───────────────────────────────────────────────────
for (const command of ACK_FIXTURE_COMMANDS) {
  const verdict = judge(command.atMs, command.amps);
  if (verdict.kind !== command.expected) {
    failures.push(
      `§1 ${command.source} command ${command.amps} A at +${(command.atMs / 1000).toFixed(1)} s: got ` +
        `${verdict.kind}, expected ${command.expected} — ${command.why}`
    );
  }
}

// ── §2 the constructed shapes the real day did not produce ─────────────────
//
// ⚠️ Including the regression case for the worst bug this adjudicator has had: a command that did
// nothing, sent while a saw-tooth trough held the request below it, scored `took`. Both of the
// fixture's original "true positives" came from that path — they were the pre-command value echoed
// back, and a dead transmit path produced a byte-identical sample stream.
for (const synthetic of ACK_SYNTHETIC_CASES) {
  const verdict = judgeChargeCommand({
    commandedAmps: synthetic.commandedAmps,
    sentAtMs: 0,
    nowMs: ACK_TIMEOUT_MS,
    samples: synthetic.samples,
    supersededAtMs: synthetic.supersededAtMs,
  });
  if (verdict.kind !== synthetic.expected) {
    failures.push(`§2 "${synthetic.name}": got ${verdict.kind}, expected ${synthetic.expected} — ${synthetic.why}`);
  }
}

// ── §2b the real trace still supplies the negatives, and nothing is a free pass ──
//
// Counted rather than assumed, so trimming the fixture fails the build. Two true negatives from
// real frames is the direction that matters; `took` is proved by §2's constructed shapes and by
// the one unambiguous take the day contains.
const outcomes = ACK_FIXTURE_COMMANDS.map(command => judge(command.atMs, command.amps).kind);
const tookCount = outcomes.filter(kind => kind === "took").length;
const missedCount = outcomes.filter(kind => kind === "not-acknowledged").length;
if (missedCount < 2 || tookCount < 1) {
  failures.push(
    `§2b the real trace must still supply at least two true negatives and one true positive; got ` +
      `${missedCount} not-acknowledged and ${tookCount} took`
  );
}
// ⚠️ No verdict may come from an empty window. That is exactly how the false `took` arose.
for (const command of ACK_FIXTURE_COMMANDS) {
  const verdict = judge(command.atMs, command.amps);
  const after = ACK_FIXTURE_SAMPLES.filter(
    sample => sample.atMs > command.atMs && sample.atMs <= command.atMs + ACK_TIMEOUT_MS
  );
  if (verdict.kind === "took" && after.length === 0) {
    failures.push(
      `§2b ${command.amps} A at +${(command.atMs / 1000).toFixed(1)} s reads took with NO post-command sample — ` +
        `that is the pre-command value being echoed back as a success`
    );
  }
}

// ── §3 the naive first-crossing test would have been wrong ─────────────────
//
// The regression guard for the design itself. If this ever stops failing, the saw-tooth has gone
// out of the fixture and §1 no longer proves the envelope is needed.
const naiveWrong = ACK_FIXTURE_COMMANDS.filter(command => {
  if (command.expected !== "not-acknowledged") {
    return false;
  }
  const window = ACK_FIXTURE_SAMPLES.filter(
    sample => sample.atMs > command.atMs && sample.atMs <= command.atMs + ACK_TIMEOUT_MS
  );
  return window.some(sample => sample.amps <= command.amps + 1);
});
if (naiveWrong.length < 2) {
  failures.push(
    `§3 only ${naiveWrong.length} of the failed commands would fool a first-crossing test — the fixture no ` +
      `longer contains the saw-tooth that makes the envelope necessary, so §1 is proving less than it claims`
  );
}

// ── §4 the settle grace changes nothing ────────────────────────────────────
//
// ACK_SETTLE_MS is a judgement call (10× the observed take-up). If a verdict moved when it did, it
// would be load-bearing and would need measuring rather than choosing.
for (const command of ACK_FIXTURE_COMMANDS) {
  for (const settle of [0, 2 * ACK_SETTLE_MS]) {
    const verdict = judge(command.atMs, command.amps, settle);
    if (verdict.kind !== command.expected) {
      failures.push(
        `§4 ${command.amps} A at +${(command.atMs / 1000).toFixed(1)} s reads ${verdict.kind} with a ${settle} ms ` +
          `settle but ${command.expected} at the shipped ${ACK_SETTLE_MS} ms — the grace is load-bearing`
      );
    }
  }
}

// ── §5 waiting, and no verdict before the window closes ────────────────────
//
// A verdict that resolved early would be adjudicating a partial window, which is how the
// first-crossing test went wrong in the first place.
const binding = ACK_FIXTURE_COMMANDS.find(command => command.expected === "not-acknowledged");
if (!binding) {
  failures.push("§5 no binding command in the fixture to test the open window with");
} else {
  const midway = judge(binding.atMs, binding.amps, ACK_SETTLE_MS, binding.atMs + ACK_TIMEOUT_MS / 2);
  if (midway.kind !== "waiting") {
    failures.push(`§5 halfway through the window a not-acknowledged command already reads ${midway.kind}`);
  }
}

// ── §6 the log codes are distinct and stable ───────────────────────────────
//
// These integers go into the encrypted ride log, so two verdicts sharing one would make a decrypted
// log unreadable after the fact — which is the whole reason the verdict is logged at all.
const codes = Object.values(CHARGE_ACK_CODE);
if (new Set(codes).size !== codes.length) {
  failures.push(`§6 CHARGE_ACK_CODE has duplicate codes: ${JSON.stringify(CHARGE_ACK_CODE)}`);
}

// ── §7 the adjudicator never reads the delivered current ───────────────────
//
// The rail: `pack_a` conflates "the VCU accepted my command" with "the station could deliver it".
// Asserted by source, because a future edit adding it would look reasonable.
const source = await (
  await import("fs/promises")
).readFile(new URL("../src/charge/acknowledge.ts", import.meta.url), "utf-8");
if (/\bpack_a\b/.test(source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))) {
  failures.push("§7 acknowledge.ts references pack_a outside a comment — the verdict must key on the request only");
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-ack failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
const tally = [...new Set(outcomes)].map(kind => `${outcomes.filter(o => o === kind).length} ${kind}`).join(", ");
console.log(
  `✓ all ${ACK_FIXTURE_COMMANDS.length} charge-current commands of 2026-09-07 adjudicate as their known outcomes ` +
    `(${tally}); ` +
    `plus ${ACK_SYNTHETIC_CASES.length} constructed shapes the day did not produce, including the dead command in a ` +
    `saw-tooth trough that an earlier adjudicator scored as took; ` +
    `${naiveWrong.length} of the failures would have fooled a first-crossing test, so the envelope is doing real ` +
    `work; the settle grace changes no verdict at 0 or ${2 * ACK_SETTLE_MS} ms; a binding command still reads ` +
    `waiting halfway through its window; the log codes are distinct; and nothing in the adjudicator reads pack_a`
);

/** Runs the adjudicator over the fixture trace as the runner would, at the end of the window. */
function judge(sentAtMs: number, amps: number, settleMs = ACK_SETTLE_MS, nowMs?: number): ChargeAckVerdict {
  // From every command on the bus, not just the adjudicated ones — see ACK_FIXTURE_COMMAND_TIMES_MS.
  const supersededAtMs = ACK_FIXTURE_COMMAND_TIMES_MS.filter(at => at > sentAtMs).sort((a, b) => a - b)[0] ?? null;
  return judgeChargeCommand({
    commandedAmps: amps,
    sentAtMs,
    nowMs: nowMs ?? sentAtMs + ACK_TIMEOUT_MS,
    samples: ACK_FIXTURE_SAMPLES,
    supersededAtMs,
    settleMs,
  });
}
