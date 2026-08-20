import { decodeFreezeFrameResponse, formatFreezeFrameValue } from "../src/diagnostics/freeze-frame.ts";
import {
  describeFreezeFrameLogResult,
  formatFreezeFrameLogBlocks,
  startFreezeFrameLogRead,
} from "../src/vcu/freeze-frame-log.ts";
import { createVcuKwpClient, type VcuMultiFrameOutcome } from "../src/vcu/kwp-client.ts";
import { decodeMultiFrameReply, decodeStoredDtcList, toHex } from "../src/vcu/multiframe-codec.ts";
import { kwpResponseCanIds } from "../src/vcu/param-codec.ts";

// The first live test for the multi-frame KWP transport. **This is the only way to
// run it against the bike**, and it exists because the read cannot be done by hand:
// a First Frame has to be answered with a flow-control frame within milliseconds
// (src/can/obd-dtc.ts measured 4/12 transfers completing at 0 ms of added delay and
// 1/12 at 40 ms), which is not something you can type into `cansend` in time.
//
//   node --experimental-strip-types scripts/read-freeze-frame.ts --list
//   node --experimental-strip-types scripts/read-freeze-frame.ts --component 44
//   node --experimental-strip-types scripts/read-freeze-frame.ts --log
//
// ── ⚠️ READ THIS BEFORE RUNNING IT ─────────────────────────────────────────
//  • **Stop the service first**: `sudo systemctl stop cool-eva`. It holds its own socket
//    on can0, and two testers on one bus is how you get a reply matched to the wrong
//    request — these micros answer on ONE id with no request tag.
//  • **It does NOT bring up can0**, deliberately: `bringUpCan` takes the interface DOWN
//    first, killing every other socket on it. Bring it up yourself, ACTIVE (not
//    listen-only), or nothing transmits — the three commands are in the doc below.
//  • **Park the bike.** No service gate on this script, so that judgement is yours.
//  • **Run it detached** over ssh; a link drop has already cost a whole result set.
//    docs/diagnostics-and-checks.md §13.
//
// ⚠️ EVERY REPLY IS PRINTED AS RAW HEX FIRST, and that is the point of the run rather
// than the decode: the REQUEST bytes are all captured now (docs/vcu-parameters.md §10),
// but the reply LAYOUT of all three services is still unverified, so the bytes are the
// evidence and the decode is a hypothesis printed beside them. If they disagree, the
// bytes are right.
//
// ⚠️ READ-ONLY. Everything goes through the same closed union as the rest of the
// client: `0x10`, `0x3E`, `0x17`, `0x18`, `0x35`, `0x36`, `0x37`. There is no argument
// that names a service and none that names a value.

const CAN_IFACE = process.env.CAN_IFACE ?? "can0";

/** What this run was asked to do. Closed, so an unrecognised flag is refused rather than defaulted. */
type Job = { kind: "list" } | { kind: "freeze-frame"; component: number } | { kind: "log"; maxBlocks: number | null };

const job = parseArguments(process.argv.slice(2));
if (!job) {
  console.error(
    [
      "usage: read-freeze-frame.ts <one of>",
      "  --list                 0x18 — which components have a stored code. Start here.",
      "  --component <1-63>     0x17 — one component's freeze frame.",
      "  --log [--max <n>]      0x35/0x36/0x37 — the whole stored log. Minutes, and cancellable with Ctrl-C.",
      "",
      "Stop the cool-eva service first, and bring can0 up ACTIVE yourself — see the header.",
    ].join("\n")
  );
  process.exit(2);
}

// Imported HERE rather than at the top, and after the arguments are known.
// `socketcan` is a Linux-only optionalDependency, so a static import makes this
// script unrunnable on a laptop — it would die on module load before it could so
// much as print its own usage. src/can/socket.ts is the one place in the repo that
// imports it at runtime (CLAUDE.md), and deferring keeps that true.
console.log(`kwp: opening ${CAN_IFACE} (not configuring it — see the header)`);
const { openChannel } = await import("../src/can/socket.ts");
const channel = openChannel(CAN_IFACE);
const client = createVcuKwpClient(channel);
const responseCanIds = new Set(kwpResponseCanIds());
channel.addListener("onMessage", message => {
  if (responseCanIds.has(message.id)) {
    client.handleFrame(message.id, message.data);
  }
});
channel.start();

// Ctrl-C has to reach the read rather than the process, or a bulk transfer dies
// with the micro still holding an open upload — the one state this whole path is
// careful to avoid.
let cancelCurrentRead: ((reason: string) => void) | null = null;
process.on("SIGINT", () => {
  if (cancelCurrentRead) {
    console.log("\nkwp: stopping — the transfer will still be closed with 0x37");
    cancelCurrentRead("Ctrl-C");
    cancelCurrentRead = null;
    return;
  }
  client.stop();
  process.exit(130);
});

switch (job.kind) {
  case "list":
    await runList();
    break;
  case "freeze-frame":
    await runFreezeFrame(job.component);
    break;
  case "log":
    await runLog(job.maxBlocks);
    break;
}

client.stop();
channel.stop();

/** `0x18` — the cheap first question: which components have a code at all. */
async function runList(): Promise<void> {
  console.log("\n── 0x18 ReadDTCByStatus on A8 — which components have a stored code ──");
  const outcome = await client.multiFrameRead("A8", { kind: "list-stored-dtcs" });
  if (!reportRaw(outcome, "0x18")) {
    return;
  }
  const reply = decodeMultiFrameReply(outcome.payload, 0x58);
  if (reply.kind !== "positive") {
    console.log(`  reply: ${reply.kind === "refused" ? reply.description : reply.reason}`);
    return;
  }
  const list = decodeStoredDtcList(reply.body);
  console.log(`  declared ${list.declaredCount} record(s), parsed ${list.records.length}`);
  for (const record of list.records) {
    const padding = record.code === 0 && record.status === 0 ? "   ← padding, per the service tool" : "";
    console.log(`    code ${record.code} (0x${record.code.toString(16)})  status 0x${hex(record.status)}${padding}`);
  }
  // The two tells that say whether the inferred 3-byte record layout is right.
  console.log(
    `  trailingHex: "${list.trailingHex}"  ${list.trailingHex === "" ? "✅ layout fits" : "⚠️ LAYOUT WRONG"}`
  );
  if (list.truncated) {
    console.log("  ⚠️ fewer whole records than declared — the record width is probably not 3");
  }
  console.log("\n  → Ask 0x17 about the codes listed above rather than guessing components.");
}

/** `0x17` — one component's freeze frame, decoded through the tables from #62. */
async function runFreezeFrame(component: number): Promise<void> {
  console.log(`\n── 0x17 ReadDTCInformation on A8, component ${component} ──`);
  const outcome = await client.multiFrameRead("A8", { kind: "read-freeze-frame", component });
  if (!reportRaw(outcome, "0x17")) {
    return;
  }
  const decoded = decodeFreezeFrameResponse(outcome.payload, component);
  if (decoded.kind !== "frame") {
    console.log(`  ${decoded.kind}: ${"reason" in decoded ? decoded.reason : ""}`);
    console.log(`  raw: ${decoded.rawHex}`);
    return;
  }
  const { frame } = decoded;
  for (const value of frame.values) {
    console.log(`    ${formatFreezeFrameValue(value)}`);
  }
  // ⚠️ THE THREE NUMBERS THIS WHOLE RUN EXISTS FOR. The reply layout was never
  // captured, and these are what settle it — see src/diagnostics/freeze-frame.ts.
  console.log("\n  ── the layout tells ──");
  console.log(
    `  headerBytesThatFit: [${frame.headerBytesThatFit.join(", ")}]  ` +
      (frame.headerBytesThatFit.includes(5)
        ? "✅ 5 — the implemented reading is right"
        : frame.headerBytesThatFit.includes(4)
          ? "⚠️ 4 — shift everything by one, change FREEZE_FRAME_HEADER_BYTES"
          : "🚨 neither — the layout is something else again")
  );
  console.log(`  trailingHex: "${frame.trailingHex}"  ${frame.trailingHex === "" ? "✅ nothing left over" : "⚠️"}`);
  console.log(`  recordCount: ${frame.recordCount} (expected 1)   truncated: ${frame.truncated}`);
}

/** `0x35`/`0x36`/`0x37` — the whole stored log. Minutes. */
async function runLog(maxBlocks: number | null): Promise<void> {
  console.log("\n── 0x35/0x36/0x37 bulk freeze-frame log on A8 ──");
  console.log("  ⚠️ The factory tool took ~7 minutes for 1198 blocks. Ctrl-C stops it cleanly.");
  const running = startFreezeFrameLogRead({
    client,
    maxBlocks: maxBlocks ?? undefined,
    onProgress: progress => {
      if (progress.blocks % 25 === 0) {
        console.log(
          `  … ${progress.blocks} blocks, ${progress.bytes} bytes, ${(progress.elapsedMs / 1000).toFixed(0)} s`
        );
      }
    },
  });
  cancelCurrentRead = running.cancel;
  const result = await running.finished;
  cancelCurrentRead = null;

  console.log(`\n  ${describeFreezeFrameLogResult(result)}`);
  if (result.grant) {
    console.log(
      `  grant: "${result.grant.rawHex}" ${result.grant.asCaptured ? "✅ as captured" : "⚠️ NOT the captured 12 E9"}`
    );
  }
  // Every block, raw. This is the artifact worth keeping from the run — the record
  // layout is undecoded on purpose, so these bytes are what a decoder gets written
  // against.
  console.log("\n  ── blocks, raw ──");
  for (const line of formatFreezeFrameLogBlocks(result)) {
    console.log(`  ${line}`);
  }
}

/**
 * Prints the raw reply and says whether there is one. Returns a narrowed outcome so
 * the caller can decode, or false when there is nothing to decode.
 *
 * Raw bytes first, always, and before any interpretation: every reply layout on this
 * channel is unverified, so the hex is the result of the run and the decode is a
 * hypothesis about it.
 */
function reportRaw(
  outcome: VcuMultiFrameOutcome,
  service: string
): outcome is Extract<VcuMultiFrameOutcome, { status: "reply" }> {
  switch (outcome.status) {
    case "reply":
      console.log(`  RAW: ${toHex(outcome.payload)}`);
      console.log(
        `  (${outcome.payload.length} bytes; flow control from the micro: ${outcome.sawFlowControlFromMicro})`
      );
      return true;
    case "no-response":
      console.log(`  ${service}: NO REPLY, stalled at ${outcome.stage}. Not the same claim as "there is nothing".`);
      return false;
    case "abandoned":
      console.log(`  ${service}: reply DISCARDED as unusable — ${outcome.reason}`);
      console.log("  This is the transport refusing to invent bytes. Worth reporting with the candump.");
      return false;
    case "no-session":
      console.log(`  ${service}: ${outcome.reason} — is the bike awake, and is can0 ACTIVE rather than listen-only?`);
      return false;
    case "cancelled":
      console.log(`  ${service}: cancelled — ${outcome.reason}`);
      return false;
    case "not-sent":
      console.log(`  ${service}: never reached the bus — ${outcome.reason}`);
      return false;
  }
}

/** Reads argv into a job, or null when it does not name exactly one. */
function parseArguments(args: string[]): Job | null {
  if (args.includes("--list")) {
    return { kind: "list" };
  }
  const componentIndex = args.indexOf("--component");
  if (componentIndex !== -1) {
    const component = Number(args[componentIndex + 1]);
    if (!Number.isInteger(component)) {
      return null;
    }
    // The range check lives in the encoder and throws there; this only catches a
    // missing argument, so a typo cannot become "component NaN".
    return { kind: "freeze-frame", component };
  }
  if (args.includes("--log")) {
    const maxIndex = args.indexOf("--max");
    if (maxIndex === -1) {
      return { kind: "log", maxBlocks: null };
    }
    const maxBlocks = Number(args[maxIndex + 1]);
    return Number.isInteger(maxBlocks) && maxBlocks > 0 ? { kind: "log", maxBlocks } : null;
  }
  return null;
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}
