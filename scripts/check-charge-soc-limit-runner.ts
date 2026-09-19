import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawChannel } from "socketcan";
import { record, recordArrival } from "../src/can/signals.ts";
import { monotonicNow } from "../src/monotonic.ts";
import { performChargeSocLimit, performChargeSocLimitRead } from "../src/vcu/charge-soc-limit.ts";
import { MAX_SOC_LIMIT_PCT } from "../src/can/charge-soc-command.ts";
import { MAX_PCT } from "../public/views/charge-soc-limit.js";

// The SOC charge-limit ACTIONS, on a laptop, against a stand-in bike — the half
// scripts/check-charge-soc-limit.ts cannot reach, because it tests pure functions and this is the
// round trip: a frame out, a reply that may or may not come, and the sentence a rider then reads.
//
//   node --experimental-strip-types scripts/check-charge-soc-limit-runner.ts
//
// ⚠️ §2 IS THE POINT OF THIS FILE. The read-back's monotonic mark is taken immediately before the
// READ transmit, never before the write — because the bike answers the WRITE with a 0x121 of its
// own a few ms later, and a mark taken earlier is satisfied by that answer. That is a read-back
// that cannot fail, which is this repo's named failure mode, and nothing asserted it until now.
// The mutation is stated in the section so the next person can run it: move the mark and §2 goes red.

const failures: string[] = [];

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures.push(what);
  }
}

/** Whether the stand-in bike answers a given request, and with what. */
interface BikeScript {
  /** Answer the read requests (b0 = 0x2C) in order; null means "say nothing". */
  readAnswers: (number | null)[];
  /** What the bike echoes back when it sees the WRITE (b0 = 0xAC); null means no echo. */
  writeEcho: number | null;
}

const directory = await mkdtemp(join(tmpdir(), "cool-eva-soc-limit-"));

try {
  await runSections();
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} charge-soc-limit-runner failure(s)`);
  process.exit(1);
}
console.log(
  "\n✓ the read-back accepts only a reply that arrived AFTER its own request — the bike's answer to the " +
    "write does not satisfy it — a matching reply reads `written`, a different one `read-back-mismatch`, " +
    "no reply at all `unverified` rather than a false claim that nothing changed, both actions refuse a " +
    "bike that is not awake without transmitting, and the dashboard's percentage ceiling equals the Pi's"
);

async function runSections(): Promise<void> {
  console.log("\n1. a bike that is not awake");
  staleEverything();
  const asleep = makeChannel({ readAnswers: [], writeEcho: null });
  const refusedWrite = await performChargeSocLimit({ directory }, { percent: 90 }, asleep.channel);
  const refusedRead = await performChargeSocLimitRead({ directory }, asleep.channel);
  check("a write is refused when nothing has arrived on the awake signal", !refusedWrite.ok);
  check("…and a read too", !refusedRead.ok);
  check("…and NOTHING was transmitted for either", asleep.sent.length === 0);

  console.log("\n2. ⚠️  the mark: the bike's answer to the WRITE must not satisfy the READ-back");
  staleEverything();
  wakeBike();
  // The bike answers the write with a 0x121 carrying the value we asked for — the 2026-09-09
  // behaviour — and then never answers the read that follows. If the mark were taken before the
  // write, that echo would be read as the read-back and this would come back `written`.
  const raced = makeChannel({ readAnswers: [80, null], writeEcho: 90 });
  const racedResult = await performChargeSocLimit({ directory }, { percent: 90 }, raced.channel);
  const racedStatus = raced.channel && racedResult.ok ? racedResult.result.status : "(refused)";
  check(
    `the write whose only 0x121 was the bike's own echo reads "unverified", not "written" — got "${racedStatus}"`,
    racedResult.ok && racedResult.result.status === "unverified"
  );
  check("…and it is NOT reported as succeeded", racedResult.ok && racedResult.result.succeeded === false);
  check(
    "…and its message does not claim nothing was changed",
    racedResult.ok && !racedResult.result.message.includes("Nothing was changed")
  );

  console.log("\n3. a reply that really does arrive after the read");
  staleEverything();
  wakeBike();
  const good = makeChannel({ readAnswers: [80, 90], writeEcho: null });
  const goodResult = await performChargeSocLimit({ directory }, { percent: 90 }, good.channel);
  check('a matching read-back reads "written"', goodResult.ok && goodResult.result.status === "written");
  check("…and succeeded", goodResult.ok && goodResult.result.succeeded === true);
  check("…and it sent exactly three frames: read, write, read", good.sent.length === 3);
  check(
    "…the middle one being the write, bit 7 SET",
    good.sent.length === 3 && good.sent[1][0] === 0xac && good.sent[0][0] === 0x2c && good.sent[2][0] === 0x2c
  );

  console.log("\n4. a reply that disagrees");
  staleEverything();
  wakeBike();
  const wrong = makeChannel({ readAnswers: [80, 85], writeEcho: null });
  const wrongResult = await performChargeSocLimit({ directory }, { percent: 90 }, wrong.channel);
  check(
    'a read-back of a different value reads "read-back-mismatch"',
    wrongResult.ok && wrongResult.result.status === "read-back-mismatch"
  );
  check("…and does not claim success", wrongResult.ok && wrongResult.result.succeeded === false);

  console.log("\n5. the read action on its own");
  staleEverything();
  wakeBike();
  const reader = makeChannel({ readAnswers: [90], writeEcho: null });
  const readResult = await performChargeSocLimitRead({ directory }, reader.channel);
  check("a read returns the stored value", readResult.ok && readResult.result.message.includes("90 %"));
  check("…having sent ONE frame, bit 7 CLEAR", reader.sent.length === 1 && reader.sent[0][0] === 0x2c);
  staleEverything();
  wakeBike();
  const silent = makeChannel({ readAnswers: [null], writeEcho: null });
  const silentResult = await performChargeSocLimitRead({ directory }, silent.channel);
  check("a read nobody answers is refused rather than reported as a value", !silentResult.ok);

  console.log("\n6. the dashboard and the Pi agree on the ceiling");
  // public/ has no build step and cannot import a .ts module, so the browser keeps its own copy of
  // the maximum. This is the line that makes that copy true rather than hopeful.
  check(`MAX_PCT (${MAX_PCT}) === MAX_SOC_LIMIT_PCT (${MAX_SOC_LIMIT_PCT})`, MAX_PCT === MAX_SOC_LIMIT_PCT);
}

/** The awake evidence the actions gate on — 0x625 b2, broadcast whenever the bike is awake. */
function wakeBike(): void {
  record("fast_dc_limit_max_a", 80);
}

/**
 * Ages both signals out, so every section starts from the same bike regardless of the order they
 * run in. ⚠️ `recordArrival` with a mark in the past rather than a `resetSignals()` added to
 * production for a check's convenience — it is the documented bypass, and sleeping instead would
 * make this file's verdict a measured ratio that load inflates (src/can/signals.ts).
 */
function staleEverything(): void {
  const longAgo = monotonicNow() - 60_000;
  recordArrival("fast_dc_limit_max_a", 80, Date.now(), longAgo);
  recordArrival("charge_soc_limit_pct", 0, Date.now(), longAgo);
}

/**
 * A stand-in RawChannel that answers like the bike: a read gets the next scripted reply (recorded
 * as an ARRIVAL, the way the real RX path does), a write optionally gets the bike's own echo.
 *
 * ⚠️ The answer is recorded synchronously inside `send`, which is EARLIER than the real bus could
 * manage. That is the hostile direction for §2: it gives the write's echo the best possible chance
 * of being mistaken for the read-back, so a mark in the wrong place fails here with certainty
 * rather than only under load.
 */
function makeChannel(script: BikeScript): { channel: RawChannel; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  let readsSeen = 0;
  const channel = {
    send(frame: { id: number; data: Buffer }) {
      sent.push(Uint8Array.from(frame.data));
      const isWrite = (frame.data[0] & 0x80) !== 0;
      if (isWrite) {
        if (script.writeEcho !== null) {
          answer(script.writeEcho);
        }
        return;
      }
      const reply = script.readAnswers[readsSeen] ?? null;
      readsSeen += 1;
      if (reply !== null) {
        answer(reply);
      }
    },
  } as unknown as RawChannel;
  return { channel, sent };
}

/** Land a reply on the signal the way the decoder would, with an arrival mark of now. */
function answer(percent: number): void {
  recordArrival("charge_soc_limit_pct", percent, Date.now(), monotonicNow());
}
