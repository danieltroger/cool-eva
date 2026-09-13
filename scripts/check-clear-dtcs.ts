import type { CanMessage, RawChannel, RxFilter } from "socketcan";
import { handleResponse, pollPidNow } from "../src/can/obd.ts";
import { troubleCodeSnapshot } from "../src/diagnostics/stored-codes.ts";
import { createVcuWriteRunner, type ClearDtcsCounts, type VcuWriteRunner } from "../src/vcu/write-runner.ts";
import type { ServiceGateCheckState, ServiceGateVerdict } from "../src/vcu/service-gate.ts";
import { chargerIsAttached, describeClearCounts } from "../public/views/vcu-write.js";
import {
  CAPTURED_MODE_03_FRAMES_2026_08_04,
  CAPTURED_STORED_CODE_COUNT,
  parseHexFrame,
} from "./captured-dtc-transfer.ts";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

//   node --experimental-strip-types scripts/check-clear-dtcs.ts
//
// OBD Mode 04, and the read-back that is the only thing separating "the bike said 44" from
// "the bike erased its fault memory".
//
// ⚠️ WHY THIS FILE EXISTS. On 2026-08-08 and 2026-09-11 this bike answered Mode 04 with a
// positive `44` and erased nothing — the stored count never moved and PID 31 kept counting
// from 19 173 km — and both presses were journalled "Mode 04 accepted". Nothing on the screen
// or in the audit log could have told anyone. On 2026-09-13 the same button worked and swept
// 41 codes. The difference is now measured rather than assumed: the poller is parked, the
// counters are read either side of the frame, and PID 31 returning zero is the verdict.
// docs/clear-dtcs.md has the captures and the numbers.
//
// No bike and no can0: a fake channel answers the frames, dispatched exactly as src/index.ts
// dispatches real ones, so the transport, the ISO-TP reassembly and the runner all run for real.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

const OBD_REQUEST_ID = 0x7df;
const OBD_REPLY_ID = 0x7ef;

/** PID → the two data bytes it answers with, before and after the clear. Absent = silent. */
type PidTable = Map<number, [number, number]>;

interface FakeBusOptions {
  clearReply: "positive" | "refused" | "silent";
  /** Mode-03 frames to replay, or null to answer nothing at all. */
  listFrames: string[] | null;
  before: PidTable;
  after: PidTable;
  /**
   * How long a mode-01 reply takes to arrive. Default 0.
   *
   * ⚠️ Only the PID replies, and only up to 200 ms — obd.ts's own per-PID timeout. The
   * mode-03 frames must NOT be slowed: the transport gives a whole transfer 400 ms, so a
   * per-frame delay there fails the transfer instead of pacing it.
   */
  pidDelayMs?: number;
}

interface FakeBus {
  channel: RawChannel;
  /** Every frame we transmitted, in order, as `<id> <hex>`. */
  sent: string[];
  attach: (runner: VcuWriteRunner) => void;
}

/**
 * A bus that answers the four exchanges a clear performs.
 *
 * Replies are delivered on a macrotask, never synchronously inside `send`: the real bus is
 * never faster than the caller's own `await`, and a synchronous answer would let a client
 * that registers its waiter AFTER sending pass here and hang on the bike.
 */
function fakeBus(options: FakeBusOptions): FakeBus {
  const sent: string[] = [];
  let cleared = false;
  let runner: VcuWriteRunner | null = null;
  let listCursor = 0;

  const deliver = (data: Buffer, delayMs = 0): void => {
    setTimeout(() => {
      // Exactly src/index.ts's order: the in-flight service action gets first refusal, and
      // whatever it does not claim falls through to the always-on OBD side.
      if (runner?.handleCanFrame(OBD_REPLY_ID, data)) {
        return;
      }
      handleResponse(OBD_REPLY_ID, data);
    }, delayMs);
  };

  const channel = {
    send: (message: CanMessage) => {
      const bytes = [...message.data];
      sent.push(`${message.id.toString(16)} ${bytes.map(byte => byte.toString(16).padStart(2, "0")).join(" ")}`);
      if (message.id !== OBD_REQUEST_ID) {
        // A flow control for the multi-frame list. The transport addresses it to the
        // responder, not to 0x7DF, which is why the id test above is not an equality.
        replayConsecutiveFrames();
        return;
      }
      if (bytes[1] === 0x04) {
        answerModeFour();
        return;
      }
      if (bytes[1] === 0x03) {
        answerListFirstFrame();
        return;
      }
      if (bytes[1] === 0x01) {
        answerPid(bytes[2]);
      }
    },
    stop: () => {},
    start: () => {},
    addListener: () => {},
    setRxFilters: (_filters: RxFilter | RxFilter[]) => {},
  } as unknown as RawChannel;

  function answerModeFour(): void {
    if (options.clearReply === "silent") {
      return;
    }
    cleared = true;
    deliver(
      options.clearReply === "positive"
        ? Buffer.from([0x01, 0x44, 0, 0, 0, 0, 0, 0])
        : // 7F 04 22 — conditionsNotCorrect, the refusal an ECU gives while a fault is live.
          Buffer.from([0x03, 0x7f, 0x04, 0x22, 0, 0, 0, 0])
    );
  }

  function answerListFirstFrame(): void {
    if (options.listFrames === null) {
      return;
    }
    listCursor = 1;
    deliver(Buffer.from(parseHexFrame(options.listFrames[0])));
  }

  function replayConsecutiveFrames(): void {
    if (options.listFrames === null) {
      return;
    }
    for (; listCursor < options.listFrames.length; listCursor += 1) {
      deliver(Buffer.from(parseHexFrame(options.listFrames[listCursor])));
    }
  }

  function answerPid(pid: number): void {
    const table = cleared ? options.after : options.before;
    const answer = table.get(pid);
    if (!answer) {
      return;
    }
    deliver(Buffer.from([0x04, 0x41, pid, answer[0], answer[1], 0, 0, 0]), options.pidDelayMs ?? 0);
  }

  return { channel, sent, attach: next => (runner = next) };
}

/** A gate that says the bike is safe, with the charge-manager row in a state we choose. */
function gateVerdict(inlet: ServiceGateCheckState | null, chargingEvidence: string | null): ServiceGateVerdict {
  const checks =
    inlet === null
      ? []
      : [
          {
            key: "charge_manager_status",
            requirement: "cable",
            state: inlet,
            value: 0x58,
            ageMs: 100,
            required: false,
          },
        ];
  return { safe: true, blockers: [], checks, chargingEvidence };
}

interface HarnessOptions extends FakeBusOptions {
  grantHold?: boolean;
  /** Called each time the gate is sampled, so a section can turn the bike unsafe mid-action. */
  gateAt?: (sample: number) => ServiceGateVerdict;
}

interface Harness {
  runner: VcuWriteRunner;
  bus: FakeBus;
  holdLog: string[];
  warnings: string[];
  /** How many frames had been sent at the moment the hold was granted. Must be zero. */
  sentAtHold: () => number;
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const bus = fakeBus(options);
  const holdLog: string[] = [];
  let sentAtHold = -1;
  let gateSamples = 0;
  const directory = await mkdtemp(join(tmpdir(), "clear-dtcs-"));
  const runner = createVcuWriteRunner({
    channel: () => bus.channel,
    busIsActive: true,
    enabled: true,
    directory,
    gate: () => {
      gateSamples += 1;
      return options.gateAt ? options.gateAt(gateSamples) : gateVerdict(null, null);
    },
    latestSweep: () => Promise.resolve(null),
    holdPoller: what => {
      if (options.grantHold === false) {
        holdLog.push(`refused:${what}`);
        return Promise.resolve(null);
      }
      holdLog.push(`held:${what}`);
      sentAtHold = bus.sent.length;
      return Promise.resolve({ release: () => holdLog.push("released") });
    },
  });
  bus.attach(runner);
  return { runner, bus, holdLog, warnings: [], sentAtHold: () => sentAtHold };
}

/** PID 01 packs the count into the low 7 bits of A; PID 31 is a 16-bit A:B. */
const pidStatus = (count: number): [number, number] => [count & 0x7f, 0];
const pidDistance = (km: number): [number, number] => [(km >> 8) & 0xff, km & 0xff];

const BEFORE = new Map<number, [number, number]>([
  [0x01, pidStatus(46)],
  [0x31, pidDistance(19671)],
  [0x02, [0x0a, 0x06]],
]);
const AFTER_ERASED = new Map<number, [number, number]>([
  [0x01, pidStatus(CAPTURED_STORED_CODE_COUNT)],
  [0x31, pidDistance(0)],
  [0x02, [0, 0]],
]);
const AFTER_UNTOUCHED = new Map<number, [number, number]>([
  [0x01, pidStatus(46)],
  [0x31, pidDistance(19671)],
  [0x02, [0x0a, 0x06]],
]);

// --- 1. The clear that works, read back on the same parked bus ----------------

console.log("\n1. a clear the bike honours");

{
  const kit = await harness({
    clearReply: "positive",
    listFrames: CAPTURED_MODE_03_FRAMES_2026_08_04,
    before: BEFORE,
    after: AFTER_ERASED,
  });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });

  check("the action is answered rather than refused", answer.ok);
  const result = answer.ok ? answer.result : null;
  check("status is cleared", result?.status === "cleared");
  check("it reports success", result?.succeeded === true);

  const counts = result?.clear;
  check("the before-count is the one read BEFORE the frame", counts?.storedBefore === 46);
  check(
    `the after-count is the one read after (${CAPTURED_STORED_CODE_COUNT})`,
    counts?.storedAfter === CAPTURED_STORED_CODE_COUNT
  );
  check("PID 31 before is carried", counts?.distSinceClearBeforeKm === 19671);
  check("PID 31 after is zero — the proof of erasure", counts?.distSinceClearAfterKm === 0);
  check("the fresh mode-03 list is counted", counts?.listedAfter === CAPTURED_STORED_CODE_COUNT);

  check(
    "the message states the sweep",
    (result?.message ?? "").includes(`46 stored → ${CAPTURED_STORED_CODE_COUNT} stored`)
  );
  check("the message names PID 31 as the proof", (result?.message ?? "").includes("19671 km → 0 km"));

  // ⚠️ THE CACHE FIX, asserted where it broke: /stored-dtcs serves this snapshot, and before
  // this change it kept serving the PRE-clear list for up to 79 s after the button.
  const stored = troubleCodeSnapshot().stored;
  check(
    "the served snapshot now holds the post-clear list",
    stored.state === "codes" && stored.codes.length === CAPTURED_STORED_CODE_COUNT
  );

  check("the poller was parked", kit.holdLog[0]?.startsWith("held:") === true);
  check("NOTHING was sent before the park was acknowledged", kit.sentAtHold() === 0);
  check("the hold is released", kit.holdLog.includes("released"));

  const modeFour = kit.bus.sent.filter(frame => frame.startsWith("7df 01 04"));
  check("exactly one Mode 04 frame went out", modeFour.length === 1);
  check("it is the documented frame", modeFour[0] === "7df 01 04 00 00 00 00 00 00");
  check(
    "PID 01 was polled on both sides",
    kit.bus.sent.filter(frame => frame === "7df 02 01 01 55 55 55 55 55").length === 2
  );
  check(
    "PID 31 was polled on both sides",
    kit.bus.sent.filter(frame => frame === "7df 02 01 31 55 55 55 55 55").length === 2
  );
  check(
    "the freeze-frame PID was read after",
    kit.bus.sent.filter(frame => frame === "7df 02 01 02 55 55 55 55 55").length === 1
  );
}

// --- 2. The clear the bike accepts and ignores ---------------------------------
//
// The 2026-08-08 and 2026-09-11 shape, which used to be indistinguishable from §1.

console.log("\n2. a positive 44 that erased nothing");

{
  const kit = await harness({
    clearReply: "positive",
    listFrames: null,
    before: BEFORE,
    after: AFTER_UNTOUCHED,
  });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });
  const result = answer.ok ? answer.result : null;

  check("the ECU's own status is still `cleared`", result?.status === "cleared");
  check("but it is NOT reported as a success", result?.succeeded === false);
  check("the message says the bike erased nothing", (result?.message ?? "").includes("ERASED NOTHING"));
  check("PID 31 is carried unchanged", result?.clear?.distSinceClearAfterKm === 19671);
  check("the hold is still released", kit.holdLog.includes("released"));
}

// --- 3. Refusals, silence, and a poller that will not park ---------------------

console.log("\n3. the endings that are not a clear");

{
  const kit = await harness({ clearReply: "refused", listFrames: null, before: BEFORE, after: AFTER_ERASED });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });
  const result = answer.ok ? answer.result : null;
  check("a 7F 04 22 is reported as refused", result?.status === "refused");
  check("nothing is claimed about the counters", result?.clear === undefined);
  check("conditionsNotCorrect is named", (result?.message ?? "").includes("conditionsNotCorrect"));
  check("the hold is released after a refusal", kit.holdLog.includes("released"));
}

{
  const kit = await harness({ clearReply: "silent", listFrames: null, before: BEFORE, after: AFTER_ERASED });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });
  const result = answer.ok ? answer.result : null;
  check("silence is `failed`, not `cleared`", result?.status === "failed");
  check("the hold is released after silence", kit.holdLog.includes("released"));
}

{
  const kit = await harness({
    grantHold: false,
    clearReply: "positive",
    listFrames: null,
    before: BEFORE,
    after: AFTER_ERASED,
  });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });
  check("a poller that will not park refuses the action", !answer.ok);
  check("and NOT ONE FRAME reaches the bus", kit.bus.sent.length === 0);
  check("the reason says nothing was sent", !answer.ok && answer.reason.includes("nothing was sent"));
  check(
    "no hold is left outstanding",
    !kit.holdLog.includes("released") && kit.holdLog[0]?.startsWith("refused:") === true
  );
}

// --- 4. A clear whose read-back cannot answer ----------------------------------

console.log("\n4. a clear that lands and cannot be confirmed");

{
  const kit = await harness({
    clearReply: "positive",
    listFrames: null,
    before: BEFORE,
    after: new Map(),
  });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });
  const result = answer.ok ? answer.result : null;
  check("the counters come back null rather than zero", result?.clear?.distSinceClearAfterKm === null);
  check("`0 cleared` is never invented", result?.clear?.storedAfter === null);
  check(
    "the message says it could not be confirmed",
    (result?.message ?? "").includes("could not be read back to confirm")
  );
  check("an unread counter is not reported as a failure", result?.succeeded === true);
}

// --- 5. The gate watchdog must not announce an abort it did not perform --------
//
// ⚠️ `context.running` used to mean "an action is running" and be cleared only in `perform`'s
// finally, while the watchdog read it as "an exchange is in flight". Those coincided until the
// read-back was appended after the frame. A bike that stops being safe DURING the read-back now
// finds nothing to abort — the actuating half is over and what remains is four OBD reads, which
// is byte for byte what the always-on poller emits with no gate over it at all.

console.log("\n5. the gate turning unsafe after the frame has landed");

{
  const warnings: string[] = [];
  let gateSamples = 0;
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const kit = await harness({
      clearReply: "positive",
      listFrames: CAPTURED_MODE_03_FRAMES_2026_08_04,
      before: BEFORE,
      after: AFTER_ERASED,
      // ⚠️ 150 ms per PID reply so the read-back OUTLASTS the 200 ms watchdog interval. Without
      // it the whole action finishes inside a single tick, the watchdog never samples the unsafe
      // gate, and both assertions below pass whatever the code does — which is what this section
      // did on its first run, and is the trap docs/diagnostics-and-checks.md §11.3 warns about.
      // The tick count is asserted for exactly that reason: a vacuous section must go red.
      pidDelayMs: 150,
      // Sample 1 is `checkPreconditions`; everything after it is the watchdog.
      gateAt: sample => {
        gateSamples = sample;
        return sample <= 1
          ? gateVerdict(null, null)
          : { safe: false, blockers: ["road speed is zero — it reads 4"], checks: [], chargingEvidence: null };
      },
    });
    const answer = await kit.runner.perform({ kind: "clear-dtcs" });
    const result = answer.ok ? answer.result : null;
    check("the watchdog really ran while the bike was unsafe — else the two below are vacuous", gateSamples >= 3);
    check("the read-back still completes", result?.clear?.distSinceClearAfterKm === 0);
    check("no abort is announced against a settled exchange", !warnings.some(line => line.includes("ABORTING")));
  } finally {
    console.warn = realWarn;
  }
}

// --- 6. The three PIDs the runner asks for are PIDs this repo can decode -------
//
// `pollPidNow` warns and answers false for a PID that is not in obd.ts's table, so a constant
// drifting from that table would degrade to "the bike said nothing" rather than failing.

console.log("\n6. the PIDs the clear depends on are in the poll table");

{
  for (const [pid, name] of [
    [0x01, "PID 01 monitor status"],
    [0x02, "PID 02 freeze-frame code"],
    [0x31, "PID 31 distance since clear"],
  ] as [number, string][]) {
    const bus = fakeBus({ clearReply: "silent", listFrames: null, before: BEFORE, after: BEFORE });
    check(`${name} is decodable and answers`, await pollPidNow(bus.channel, pid));
  }
  const bus = fakeBus({ clearReply: "silent", listFrames: null, before: BEFORE, after: BEFORE });
  check("a PID outside the table answers false rather than pretending", !(await pollPidNow(bus.channel, 0xfe)));
}

// --- 7. The sentences under the button ------------------------------------------

console.log("\n7. what the button says afterwards");

const erased: ClearDtcsCounts = {
  storedBefore: 46,
  storedAfter: 5,
  distSinceClearBeforeKm: 19671,
  distSinceClearAfterKm: 0,
  listedAfter: 5,
};

{
  const read = describeClearCounts(erased);
  check('the sweep reads "46 stored → 5 stored, 41 cleared"', read.sweep === "46 stored → 5 stored, 41 cleared");
  check("the proof names both distances", read.proof === "distance since clear 19671 km → 0 km — erased");
  check("erasure is asserted", read.erased === true);
}

{
  const read = describeClearCounts({ ...erased, storedAfter: 46, distSinceClearAfterKm: 19671 });
  check("an unmoved PID 31 is called out", read.proof.includes("still reads 19671 km — the bike erased nothing"));
  check("erasure is denied", read.erased === false);
  check("the sweep still reports 0 cleared honestly", read.sweep === "46 stored → 46 stored, 0 cleared");
}

{
  const read = describeClearCounts({ ...erased, storedAfter: null, distSinceClearAfterKm: null });
  check("an unread counter is neither proof nor disproof", read.erased === null);
  check("the sweep says so rather than showing a number", read.sweep === "stored count could not be read");
  check("the proof line says unconfirmed", read.proof.includes("erasure unconfirmed"));
}

// --- 8. When the cable warning appears -------------------------------------------
//
// ⚠️ `ok` on the veto row is the ONLY state that means "fresh charge manager, cable present":
// src/vcu/service-gate.ts's inletCheck returns `inlet-empty` for an empty inlet, `stale` past
// the 5 s budget and `missing` when the charge manager has never spoken. `stale` is the shape
// the 2026-09-11 ride log leaves behind, and it must NOT warn — the log cannot say what the
// gate read that day, and inventing a warning from a stale row would be inventing that answer.

console.log("\n8. the cable caution");

check("a fresh cable in the inlet warns", chargerIsAttached(gateVerdict("ok", null)));
check("a witnessed charge session warns", chargerIsAttached(gateVerdict("missing", "fast_dc_contactor")));
check("an empty inlet does not warn", !chargerIsAttached(gateVerdict("inlet-empty", null)));
check("a STALE charge manager does not warn", !chargerIsAttached(gateVerdict("stale", null)));
check("a charge manager never seen does not warn", !chargerIsAttached(gateVerdict("missing", null)));
check("2026-09-13's gate — no charge manager at all — does not warn", !chargerIsAttached(gateVerdict(null, null)));
check("no gate at all does not warn", !chargerIsAttached(undefined));

console.log(
  failures === 0
    ? "\n✓ Mode 04 is parked, read back on both sides, and judged on PID 31 rather than on the reply byte\n"
    : `\n✗ ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
