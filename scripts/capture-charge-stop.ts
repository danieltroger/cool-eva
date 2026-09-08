import { decodeFrame } from "../src/can/decode.ts";
import { monotonicNow, since } from "../src/monotonic.ts";

// Reverse-engineers the "stop charging" command by isolating the CAN frame the dash sends
// when the rider HOLDS THE MODE BUTTON to end a charge. That command is not in the ride log:
// stop is a 0x121 frame with b3 = 0, and decodeChargeSetpointFrame drops every b3 ≠ 1 frame
// (charge-setpoint.ts), so nothing decoded is ever written for it. The only way to see it is
// to watch the raw bus at the moment of the press — which is what this does, LISTEN-ONLY.
//
//   sudo systemctl stop cool-eva     # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/capture-charge-stop.ts [--baseline S] [--window S]
//     --baseline S   seconds to learn the bus's normal traffic first (default 8)
//     --window S     seconds to watch for the stop after the baseline (default 60)
//
// It transmits NOTHING. It first spends `baseline` seconds learning every (id, payload) the
// bus normally carries, then prints "HOLD MODE NOW" and for `window` seconds reports only
// frames that are NEW — an id/payload not seen in the baseline — which is where a discrete
// rider action like a button-hold shows up. Analog telemetry (voltages, currents winding
// down) is filtered out: an id that showed many distinct payloads during the baseline is
// treated as noisy and suppressed, so the stop command is not buried under counting bytes.
// 0x121 and its request twin 0x120 are ALWAYS reported in full — they are the known dash↔VCU
// command channel and the prime suspects — regardless of the noisy filter.

const CHARGE_COMMAND_IDS = new Set([0x120, 0x121]);
// An id that carried more than this many distinct payloads while merely observing is analog
// or a counter, not a command — its "new" frames at stop time are noise, so it is suppressed
// from the novelty report (but 0x120/0x121 are always shown regardless).
const NOISY_DISTINCT_PAYLOADS = 4;

const options = parseArguments(process.argv.slice(2));

// Dynamic import so --help-less arg parsing above still runs on macOS/CI, where socketcan
// (a Linux-only optionalDependency) is not built. Only the capture itself needs the native module.
const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("\nbringing can0 up LISTEN-ONLY (no TX)…");
await bringUpCan("can0", false);
const channel = openChannel("can0");

/** Every distinct payload seen per id during the baseline — the bus's "normal". */
const baselinePayloadsById = new Map<number, Set<string>>();
/** The last payload printed per id in the window, to collapse a frame that simply repeats. */
const lastReportedById = new Map<number, string>();
/** Novel frames seen in the window, keyed id:hex, with a count and first-seen offset. */
const novelFrames = new Map<string, { id: number; payload: string; count: number; firstSeenSeconds: string }>();

let phase: "baseline" | "window" = "baseline";
const started = monotonicNow();

channel.addListener("onMessage", message => {
  const payload = hex(message.data);
  if (phase === "baseline") {
    recordBaseline(message.id, payload);
    return;
  }
  reportIfNovel(message.id, payload, message.data);
});
channel.start();

console.log(`\nlearning the bus for ${options.baselineSeconds}s — leave the bike charging, do NOTHING…`);
await sleep(options.baselineSeconds * 1000);

phase = "window";
console.log("\n" + "=".repeat(60));
console.log(`▶ HOLD THE MODE BUTTON NOW to stop charging. Watching for ${options.windowSeconds}s…`);
console.log("=".repeat(60) + "\n");
await sleep(options.windowSeconds * 1000);

printSummary();
process.exit(0);

// ── helpers ──────────────────────────────────────────────────────────────────

function recordBaseline(id: number, payload: string): void {
  let payloads = baselinePayloadsById.get(id);
  if (!payloads) {
    payloads = new Set();
    baselinePayloadsById.set(id, payloads);
  }
  payloads.add(payload);
}

function reportIfNovel(id: number, payload: string, data: Buffer): void {
  const isCommandChannel = CHARGE_COMMAND_IDS.has(id);
  const seenInBaseline = baselinePayloadsById.get(id)?.has(payload) ?? false;
  if (seenInBaseline && !isCommandChannel) {
    return;
  }
  // A high-cardinality id is analog telemetry, not a command — skip unless it is the command
  // channel, which we always want to see in full even though it is quiet.
  const distinctInBaseline = baselinePayloadsById.get(id)?.size ?? 0;
  if (!isCommandChannel && distinctInBaseline > NOISY_DISTINCT_PAYLOADS) {
    return;
  }

  const frameKey = `${id.toString(16)}:${payload}`;
  const existing = novelFrames.get(frameKey);
  if (existing) {
    existing.count += 1;
  } else {
    const firstSeenSeconds = (since(started) / 1000).toFixed(1);
    novelFrames.set(frameKey, { id, payload, count: 1, firstSeenSeconds });
  }

  // Print each newly-distinct payload once as it happens, so a live watcher sees the press land;
  // a bare repeat of the just-printed frame on this id is collapsed to keep the stream readable.
  if (lastReportedById.get(id) === payload) {
    return;
  }
  lastReportedById.set(id, payload);
  console.log(
    `t+${(since(started) / 1000).toFixed(1)}s  0x${id.toString(16).padStart(3, "0")}  ${payload}  ${annotate(id, data)}`
  );
}

function annotate(id: number, data: Buffer): string {
  // A 0x121-family frame is the prime suspect, so call out its opcode/flag explicitly; for any
  // other id, show what the existing decoders make of it, which is empty for the stop frame
  // (b3 = 0 is dropped) but names the signal for anything already understood.
  if (CHARGE_COMMAND_IDS.has(id)) {
    return `(command channel — b0 opcode 0x${data[0]?.toString(16) ?? "??"}, b3 ${data[3] ?? "?"})`;
  }
  const decoded = decodeFrame(id, data);
  return decoded.length === 0 ? "(undecoded)" : decoded.map(value => `${value.key}=${value.value}`).join(" ");
}

function printSummary(): void {
  console.log("\n" + "=".repeat(60));
  console.log("CAPTURE SUMMARY — frames the Mode-hold introduced (not in baseline):");
  console.log("=".repeat(60));
  if (novelFrames.size === 0) {
    console.log("\n  nothing novel seen. The stop may ride on an id whose analog traffic masked");
    console.log("  it, or the press did not land in the window. Re-run with a longer --window,");
    console.log("  or watch 0x121 directly with probe-charge-command.ts --listen.\n");
    return;
  }
  const rows = Array.from(novelFrames.values()).sort((left, right) => {
    if (left.id !== right.id) {
      return left.id - right.id;
    }
    return right.count - left.count;
  });
  for (const row of rows) {
    const tag = CHARGE_COMMAND_IDS.has(row.id) ? "  ← command channel" : "";
    console.log(
      `\n  0x${row.id.toString(16).padStart(3, "0")}  ${row.payload}` +
        `\n        first t+${row.firstSeenSeconds}s, seen ${row.count}×${tag}`
    );
  }
  console.log("\nThe stop command is the discrete frame that appeared at the moment you held Mode —");
  console.log("most likely on 0x121 with a b0 opcode other than 0x18/0x1A and b3 = 0. Record the");
  console.log("exact bytes in docs/can-0x121-charge-command.md before building a transmitter for it.\n");
}

function hex(bytes: Buffer): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" ");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface Options {
  baselineSeconds: number;
  windowSeconds: number;
}

function parseArguments(argv: string[]): Options {
  let baselineSeconds = 8;
  let windowSeconds = 60;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--baseline") {
      baselineSeconds = Number(argv[++index]);
    } else if (flag === "--window") {
      windowSeconds = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument ${flag}. See the header for options.`);
    }
  }
  if (!Number.isFinite(baselineSeconds) || baselineSeconds < 1) {
    throw new Error(`--baseline must be a positive number of seconds, got ${baselineSeconds}`);
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) {
    throw new Error(`--window must be a positive number of seconds, got ${windowSeconds}`);
  }
  return { baselineSeconds, windowSeconds };
}
