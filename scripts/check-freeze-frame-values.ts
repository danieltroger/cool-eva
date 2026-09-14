import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_HOLD_MS } from "../src/can/obd-hold.ts";
import { frameArrival } from "../src/can/frame-arrival.ts";
import {
  decodeFreezeFrameResponse,
  isNoStoredRecordReply,
  type FreezeFrameValue,
} from "../src/diagnostics/freeze-frame.ts";
import {
  FREEZE_FRAME_READ_BUDGET_MS,
  describeFreezeFrameRead,
  WORST_CASE_COMPONENT_MS,
  WORST_CASE_LIST_MS,
  startFreezeFrameRead,
} from "../src/vcu/freeze-frame-read.ts";
import {
  degradedComponents,
  loadFreezeFrames,
  writeFreezeFrameRead,
  type StoredFreezeFrameRead,
} from "../src/vcu/freeze-frame-store.ts";
import { loadExpectedFaults, setExpectedFault } from "../src/vcu/expected-faults.ts";
import { toHex } from "../src/vcu/multiframe-codec.ts";
import { boundsForInfokey, infokeyFault } from "../public/lib/infokey-bounds.js";
import {
  CAPTURED_FREEZE_FRAMES,
  capturedFreezeFramePayload,
  componentSixtyTwoWithSentinel,
} from "./captured-freeze-frames.ts";
import {
  CAPTURED_EXCHANGE_53,
  CAPTURED_EXCHANGE_54,
  CAPTURED_EXCHANGE_60,
  LIFETIME_READ_PAYLOADS,
  capturedExchangePayload,
} from "./captured-lifetime-reads.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";
import { simulateVcuMicros } from "./simulated-vcu-micro.ts";

//   node --experimental-strip-types scripts/check-freeze-frame-values.ts
//
// The whole-bike freeze-frame read: the `0x18` list, `0x17` per component, the deadline
// that keeps it inside the OBD poller's hold, the store rule that decides whether a new
// read may replace an old one, and the bounds gate the values are drawn through.
//
// ⚠️ WHAT EACH SECTION IS WORTH, because an item that quietly degrades to "the function
// exists" is worse than one that is not claimed:
//
//   §1 END-TO-END against a simulated A8 — the real client, the real ISO-TP reassembly,
//      the real flow control, and the committed 2026-08-08 payloads as what it serves.
//   §2 END-TO-END for the deadline, on an INJECTED clock. No double in this repo can burn
//      a worst-case component (replies come back in ~2 ms), so walking the real clock
//      would make the count depend on how loaded the laptop is. §2b asserts no production
//      call site can inject one — the seam is a bypass as much as a seam.
//   §3 END-TO-END for a `0x18` that fails: nothing asked, nothing stored.
//   §4 PURE + a tmpdir. The store's clobber rule, case by case.
//   §5 PURE replay. Every committed reply, decoded, against the documented values.
//   §6 PURE replay. The bounds gate over every field of every committed reply.
//   §7 PURE + a tmpdir. The expected-fault list.
//   §8 PURE arithmetic. The two relationships that make the budget safe and useful.
//
// ⚠️ And what the double itself is worth: its reply half is a double of a guess
// (scripts/simulated-vcu-micro.ts's own header). Passing here proves this read is
// well-behaved against the framing this repo believes in. It does not prove the bike is.

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    return;
  }
  failures.push(message);
}

const temporaryDirectories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-freeze-frames-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Every committed reply, in one list: 29 from 2026-08-08 and 5 from 2026-09-08. */
const COMMITTED_REPLIES: { label: string; component: number; payload: Uint8Array }[] = [
  ...CAPTURED_FREEZE_FRAMES.map(entry => ({
    label: `2026-08-08 c${entry.component}`,
    component: entry.component,
    payload: capturedFreezeFramePayload(entry),
  })),
  ...LIFETIME_READ_PAYLOADS.map(entry => ({
    label: `2026-09-08 c${entry.component}`,
    component: entry.component,
    payload: parseHexFrame(entry.payloadHex),
  })),
  ...[CAPTURED_EXCHANGE_53, CAPTURED_EXCHANGE_60, CAPTURED_EXCHANGE_54].map(exchange => ({
    label: `2026-09-08 c${exchange.component}`,
    component: exchange.component,
    payload: capturedExchangePayload(exchange),
  })),
];

/** A `0x58` body: `<count>` then three-byte `<hi> <lo> <status>` records. */
function storedDtcList(records: [component: number, status: number][]): Uint8Array {
  const body = [0x58, records.length];
  for (const [component, status] of records) {
    body.push((component >> 8) & 0xff, component & 0xff, status);
  }
  return Uint8Array.from(body);
}

/** The committed reply for one component, as the double will serve it. */
function payloadFor(component: number): Uint8Array {
  const found = COMMITTED_REPLIES.find(entry => entry.component === component);
  if (!found) {
    throw new Error(`check-freeze-frame-values: no committed reply for component ${component}`);
  }
  return found.payload;
}

// ── §1 the whole read, end to end against the double ────────────────────────
console.log("── §1 the 0x18 list then 0x17 per component, against a simulated A8 ──");
{
  // ⚠️ The list carries a `(0,0)` padding record, a `(0,5)` and a `(64,5)` — both outside
  // 1…63 — and component 44 TWICE. Every one of those reaches `encodeRequestPayload`'s
  // throw or wastes a component of budget if the caller does not filter, and the throw
  // would discard the components already read. This is the fixture that proves it does.
  const list = storedDtcList([
    [44, 0x07],
    [0, 0],
    [0, 5],
    [64, 5],
    [44, 0x07],
    [51, 0x05],
    [60, 0x05],
  ]);
  const freezeFrames = new Map([44, 51, 60].map(component => [component, payloadFor(component)] as const));
  const bus = simulateVcuMicros([{ target: "A8", records: new Map(), freezeFrames, storedDtcList: list }]);
  const read = startFreezeFrameRead({ channel: bus.channel });
  bus.channel.addListener("onMessage", message => read.handleFrame(message.id, message.data, frameArrival(message)));
  const result = await read.finished;

  check(result.completion === "complete", `a list that answers should complete, got ${result.completion}`);
  check(
    result.components.join(",") === "44,51,60",
    `padding, out-of-range and duplicate records should be dropped, asked about ${result.components.join(",")}`
  );
  // ⚠️ Asserted non-null first: `list === null` is now the store's ONLY guard against
  // writing "the bike has nothing stored" from a list it never read, so a run that answered
  // must carry one.
  check(result.list !== null, "a 0x18 that answered must produce a list report");
  check(result.list?.padding === 1, `one padding record, counted ${result.list?.padding}`);
  // ⚠️ Two, not three: `(0,0)` is ALSO outside 1…63, and counting it here would make an
  // empty list indistinguishable from a garbled one — which is what §4d turns on.
  check(result.list?.outOfRange === 2, `two out-of-range records, counted ${result.list?.outOfRange}`);
  check(result.list?.duplicate === 1, `one duplicate record, counted ${result.list?.duplicate}`);
  check(result.replies.length === 3, `three components asked about, got ${result.replies.length}`);
  for (const reply of result.replies) {
    check(reply.failure === null, `component ${reply.component} should have answered, got ${reply.failure}`);
    check(
      reply.payloadHex === toHex(payloadFor(reply.component)),
      `component ${reply.component} should reassemble to the committed payload, got ${reply.payloadHex}`
    );
  }
  // 44 and 51 both segment, so a flow control genuinely went out and the double recorded it.
  const flowControls = bus.sentFrames.filter(frame => /^A8 30/.test(frame));
  check(flowControls.length >= 2, `each segmented reply needs a flow control, saw ${flowControls.length}`);
  // ⚠️ The MEASUREMENT reaches the line, which is the only thing that consumes it. Both
  // numbers are taken on every read — how late our flow control was, and the worst
  // event-loop delay — and they were reaching nothing at all: not the journal, not the
  // endpoint, not the store. Asserted on the line rather than on the fields, because the
  // fields existing is not the property that was missing.
  // ⚠️ The VALUE, not just the words. `/no flow control was needed/` also matches when the
  // accumulator was thrown away, which is how an earlier version of this assertion survived
  // exactly that mutation: two of these three replies segment, so a flow control genuinely
  // went out and a null here means the measurement was lost rather than unneeded.
  check(
    result.flowControl !== null,
    "two of these replies segment, so the read must come back with a flow-control measurement"
  );
  const line = describeFreezeFrameRead(result);
  check(
    /flow control \d|flow-control latency unmeasured/.test(line),
    `the journal line must carry the flow-control measurement, got "${line}"`
  );
  check(/loop/.test(line), `…and the event-loop delay, got "${line}"`);
  console.log(`  3 of 7 records asked about, 4 dropped by name; ${flowControls.length} flow-control frames went out`);
  console.log(`  ${line}`);
}

// ── §1b a component that answers about somebody else is not an answer ────────
console.log("── §1b a mismatched echo is filed as a failure, not as a reading ──");
{
  // The double is told component 44 answers with component 51's payload. On a bus where
  // every VCU reply lands on 0x7E0 with no request tag this is a real failure mode, and at
  // ~30 sequential requests it is not a hypothetical.
  const freezeFrames = new Map([[44, payloadFor(51)]]);
  const bus = simulateVcuMicros([
    { target: "A8", records: new Map(), freezeFrames, storedDtcList: storedDtcList([[44, 0x07]]) },
  ]);
  const read = startFreezeFrameRead({ channel: bus.channel });
  bus.channel.addListener("onMessage", message => read.handleFrame(message.id, message.data, frameArrival(message)));
  const result = await read.finished;
  const reply = result.replies[0];
  check(reply?.failure?.startsWith("component-mismatch") === true, `expected a mismatch, got ${reply?.failure}`);
  // `reply?.payloadHex !== null` also passes when there is no reply at all — a check that
  // green-lights the absence of the thing it is about.
  check(
    typeof reply?.payloadHex === "string",
    `the bytes are kept even when the echo is wrong, got ${reply?.payloadHex}`
  );
  console.log(`  ${reply?.failure}`);
}

// ── §2 the deadline, on an injected clock ───────────────────────────────────
console.log("── §2 the budget stops the read while a whole component still fits ──");
{
  // ⚠️ The budget is a MULTIPLE of the per-component worst case, not a small literal. At
  // less than one worst case the predicate is true before the first component and the read
  // stops at 0 of N — which satisfies "stopped early", "reported budget-spent" and "elapsed
  // stayed inside the budget" with the loop body never executing.
  const budgetMs = 4 * WORST_CASE_COMPONENT_MS;
  const components: [number, number][] = Array.from({ length: 10 }, (_, index) => [index + 3, 0x05]);
  // The clock advances by one worst case per component asked, and by the list's own worst
  // case before that, so the count below is arithmetic rather than a measurement of this
  // laptop. 1020 → 2750 → 4480 → stop at 6210 + 1730 > 6920.
  const freezeFrames = new Map(components.map(([component]) => [component, payloadFor(44)] as const));
  const bus = simulateVcuMicros([
    { target: "A8", records: new Map(), freezeFrames, storedDtcList: storedDtcList(components) },
  ]);
  // ⚠️ Driven off what actually reached the bus, not off a listener: the double delivers
  // the MICRO's frames to `onMessage`, so a counter hung there never sees our own requests
  // and the clock would stand still — which is how this section first passed while reading
  // all ten. `sentFrames` is the tester's side.
  const origin = 1_000_000;
  const listSent = () => bus.sentFrames.some(frame => /^A8 04 18/.test(frame));
  const asked = () => bus.sentFrames.filter(frame => /^A8 03 17/.test(frame)).length;
  const now = () => origin + (listSent() ? WORST_CASE_LIST_MS : 0) + asked() * WORST_CASE_COMPONENT_MS;
  const read = startFreezeFrameRead({ channel: bus.channel, budgetMs, now });
  bus.channel.addListener("onMessage", message => read.handleFrame(message.id, message.data, frameArrival(message)));
  const result = await read.finished;

  check(result.completion === "budget-spent", `expected budget-spent, got ${result.completion}`);
  check(result.replies.length === 3, `expected 3 of 10 asked, got ${result.replies.length}`);
  check(result.components.length === 10, `the whole list is still reported, got ${result.components.length}`);
  check(
    result.elapsedMs <= budgetMs,
    `elapsed ${result.elapsedMs} ms must stay inside the ${budgetMs} ms budget — this is what the lookahead buys`
  );
  console.log(
    `  ${result.replies.length} of ${result.components.length} asked in ${result.elapsedMs} ms of ${budgetMs}`
  );
}

// ── §2a abort: the one member of the union nothing exercised ────────────────
console.log("── §2a a gate-closed abort keeps what it read and says which it was ──");
{
  const components: [number, number][] = [
    [44, 0x07],
    [51, 0x05],
    [52, 0x05],
    [60, 0x05],
  ];
  const freezeFrames = new Map(components.map(([component]) => [component, payloadFor(component)] as const));
  const bus = simulateVcuMicros([
    { target: "A8", records: new Map(), freezeFrames, storedDtcList: storedDtcList(components) },
  ]);
  const read = startFreezeFrameRead({ channel: bus.channel });
  bus.channel.addListener("onMessage", message => read.handleFrame(message.id, message.data, frameArrival(message)));
  // Aborted the way ../src/vcu/read-runner.ts's gate watchdog does: from outside the loop.
  // ⚠️ On the FIRST reply rather than on a timer — the double answers in ~2 ms and the pace
  // is 10 ms, so a timer lands wherever the laptop's load puts it, which is how a check
  // starts asserting "cancelled" about a run that was cancelled before the 0x18 finished.
  let aborted = false;
  bus.channel.addListener("onMessage", () => {
    if (!aborted && bus.sentFrames.filter(frame => /^A8 03 17/.test(frame)).length >= 1) {
      aborted = true;
      read.abort("the bike started moving");
    }
  });
  const result = await read.finished;

  check(result.completion === "cancelled", `an abort must report cancelled, got ${result.completion}`);
  check(result.reason === "the bike started moving", `the reason must survive, got ${result.reason}`);
  // ⚠️ Kept, not discarded. Everything read before the gate closed is still a reading.
  check(result.replies.length < components.length, `the abort must stop it early, asked ${result.replies.length}`);
  check(result.components.length === components.length, "the whole list is still reported");
  console.log(`  ${result.replies.length} of ${result.components.length} read, then: ${result.reason}`);

  // ⚠️ …and a cancel that lands during the `0x18` is still a cancel. `client.stop()` refuses
  // the transmit, so the list arrives as "never reached the bus" — which would report a gate
  // watchdog closing on a moving motorcycle as a micro that did not answer.
  const early = simulateVcuMicros([
    { target: "A8", records: new Map(), freezeFrames, storedDtcList: storedDtcList(components) },
  ]);
  const earlyRead = startFreezeFrameRead({ channel: early.channel });
  early.channel.addListener("onMessage", message =>
    earlyRead.handleFrame(message.id, message.data, frameArrival(message))
  );
  earlyRead.abort("the bike started moving");
  const earlyResult = await earlyRead.finished;
  check(
    earlyResult.completion === "cancelled",
    `a cancel before the 0x18 answered must still be cancelled, got ${earlyResult.completion}`
  );
  check(earlyResult.reason === "the bike started moving", `…with the reason kept, got ${earlyResult.reason}`);
  console.log(`  and cancelled before the list answered: ${earlyResult.reason}`);
}

// ── §2b the clock seam is a bypass: no production caller may pass one ───────
console.log("── §2b nothing in src/ injects the deadline's clock ──");
{
  const entries = await readdir(join(import.meta.dirname, "..", "src"), { recursive: true });
  const offenders: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const text = await readFile(join(import.meta.dirname, "..", "src", entry), "utf8");
    // The call site, not the definition: `startFreezeFrameRead({ … now … })`.
    for (const match of text.matchAll(/startFreezeFrameRead\(\{[^}]*\}/g)) {
      if (/\bnow\b|\bbudgetMs\b/.test(match[0])) {
        offenders.push(`src/${entry}: ${match[0].replace(/\s+/g, " ")}`);
      }
    }
  }
  check(
    offenders.length === 0,
    `a production call site injects the deadline's clock or budget, which defeats it: ${offenders.join("; ")}`
  );
  console.log("  the seam exists for this file and for nothing that ships");
}

// ── §3 a 0x18 that fails asks nothing and stores nothing ────────────────────
console.log("── §3 no list means no read ──");
{
  const bus = simulateVcuMicros([
    { target: "A8", records: new Map(), freezeFrames: new Map(), silentServices: [0x18] },
  ]);
  const read = startFreezeFrameRead({ channel: bus.channel });
  bus.channel.addListener("onMessage", message => read.handleFrame(message.id, message.data, frameArrival(message)));
  const result = await read.finished;

  check(result.completion === "no-list", `expected no-list, got ${result.completion}`);
  check(result.replies.length === 0, `nothing should be asked, got ${result.replies.length}`);
  const asked = bus.sentFrames.filter(frame => /^A8 03 17/.test(frame));
  check(asked.length === 0, `no 0x17 may reach the bus without a list, saw ${asked.length}`);

  const directory = await scratchDirectory();
  const good = await writeFreezeFrameRead(directory, {
    readAt: Date.now(),
    source: "service",
    completion: "complete",
    components: [44],
    replies: [{ component: 44, payloadHex: toHex(payloadFor(44)), failure: null }],
    list: { declaredCount: 1, parsed: 1, padding: 0, outOfRange: 0, duplicate: 0, truncated: false, trailingHex: "" },
  });
  check(good.stored, `a good reading should store, got ${good.reason}`);
  const after = await writeFreezeFrameRead(directory, {
    readAt: Date.now(),
    source: "service",
    completion: result.completion,
    components: result.components,
    replies: result.replies,
    list: result.list,
  });
  check(!after.stored, "a no-list run must never replace a stored reading");
  console.log(`  ${result.reason}; the store refused it — ${after.reason}`);
}

// ── §4 the store's clobber rule ─────────────────────────────────────────────
console.log("── §4 a read may not lose a component the bike still says it has ──");
{
  const answered = (component: number) => ({
    component,
    payloadHex: toHex(payloadFor(component)),
    failure: null,
  });
  const failed = (component: number) => ({
    // ⚠️ A REFUSAL: bytes AND a failure. `payloadHex !== null` calls this an answer, which
    // is the mistake `answeredCount`'s own comment records being made at four call sites.
    component,
    payloadHex: "7F 17 31",
    failure: "refused: requestOutOfRange (NRC 0x31)",
  });
  const list = (count: number) => ({
    declaredCount: count,
    parsed: count,
    padding: 0,
    outOfRange: 0,
    duplicate: 0,
    truncated: false,
    trailingHex: "",
  });
  const base: Omit<StoredFreezeFrameRead, "components" | "replies" | "list" | "completion"> = {
    readAt: Date.now(),
    source: "service",
  };

  // (a) five good, then five listed with only one answering — the run that the count rule
  //     called `complete` and stored.
  const directory = await scratchDirectory();
  const five = [44, 51, 52, 53, 60];
  const first = await writeFreezeFrameRead(directory, {
    ...base,
    completion: "complete",
    components: five,
    replies: five.map(answered),
    list: list(5),
  });
  check(first.stored, `the first reading should store, got ${first.reason}`);
  const degradedRun = await writeFreezeFrameRead(directory, {
    ...base,
    completion: "complete",
    components: five,
    replies: [answered(44), ...five.slice(1).map(failed)],
    list: list(5),
  });
  check(!degradedRun.stored, "a complete run that lost four answered components must not store");

  // (b) the codes were cleared: the list shrank, and the old components are gone from it.
  const shrunk = await writeFreezeFrameRead(directory, {
    ...base,
    completion: "complete",
    components: [44, 51],
    replies: [answered(44), answered(51)],
    list: list(2),
  });
  check(shrunk.stored, `a genuinely shorter list is the bike's answer and must store, got ${shrunk.reason}`);

  // (c) a budget-spent run that never reached a component the file holds.
  const partial = await writeFreezeFrameRead(directory, {
    ...base,
    completion: "budget-spent",
    components: [44, 51],
    replies: [answered(44)],
    list: list(2),
  });
  check(!partial.stored, "a partial run that skipped an answered component must not store");

  // (d) an empty list is an answer; a garbled one is not.
  const emptied = await writeFreezeFrameRead(directory, {
    ...base,
    completion: "complete",
    components: [],
    replies: [],
    list: list(0),
  });
  check(emptied.stored, `an empty 0x18 list is the bike saying nothing is stored, got ${emptied.reason}`);
  const garbled = await writeFreezeFrameRead(directory, {
    ...base,
    completion: "complete",
    components: [],
    replies: [],
    list: { ...list(0), outOfRange: 3 },
  });
  check(!garbled.stored, "a list whose every record was illegal must not be written as 'nothing is stored'");

  // (d3) ⚠️ THE THREE RUNS REVIEW FOUND, each of which destroyed a five-component file.
  //      All three share one shape: the `0x18` did not fully parse, so "absent from the
  //      list" stopped meaning "the bike no longer has it".
  const damaged = await scratchDirectory();
  const seed = async () =>
    writeFreezeFrameRead(damaged, {
      ...base,
      completion: "complete",
      components: five,
      replies: five.map(answered),
      list: list(5),
    });
  const stillThere = async () => (await loadFreezeFrames(damaged))?.records.length ?? 0;

  // (d3a) a count byte of ZERO with fifteen bytes of real records behind it. `truncated` is
  //       false because `0 < 0`, `outOfRange` is 0 because nothing parsed, and the run needs
  //       no answered component at all to wipe the file.
  await seed();
  const phantomEmpty = await writeFreezeFrameRead(damaged, {
    ...base,
    completion: "complete",
    components: [],
    replies: [],
    list: { ...list(0), parsed: 0, trailingHex: "00 2C 07 00 33 05 00 34 05 00 35 01 00 3C 05" },
  });
  check(!phantomEmpty.stored, "a list whose count byte says 0 with records in trailingHex must not be read as empty");
  check((await stillThere()) === 5, "…and the five stored components must still be there");

  // (d3b) declared five, sent two, both answer. `degradedComponents` could not protect the
  //       other three before, because they are not in `next.components`.
  const shortList = await writeFreezeFrameRead(damaged, {
    ...base,
    completion: "complete",
    components: [44, 51],
    replies: [answered(44), answered(51)],
    list: { ...list(5), parsed: 2, truncated: true },
  });
  check(!shortList.stored, "a truncated 0x18 list must not delete the components it failed to carry");
  check((await stillThere()) === 5, "…and the five stored components must still be there");

  // (d3c) four of five records outside 1…63, the survivor answers.
  const mostlyGarbled = await writeFreezeFrameRead(damaged, {
    ...base,
    completion: "complete",
    components: [44],
    replies: [answered(44)],
    list: { ...list(5), parsed: 5, outOfRange: 4 },
  });
  check(!mostlyGarbled.stored, "a list where four of five records were illegal must not delete four components");
  check((await stillThere()) === 5, "…and the five stored components must still be there");

  // ⚠️ And the rule still lets a GENUINE clear through, which is the thing it must not
  // break: same narrowing, clean parse.
  const cleanClear = await writeFreezeFrameRead(damaged, {
    ...base,
    completion: "complete",
    components: [44, 51],
    replies: [answered(44), answered(51)],
    list: list(2),
  });
  check(cleanClear.stored, `a cleanly-parsed shorter list is still the bike's answer, got ${cleanClear.reason}`);

  // (d4) ⚠️ A CANCELLED run carries no list, and must not be read as "the bike has nothing".
  //      The gate watchdog aborting on a moving motorcycle reports `cancelled`, not
  //      `no-list` — correctly, it IS a cancel — and with the guard on `completion` rather
  //      than on the report, its empty list passed every damage test and emptied the file.
  //      Five stored components became zero. Driven through the shipped store below.
  const cancelled = await scratchDirectory();
  await writeFreezeFrameRead(cancelled, {
    ...base,
    completion: "complete",
    components: five,
    replies: five.map(answered),
    list: list(5),
  });
  for (const completion of ["cancelled", "failed", "no-list"] as const) {
    const wiped = await writeFreezeFrameRead(cancelled, {
      ...base,
      completion,
      components: [],
      replies: [],
      list: null,
    });
    check(!wiped.stored, `a ${completion} run that never read a list must not empty the file`);
  }
  check(
    ((await loadFreezeFrames(cancelled))?.records.length ?? 0) === 5,
    "…and the five stored components must still be there"
  );

  // (d2) a run where every component REFUSED, with nothing on disk to protect. Nothing
  //      answered, so there is nothing to store — and `7F 17 31` carries bytes, so a store
  //      that counted payloads rather than readings would write a file of refusals and then
  //      show "no answer" for every component on the tab.
  const fresh = await scratchDirectory();
  const allRefused = await writeFreezeFrameRead(fresh, {
    ...base,
    completion: "complete",
    components: five,
    replies: five.map(failed),
    list: list(5),
  });
  check(!allRefused.stored, "a run where every component refused must not be stored, even over nothing");

  // (e) the rule itself, without a filesystem.
  const previous: StoredFreezeFrameRead = {
    ...base,
    completion: "complete",
    components: five,
    replies: five.map(answered),
    list: list(5),
  };
  check(
    degradedComponents(previous, { components: five, replies: [answered(44)], list: list(5) }).join(",") ===
      "51,52,53,60",
    "every still-listed component that answered before and not now is degraded"
  );
  check(
    degradedComponents(previous, { components: [3, 4], replies: [answered(3), answered(4)], list: list(2) }).length ===
      0,
    "components the bike no longer lists are not degraded — that is what a clear looks like"
  );
  check(
    degradedComponents(null, { components: five, replies: [], list: list(5) }).length === 0,
    "a first reading degrades nothing"
  );
  // ⚠️ The conditional conjunct, stated as its own property: an UNBELIEVABLE list makes
  // every previously-answered component degraded, listed or not.
  check(
    degradedComponents(previous, {
      components: [3, 4],
      replies: [answered(3)],
      list: { ...list(2), truncated: true },
    }).join(",") === "44,51,52,53,60",
    "a list that did not parse cannot say a component is gone"
  );
  console.log("  degraded, cleared, partial, empty and garbled all resolved apart");
}

// ── §5 every committed reply, replayed ──────────────────────────────────────
console.log("── §5 the committed replies decode as the docs record them ──");
{
  let frames = 0;
  let nonFrames = 0;
  for (const entry of COMMITTED_REPLIES) {
    const decoded = decodeFreezeFrameResponse(entry.payload, entry.component);
    if (decoded.kind !== "frame") {
      nonFrames += 1;
      // The only non-frame in the archive is component 54's `57 00`, and it is not a fault.
      check(
        isNoStoredRecordReply(entry.payload),
        `${entry.label} did not decode (${decoded.kind}) and is not the two-byte "no record" reply`
      );
      continue;
    }
    frames += 1;
    check(!decoded.frame.truncated, `${entry.label} should not be truncated`);
    check(
      decoded.frame.cyclesSinceStored !== null,
      `${entry.label} should carry a cycles-since-stored byte, got ${decoded.frame.trailingHex}`
    );
  }
  // ⚠️ The COUNTS are asserted, not just the absence of failures: a replay list that had
  // silently emptied would pass every loop above without executing it once.
  check(COMMITTED_REPLIES.length === 34, `34 committed replies, found ${COMMITTED_REPLIES.length}`);
  check(frames === 33, `33 of them decode to a frame, got ${frames}`);
  check(nonFrames === 1, `exactly one is the two-byte "no record" reply, got ${nonFrames}`);

  // The 2026-09-08 table in docs/diagnostics-and-checks.md §11.3.1. ⚠️ Component 44's
  // reading that afternoon was `08`, and it is NOT here: its frames were never captured
  // (read-freeze-frame.ts bounces can0, which kills the candump), so the only committed
  // component-44 reply is the pre-clear 2026-08-08 one whose byte reads FF.
  const documented: [number, number][] = [
    [51, 0x05],
    [52, 0x05],
    [53, 0x01],
    [60, 0x05],
  ];
  for (const [component, cycles] of documented) {
    const entry = COMMITTED_REPLIES.find(
      candidate => candidate.label.startsWith("2026-09-08") && candidate.component === component
    );
    const decoded = entry ? decodeFreezeFrameResponse(entry.payload, component) : null;
    check(
      decoded?.kind === "frame" && decoded.frame.cyclesSinceStored === cycles,
      `2026-09-08 component ${component} should read ${cycles} cycles, got ${decoded?.kind === "frame" ? decoded.frame.cyclesSinceStored : decoded?.kind}`
    );
  }
  // The pre-clear saturated reading, from the same section's table.
  const before = decodeFreezeFrameResponse(payloadFor(44), 44);
  check(
    before.kind === "frame" && before.frame.cyclesSinceStored === 0xff,
    "the 2026-08-08 component-44 reply reads FF — saturated before the clear"
  );
  console.log(`  ${frames} frames + ${nonFrames} "no record", every trailing byte placed`);
}

// ── §6 the bounds gate over every committed field ───────────────────────────
console.log("── §6 no captured reading is drawn as a fault ──");
{
  let slots = 0;
  let valued = 0;
  let refusedScaling = 0;
  let ungated = 0;
  const rejected: string[] = [];
  for (const entry of COMMITTED_REPLIES) {
    const decoded = decodeFreezeFrameResponse(entry.payload, entry.component);
    if (decoded.kind !== "frame") {
      continue;
    }
    for (const value of decoded.frame.values) {
      slots += 1;
      // ⚠️ THE SHIPPED DECISION, not a copy of it. `infokeyFault` is what
      // public/views/recorded-values.js calls, so a change to how a field is judged reddens
      // this section rather than quietly reaching the phone.
      //
      // ⚠️ "Gate the scaled value, never the raw one" is enforced by that function's
      // SIGNATURE — it is handed no `raw` to gate — rather than by anything here. What this
      // section pins is the other half: that a field whose scaling this repo refuses is its
      // own outcome (`AvgDOD`'s malformed equation, `TotalExchangedAh`'s impossible result)
      // and does not fall through into the range test.
      const fault = infokeyFault(value);
      if (fault?.kind === "scaling-refused") {
        refusedScaling += 1;
        continue;
      }
      valued += 1;
      if (boundsForInfokey(value.name, value.unit) === null) {
        ungated += 1;
        continue;
      }
      if (fault?.kind === "out-of-range") {
        rejected.push(
          `${entry.label} ${value.name} = ${value.value} ${value.unit} outside [${fault.bounds[0]}, ${fault.bounds[1]}]`
        );
      }
    }
  }
  // ⚠️ The census is asserted, not only the zero. A decoder that produced no fields at all
  // would satisfy "nothing was rejected" while having checked nothing.
  check(slots === 211, `211 field slots across the committed replies, counted ${slots}`);
  check(valued === 207, `207 of them carry a scaled value, counted ${valued}`);
  check(refusedScaling === 4, `4 have a scaling this repo refuses, counted ${refusedScaling}`);
  check(ungated === 103, `103 have no bound at all, counted ${ungated}`);
  check(rejected.length === 0, `no captured reading may be drawn as a fault:\n    ${rejected.join("\n    ")}`);

  // …and the gate still WORKS. A sentinel the captures cannot supply, because every mA
  // infokey is a uint16_t and BY_UNIT's mA rule is ±100 000 — it can reject nothing the
  // field can hold, which is why the aliases exist.
  const withSentinel = decodeFreezeFrameResponse(componentSixtyTwoWithSentinel(), 62);
  const field =
    withSentinel.kind === "frame"
      ? withSentinel.frame.values.find((value: FreezeFrameValue) => value.name === "P_I12")
      : undefined;
  const sentinelFault = field ? infokeyFault(field) : null;
  check(
    field?.value === 65535 && sentinelFault?.kind === "out-of-range",
    `a 0xFFFF P_I12 must be drawn as a fault, got ${field?.value} judged ${sentinelFault?.kind ?? "fine"}`
  );
  console.log(
    `  ${slots} slots · ${valued} valued · ${refusedScaling} scaling-refused · ${ungated} ungated · 0 rejected`
  );
}

// ── §7 the expected-fault list ──────────────────────────────────────────────
console.log("── §7 the expected-fault list round-trips ──");
{
  const directory = await scratchDirectory();
  check((await loadExpectedFaults(directory)).entries.length === 0, "a Pi with no file has an empty list");
  await setExpectedFault(directory, { component: 34, symptom: 1 }, true);
  await setExpectedFault(directory, { component: 39, symptom: 1 }, true);
  // Idempotent: the toggle is on a phone over a link that drops, so a repeat must not
  // produce a second entry.
  await setExpectedFault(directory, { component: 34, symptom: 1 }, true);
  const marked = await loadExpectedFaults(directory);
  check(marked.entries.length === 2, `two entries after a repeat, got ${marked.entries.length}`);
  await setExpectedFault(directory, { component: 34, symptom: 1 }, false);
  const unmarked = await loadExpectedFaults(directory);
  check(unmarked.entries.length === 1, `one entry after unmarking, got ${unmarked.entries.length}`);
  check(unmarked.entries[0].component === 39, "the right one survived");

  // ⚠️ CONCURRENT writes to different codes, which is two quick taps on a phone. Both read
  // the same list before either writes it, so without serialisation the second rename lands
  // over the first and a mark disappears with nothing logged.
  const racy = await scratchDirectory();
  await Promise.all([
    setExpectedFault(racy, { component: 3, symptom: 0 }, true),
    setExpectedFault(racy, { component: 4, symptom: 0 }, true),
    setExpectedFault(racy, { component: 5, symptom: 0 }, true),
  ]);
  const raced = await loadExpectedFaults(racy);
  check(raced.entries.length === 3, `three concurrent marks must all survive, got ${raced.entries.length}`);

  await writeFile(join(directory, "expected-faults.json"), "{ not json", "utf8");
  check(
    (await loadExpectedFaults(directory)).entries.length === 0,
    "a damaged file reads as empty rather than throwing"
  );
  console.log("  marked, repeated, unmarked, and a damaged file survived");
}

// ── §8 the budget's two relationships ───────────────────────────────────────
console.log("── §8 the budget is inside the hold and still worth having ──");
{
  // ⚠️ TWO INDEPENDENT claims, not one written twice. The first says a component in flight
  // when the deadline fires still finishes before the poller takes the bus back; the second
  // says the budget is big enough to be a budget. A margin of 10 000 ms passes the first
  // and fails the second.
  check(
    FREEZE_FRAME_READ_BUDGET_MS + WORST_CASE_COMPONENT_MS <= MAX_HOLD_MS,
    `a component starting at the deadline must finish inside the hold: ${FREEZE_FRAME_READ_BUDGET_MS} + ${WORST_CASE_COMPONENT_MS} > ${MAX_HOLD_MS}`
  );
  check(
    FREEZE_FRAME_READ_BUDGET_MS >= 4 * WORST_CASE_COMPONENT_MS,
    `the budget must fit at least four components: ${FREEZE_FRAME_READ_BUDGET_MS} < ${4 * WORST_CASE_COMPONENT_MS}`
  );
  // ⚠️ THE TERMS, NOT THE RATIO, and this is the assertion the other two cannot make.
  // Everything else here is a MULTIPLE of `WORST_CASE_COMPONENT_MS` — §2's injected clock
  // advances by it and its budget is 4× it — so understating the constant just makes the
  // simulated bike proportionally faster and no count moves. Review proved that: swapping
  // `worstCaseMultiFrameReadMs(2)` for `(1)` left this suite green at 1020 ms. The literals
  // below are the transport's own four numbers, spelled out, so a timeout change that this
  // deadline no longer describes fails HERE rather than on a bike.
  //
  //   session open   DEFAULT_RESPONSE_TIMEOUT_MS 300 + DEFAULT_PACE_MS 10        =  310
  //   per attempt    firstReplyTimeoutMs 300 + transferTimeoutMs 400 + pace 10   =  710
  //   one component  310 + 2 × 710                                               = 1730
  //   the 0x18       310 + 1 × 710                                               = 1020
  check(
    WORST_CASE_COMPONENT_MS === 1730,
    `one component's worst case must be 310 + 2 × 710 = 1730 ms, got ${WORST_CASE_COMPONENT_MS} — either a ` +
      "transport timeout moved and this deadline no longer describes it, or the attempt count did"
  );
  check(WORST_CASE_LIST_MS === 1020, `the 0x18's worst case must be 310 + 710 = 1020 ms, got ${WORST_CASE_LIST_MS}`);
  console.log(
    `  budget ${FREEZE_FRAME_READ_BUDGET_MS} ms · worst component ${WORST_CASE_COMPONENT_MS} ms · hold cap ${MAX_HOLD_MS} ms`
  );
}

for (const directory of temporaryDirectories) {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ the 0x18 list is filtered before anything is asked, the deadline stops the read while a component still " +
    "fits, the store refuses to lose a component the bike still lists, and no captured reading is drawn as a fault"
);
