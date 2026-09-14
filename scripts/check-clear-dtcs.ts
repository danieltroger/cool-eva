import type { CanMessage, RawChannel, RxFilter } from "socketcan";
import { handleResponse, pollPidNow } from "../src/can/obd.ts";
import { troubleCodeSnapshot } from "../src/diagnostics/stored-codes.ts";
import { createVcuWriteRunner, type VcuWriteRunner } from "../src/vcu/write-runner.ts";
import type { ServiceGateCheckState, ServiceGateVerdict } from "../src/vcu/service-gate.ts";
import { chargerIsAttached } from "../public/views/vcu-write.js";
import { judgeErasure, type ClearDtcsCounts, type ErasureVerdict } from "../src/vcu/clear-dtcs.ts";
import { verdictSeesACable } from "../src/vcu/charge-session.ts";
import { WORST_CASE_TRANSFER_MS } from "../src/can/obd-dtc.ts";
import { MAX_HOLD_MS } from "../src/can/obd-hold.ts";
import { PID_TIMEOUT_MS } from "../src/can/obd.ts";
import {
  CAPTURED_MODE_03_FRAMES_2026_08_04,
  CAPTURED_STORED_CODE_COUNT,
  parseHexFrame,
} from "./captured-dtc-transfer.ts";
import { mkdtemp, rm } from "fs/promises";
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

/** Runs `body` with console.warn captured, restoring it on every path out. */
async function withCapturedWarnings(body: (warnings: string[]) => Promise<void>): Promise<void> {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await body(warnings);
  } finally {
    console.warn = realWarn;
  }
}

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** Every audit directory this run made, removed at the end rather than left in /tmp. */
const temporaryDirectories: string[] = [];

/** write-session.ts's own reply window for the one Mode 04 frame. */
const FIRST_REPLY_TIMEOUT_MS_FOR_MODE_04 = 300;

const OBD_REQUEST_ID = 0x7df;
const OBD_REPLY_ID = 0x7ef;

/** PID → the two data bytes it answers with, before and after the clear. Absent = silent. */
type PidTable = Map<number, [number, number]>;

interface FakeBusOptions {
  clearReply: "positive" | "refused" | "silent";
  /** Mode-03 frames to replay. Default: none, which is what most sections want. */
  listFrames?: string[] | null;
  /** Default BEFORE / AFTER_ERASED — the 2026-09-13 numbers. */
  before?: PidTable;
  after?: PidTable;
  /**
   * How long a mode-01 reply takes to arrive. Default 0.
   *
   * ⚠️ Only the PID replies, and only up to 200 ms — obd.ts's own per-PID timeout. The
   * mode-03 frames must NOT be slowed: the transport gives a whole transfer 400 ms, so a
   * per-frame delay there fails the transfer instead of pacing it.
   */
  pidDelayMs?: number;
  /** How long the Mode 04 reply takes. Default 0; used to hold `context.running` across a tick. */
  modeFourDelayMs?: number;
  /** Called the instant the Mode 04 REQUEST is seen on the bus, before any reply. */
  onModeFour?: () => void;
  /** Called the instant the mode-03 list request is seen — i.e. the read-back has begun. */
  onListRequest?: () => void;
  /** Called for each mode-01 request, with how many have been sent so far (1-based). */
  onPidRequest?: (sent: number) => void;
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
  let pidRequests = 0;

  const listFrames = options.listFrames ?? null;
  const before = options.before ?? BEFORE;
  const after = options.after ?? AFTER_ERASED;
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
        options.onModeFour?.();
        answerModeFour();
        return;
      }
      if (bytes[1] === 0x03) {
        options.onListRequest?.();
        answerListFirstFrame();
        return;
      }
      if (bytes[1] === 0x01) {
        pidRequests += 1;
        options.onPidRequest?.(pidRequests);
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
          Buffer.from([0x03, 0x7f, 0x04, 0x22, 0, 0, 0, 0]),
      options.modeFourDelayMs ?? 0
    );
  }

  function answerListFirstFrame(): void {
    if (listFrames === null) {
      return;
    }
    listCursor = 1;
    deliver(Buffer.from(parseHexFrame(listFrames[0])));
  }

  function replayConsecutiveFrames(): void {
    if (listFrames === null) {
      return;
    }
    for (; listCursor < listFrames.length; listCursor += 1) {
      deliver(Buffer.from(parseHexFrame(listFrames[listCursor])));
    }
  }

  function answerPid(pid: number): void {
    const table = cleared ? after : before;
    const answer = table.get(pid);
    if (!answer) {
      return;
    }
    deliver(Buffer.from([0x04, 0x41, pid, answer[0], answer[1], 0, 0, 0]), options.pidDelayMs ?? 0);
  }

  return { channel, sent, attach: next => (runner = next) };
}

/** A gate that says the bike is ROLLING. One wording, so four sections stop spelling it out. */
function rollingVerdict(kmh: number): ServiceGateVerdict {
  return { safe: false, blockers: [`road speed is zero — it reads ${kmh}`], checks: [], chargingEvidence: null };
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
  /** Called the moment the hold is granted, so a section can turn the bike unsafe during the park. */
  onHoldGranted?: () => void;
  /** Called each time the gate is sampled, so a section can turn the bike unsafe mid-action. */
  gateAt?: (sample: number) => ServiceGateVerdict;
}

interface Harness {
  runner: VcuWriteRunner;
  bus: FakeBus;
  holdLog: string[];
  /** How many frames had been sent at the moment the hold was granted. Must be zero. */
  sentAtHold: () => number;
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const bus = fakeBus(options);
  const holdLog: string[] = [];
  let sentAtHold = -1;
  let gateSamples = 0;
  const directory = await mkdtemp(join(tmpdir(), "clear-dtcs-"));
  temporaryDirectories.push(directory);
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
    holdPoller: (what: string) => {
      if (options.grantHold === false) {
        holdLog.push(`refused:${what}`);
        return Promise.resolve(null);
      }
      holdLog.push(`held:${what}`);
      sentAtHold = bus.sent.length;
      options.onHoldGranted?.();
      return Promise.resolve({ release: () => holdLog.push("released") });
    },
  });
  bus.attach(runner);
  return { runner, bus, holdLog, sentAtHold: () => sentAtHold };
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
/** The after-read is the before-read: nothing moved. Aliased so §2 says that rather than repeats it. */
const AFTER_UNTOUCHED = BEFORE;

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

// ⚠️ H1: the gate is sampled once in checkPreconditions, and parking the poller can take up to
// HOLD_WAIT_MS. Nothing is in flight through any of it, so the watchdog cannot cover it — the
// re-checks inside performClearDtcs are the only thing standing between that one reading and an
// irreversible frame. A bike rolled while the poller parks must not get its memory erased.

{
  let rolling = false;
  const kit = await harness({
    clearReply: "positive",
    listFrames: null,
    before: BEFORE,
    after: AFTER_ERASED,
    onHoldGranted: () => {
      rolling = true;
    },
    gateAt: () => (rolling ? rollingVerdict(12) : gateVerdict(null, null)),
  });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });
  check("a bike that rolls while the poller parks refuses the clear", !answer.ok);
  check("and NOT ONE FRAME reaches the bus", kit.bus.sent.length === 0);
  check("the refusal names the blocker", !answer.ok && answer.reason.includes("road speed is zero — it reads 12"));
  check("the hold taken for it is still released", kit.holdLog.includes("released"));
}

// ⚠️ And again one step later. The two before-PIDs take 400 ms of their own, so a re-check that
// only runs when the hold is granted still leaves that window between the last gate reading and
// the frame. This case flips the bike unsafe after the counters are read and before the transmit.

{
  let rolling = false;
  const kit = await harness({
    clearReply: "positive",
    listFrames: null,
    before: BEFORE,
    after: AFTER_ERASED,
    onPidRequest: sent => {
      if (sent >= 2) {
        rolling = true;
      }
    },
    gateAt: () => (rolling ? rollingVerdict(9) : gateVerdict(null, null)),
  });
  const answer = await kit.runner.perform({ kind: "clear-dtcs" });
  check("a bike that rolls while the counters are read refuses the clear", !answer.ok);
  check(
    "the two harmless PID reads went out, and NO Mode 04 did",
    kit.bus.sent.every(frame => !frame.startsWith("7df 01 04"))
  );
  check("the refusal names that window", !answer.ok && answer.reason.includes("while the counters were read"));
  check("the hold is released", kit.holdLog.includes("released"));
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
    "the message says nothing proves the bike acted",
    (result?.message ?? "").includes("nothing here proves the bike acted on it")
  );
  check("and names the reason", (result?.message ?? "").includes("counters could not be read back"));
  check("an unread counter is not reported as a failure", result?.succeeded === true);
}

// --- 5. The gate watchdog: teeth while the frame is in flight, silence afterwards ----
//
// ⚠️ TWO SECTIONS, AND THE FIRST IS THE POSITIVE CONTROL. `context.running` is cleared as soon as
// the Mode 04 outcome settles, and the watchdog returns early when it is null — so "no ABORTING
// was logged" is worthless on its own: with an instant bus `running` is non-null for about a
// millisecond and no 200 ms tick ever lands inside it, and the whole warn/abort body could be
// deleted with both assertions still green. §5a holds the exchange open across a tick and asserts
// the watchdog DOES cut it short; §5b then asserts it stays quiet once the frame has landed.

console.log("\n5a. a bike that rolls WHILE the Mode 04 is in flight");

{
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    let rolling = false;
    let ticksWhileInFlight = 0;
    let inFlight = false;
    const kit = await harness({
      clearReply: "positive",
      listFrames: null,
      before: BEFORE,
      after: AFTER_ERASED,
      // The reply is held for 500 ms — longer than the 200 ms watchdog interval — so the tick
      // lands while `context.running` is genuinely set. This is the only window in which the
      // watchdog has anything to abort, and before this section nothing exercised it.
      modeFourDelayMs: 500,
      onModeFour: () => {
        rolling = true;
        inFlight = true;
      },
      gateAt: () => {
        if (inFlight) {
          ticksWhileInFlight += 1;
        }
        return rolling ? rollingVerdict(7) : gateVerdict(null, null);
      },
    });
    const answer = await kit.runner.perform({ kind: "clear-dtcs" });
    const result = answer.ok ? answer.result : null;

    // Exactly one: `fired` short-circuits every later tick before it reads the gate again. One is
    // all that is needed, and it is one more than the previous version of this section ever got.
    check("the watchdog sampled the gate while the frame was in flight", ticksWhileInFlight >= 1);
    check(
      "it announces the abort",
      warnings.some(line => line.includes("ABORTING"))
    );
    check(
      "it names the blocker",
      warnings.some(line => line.includes("road speed is zero — it reads 7"))
    );
    check("the exchange is cut short rather than reported as cleared", result?.status !== "cleared");
    // ⚠️ Not `status !== "cleared"` alone — a plain 300 ms timeout gives that too, so the previous
    // version of this assertion passed with the watchdog's teeth removed. An abort settles the
    // pending request as an EMPTY payload (write-session.ts's stop()), which decodes as
    // "unrecognised" with this reason; a timeout says "no reply within the 300 ms window".
    check(
      "and it is the ABORT that cut it, not the reply window expiring",
      (result?.message ?? "").includes("frame shorter than a PCI byte")
    );
    check("nothing is claimed about the counters", result?.clear === undefined);
    check("the hold is released even when the watchdog fires", kit.holdLog.includes("released"));
  } finally {
    console.warn = realWarn;
  }
}

// ⚠️ The mirror. A bike that rolls AFTER the frame has landed finds nothing to abort — the
// actuating half is over and what remains is four OBD reads, byte for byte what the always-on
// poller emits at 2 Hz with no gate over it at all. What must NOT happen is the journal recording
// an abort that never occurred, which is what it did before `context.running` was cleared early.

console.log("\n5b. a bike that rolls once the frame has landed");

{
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    let readingBack = false;
    let ticksDuringReadBack = 0;
    const kit = await harness({
      clearReply: "positive",
      listFrames: CAPTURED_MODE_03_FRAMES_2026_08_04,
      before: BEFORE,
      after: AFTER_ERASED,
      // ⚠️ 150 ms per PID reply so the read-back OUTLASTS the 200 ms watchdog interval, and the
      // tick count below is asserted so this section cannot go vacuous the way it first did.
      // 150 and not more: obd.ts gives a PID 200 ms, and the mode-03 frames must not be paced at
      // all — the transport gives a whole transfer 400 ms.
      pidDelayMs: 150,
      // ⚠️ Flipped on the THIRD PID request — the first of the after-reads — rather than on a
      // sample index or on the list. The read-back is PID 01, PID 31, PID 02, then the list, so
      // anchoring on the list would put the flip at the very end and leave almost no read-back
      // for the watchdog to tick through. The phase is still read off the bus, not counted in
      // wall-clock, so reordering the read-back again cannot silently make this vacuous.
      onPidRequest: sent => {
        if (sent >= 3) {
          readingBack = true;
        }
      },
      gateAt: () => {
        if (readingBack) {
          ticksDuringReadBack += 1;
          return rollingVerdict(4);
        }
        return gateVerdict(null, null);
      },
    });
    const answer = await kit.runner.perform({ kind: "clear-dtcs" });
    const result = answer.ok ? answer.result : null;
    check("the watchdog sampled the gate during the read-back", ticksDuringReadBack >= 2);
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
    const bus = fakeBus({ clearReply: "silent" });
    check(`${name} is decodable and answers`, (await pollPidNow(bus.channel, pid)) !== null);
  }
  const bus = fakeBus({ clearReply: "silent" });
  check("a PID outside the table answers null rather than pretending", (await pollPidNow(bus.channel, 0xfe)) === null);
  // ⚠️ `false` is also what a silent bus returns, so the verdict alone says nothing. What
  // distinguishes "not in the table" is that the request never went out at all.
  check("and it never reaches the bus, which is what makes it a different answer from silence", bus.sent.length === 0);
}

// ⚠️ pollPidNow shares the module-level `pending` map with the always-on loop, and PID 31 is
// polled every round, so an unparked loop asking for the same PID crosses the two replies. It is
// warned rather than refused — the hold is capped BY THE LOOP, so a read-back that overruns finds
// the poller back underneath it, and a silent refusal there would look like a bike that said
// nothing. Asserted so the implication is checkable rather than merely argued, the way
// troubleCodeTransferInFlight() is for the sibling case.
{
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const bus = fakeBus({ clearReply: "silent" });
    await pollPidNow(bus.channel, 0x31);
    check(
      "polling with the poller UNPARKED says so out loud",
      warnings.some(line => line.includes("UNPARKED"))
    );
  } finally {
    console.warn = realWarn;
  }
}

// --- 7. The verdict the Pi reaches, and the sentence it sends ------------------
//
// ⚠️ ONE COMPOSER. The page used to rebuild the sweep and the proof line from these numbers,
// which put the prose in three places with only the verdict compared — so the wordings could
// drift while this check stayed green. The browser now styles `result.message` by
// `result.clear.verdict`, so what is worth asserting here is the verdict and the Pi's words.

console.log("\n7. the verdict, and the words that go with it");

const erased: ClearDtcsCounts = {
  storedBefore: 46,
  storedAfter: 5,
  distSinceClearBeforeKm: 19671,
  distSinceClearAfterKm: 0,
  listedAfter: 5,
  verdict: "erased",
};

{
  const cases: [string, ClearDtcsCounts, ErasureVerdict][] = [
    ["a counter that fell to zero", erased, "erased"],
    ["a counter that did not move", { ...erased, storedAfter: 46, distSinceClearAfterKm: 19671 }, "erased-nothing"],
    ["an after-read that failed", { ...erased, distSinceClearAfterKm: null }, "unproven"],
    ["a before-read that failed", { ...erased, distSinceClearBeforeKm: null }, "unproven"],
    // ⚠️ THE RETRY. Five codes came back within a second on 2026-09-13, so pressing again a
    // minute later is the expected gesture — and on that press PID 31 reads 0 on BOTH sides.
    // Keying on the after-value alone called that "erased" in green, which is the exact claim
    // the two failed presses make, on the press that most needs an honest verdict.
    ["0 km → 0 km, the retry", { ...erased, distSinceClearBeforeKm: 0, distSinceClearAfterKm: 0 }, "unproven"],
  ];
  for (const [what, counts, expected] of cases) {
    check(`${what} is judged ${expected}`, judgeErasure(counts) === expected);
  }
}

// --- 8. When the cable warning appears -------------------------------------------
//
// ⚠️ `ok` on the veto row is the ONLY state that means "fresh charge manager, cable present":
// src/vcu/service-gate.ts's inletCheck returns `inlet-empty` for an empty inlet, `stale` past
// the 5 s budget and `missing` when the charge manager has never spoken. `stale` is the shape
// the 2026-09-11 ride log leaves behind, and it must NOT warn — the log cannot say what the
// gate read that day, and inventing a warning from a stale row would be inventing that answer.

console.log("\n8. the cable caution");

// ⚠️ BOTH copies, every case. The Pi's `verdictSeesACable` decides whether the audit journal
// advises unplugging; the browser's `chargerIsAttached` decides whether the caution shows. They
// cannot import each other — no build step in public/ — so this is what stops them drifting.
for (const [what, verdict, expected] of [
  ["a fresh cable in the inlet", gateVerdict("ok", null), true],
  ["a witnessed charge session", gateVerdict("missing", "fast_dc_contactor"), true],
  ["an empty inlet", gateVerdict("inlet-empty", null), false],
  ["a STALE charge manager", gateVerdict("stale", null), false],
  ["a charge manager never seen", gateVerdict("missing", null), false],
  ["2026-09-13's gate — no charge manager at all", gateVerdict(null, null), false],
] as [string, ServiceGateVerdict, boolean][]) {
  check(`${what}: the Pi ${expected ? "warns" : "does not warn"}`, verdictSeesACable(verdict) === expected);
  check(`${what}: the page agrees`, chargerIsAttached(verdict) === expected);
}

check("a fresh cable in the inlet warns", chargerIsAttached(gateVerdict("ok", null)));
check("a witnessed charge session warns", chargerIsAttached(gateVerdict("missing", "fast_dc_contactor")));
check("an empty inlet does not warn", !chargerIsAttached(gateVerdict("inlet-empty", null)));
check("a STALE charge manager does not warn", !chargerIsAttached(gateVerdict("stale", null)));
check("a charge manager never seen does not warn", !chargerIsAttached(gateVerdict("missing", null)));
check("2026-09-13's gate — no charge manager at all — does not warn", !chargerIsAttached(gateVerdict(null, null)));
check("no gate at all does not warn", !chargerIsAttached(undefined));

// --- 9. The hold budget is arithmetic, not a sentence in a comment ---------------
//
// ⚠️ docs/clear-dtcs.md §5 calls this margin load-bearing and then states it as a number nothing
// verifies. Past obd-hold.ts's cap the poller resumes UNDERNEATH the read-back and its own 0x7DF
// traffic makes the VCU abandon the transfer, so adding a PID or raising RETRY_ATTEMPTS has to go
// red here rather than in a garage.

console.log("\n9. the parked window still fits inside the cap");

{
  // ⚠️ The PID count is COUNTED off a real run, not written down. `5 * PID_TIMEOUT_MS` was a copy
  // of the action's shape, so adding a sixth read left this green while the budget grew.
  const kit = await harness({ clearReply: "positive", listFrames: CAPTURED_MODE_03_FRAMES_2026_08_04 });
  await kit.runner.perform({ kind: "clear-dtcs" });
  const pidRequests = kit.bus.sent.filter(frame => frame.startsWith("7df 02 01 ")).length;
  check("the clear reads five PIDs, and the budget below counts them rather than assuming", pidRequests === 5);

  const worstCase = FIRST_REPLY_TIMEOUT_MS_FOR_MODE_04 + WORST_CASE_TRANSFER_MS + pidRequests * PID_TIMEOUT_MS;
  check(`the worst case (${worstCase} ms) fits inside MAX_HOLD_MS (${MAX_HOLD_MS} ms)`, worstCase < MAX_HOLD_MS);
  check("with at least a 2x margin, since the cap is enforced by the loop and not by us", worstCase * 2 < MAX_HOLD_MS);
}

for (const directory of temporaryDirectories) {
  await rm(directory, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\n✓ Mode 04 is parked, gated either side, read back on both sides, and judged on PID 31 rather than on the reply byte\n"
    : `\n✗ ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
