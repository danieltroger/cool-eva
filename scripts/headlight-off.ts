import { canIdsFor, parseResponseFrame } from "../src/vcu/param-codec.ts";

// Probes — and, with a force flag, exercises — the UDS InputOutputControl (0x2F) route that
// the manufacturer's service tool uses to drive the VCU's body outputs (headlight, indicators, horn, …). See
// docs/headlight-diagnostic-control.md. This is the general io_set/io_get harness the on-bike RE
// needs; --off/--on are just the headlight preset (control 17).
//
//   sudo systemctl stop cool-eva     # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/headlight-off.ts                 # recon: read beam
//   sudo node --experimental-strip-types scripts/headlight-off.ts --off|--on [--hold 15] [--cadence 5] [--watch]
//   sudo node --experimental-strip-types scripts/headlight-off.ts --control 5 --value 255 --hold 6
//   sudo node --experimental-strip-types scripts/headlight-off.ts --node A9 --control 17 --value 0
//
// ⚠️ Deliberately crosses this repo's standing ban on transmitting 0x27/0x2F — every shipped path
// refuses those. This is a SCRATCH probe, same footing as probe-charge-stop.ts. It builds its own
// frames but reuses param-codec's on-bike-PROVEN framing: extended-addressed single frames on
// 0x7C0, replies addressed to the tester (0xF1) on 0x7E0.
//
// Default (no --value / --off / --on) is READ-ONLY: open a session, unlock SecurityAccess, then
// read the control's commanded output (sub 0x00) and its sense (sub 0x01). A force then sets the
// output. The io_set override is a SHORT PULSE that decays in well under 40 ms (measured on-bike),
// so --off/--on hold the output by re-asserting the force every --cadence ms (default 5); a single
// force just blinks. Release = stop re-asserting (the pulse lapses) or StopDiagnosticSession on exit
// (there is no returnControlToECU — sub 0x00 is a getter). --watch reads the sense each second
// during a hold, but each read pauses the re-assert long enough to blink the output — so it is off
// by default. See docs/headlight-diagnostic-control.md for the confirmed on-bike results.
//
// PRECONDITIONS for a force: motorcycle on its stand, key ON, clear of moving parts, not ridden.

const DEFAULT_NODE = "A8"; // VCU-Safety — the micro that drives the body outputs (ecu 168 in the guided-test tables)
const TARGET_ADDRESS = { A8: 0xa8, A9: 0xa9 } as const;

const SERVICE_START_SESSION = 0x10;
const STANDARD_SESSION = 0x81; // the VCU's session type, per the decompile
const SERVICE_STOP_SESSION = 0x20;
const SERVICE_SECURITY = 0x27;
const SERVICE_IO_CONTROL = 0x2f;
const NEGATIVE_RESPONSE = 0x7f;

// SecurityAccess sub-functions: odd = requestSeed, even = sendKey, per level.
const SECURITY_REQUEST_SEED = 0x01;
const SECURITY_SEND_KEY = 0x02;

// IOControl sub-commands (UDS 0x2F), as the service tool uses them.
const IO_SET = 0x07; // shortTermAdjustment
const IO_GET_OUTPUT = 0x00; // commanded output state
const IO_GET_READING = 0x01; // live current sense

// The io_set override is a brief pulse that decays fast — measured on-bike, the beam STROBES at a
// 40 ms re-assert (override lapses between pulses) but holds STEADILY off at 5 ms. TesterPresent
// keeps the *session*, not the *override*; to HOLD an output steady we re-send the io_set faster
// than it decays. Each re-send also keeps the session alive. Tunable via --cadence; 5 ms is the
// proven-steady value (the strobe→steady threshold is somewhere between 5 and 40 ms).
const DEFAULT_REASSERT_MS = 5;

// Headlight preset: the service tool's LIGHTS table (from a model's controls definition, which is NOT in
// the decompiled analysis — so these ids may not match this Eva Ribelle; that is what we're testing).
const BEAM_OUTPUT_CONTROL = 17; // "Low + high beam"
const BEAM_SENSE_CONTROL = 18; // its current sense

// The VCU family's SecurityAccess key: swap adjacent bits of the 32-bit seed, then subtract
// 0x3E5F4542 (KWP2000MotoSA.CalculateSecurityKey; fixed per module). Confirmed on this bike.
const KEY_SUBTRAHEND = 0x3e5f4542;

const NRC_NAMES: Record<number, string> = {
  0x12: "subFunctionNotSupported",
  0x22: "conditionsNotCorrect",
  0x31: "requestOutOfRange",
  0x33: "securityAccessDenied",
  0x78: "responsePending",
};

interface Reply {
  ok: boolean;
  service: number | null; // positive service byte (request + 0x40), or null for negative/timeout
  negativeCode: number | null;
  payload: Uint8Array; // excludes the address and PCI byte; includes the service byte
}

const options = parseArguments(process.argv.slice(2));
const targetAddress = TARGET_ADDRESS[options.node];
const { request: REQUEST_CAN_ID, response: RESPONSE_CAN_ID } = canIdsFor(options.node);

console.log(
  `headlight/IO probe — target VCU-${options.node === "A8" ? "Safety" : "Control"} (0x${targetAddress.toString(16)}) on ${hexId(REQUEST_CAN_ID)}/${hexId(RESPONSE_CAN_ID)}`
);
if (options.forceValue === null) {
  console.log(
    `mode: READ-ONLY recon — reading control ${options.control} (sense ${options.sense}). Nothing is switched.`
  );
} else {
  console.log(
    `mode: FORCE — control ${options.control} := ${options.forceValue}, sense ${options.sense}, hold ${options.holdSeconds}s`
  );
  console.log(
    "⚠️  Bike on its stand, key ON, clear of moving parts. Ctrl-C ends the session and hands the output back."
  );
}

// Dynamic import so arg parsing works on macOS/CI where socketcan is not built.
const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("\nbringing can0 up ACTIVE (TX enabled)…");
await bringUpCan("can0", true);
const channel = openChannel("can0");

let pending: ((reply: Reply) => void) | null = null;
channel.addListener("onMessage", message => {
  if (message.id !== RESPONSE_CAN_ID || pending === null) {
    return;
  }
  const frame = parseResponseFrame(Uint8Array.from(message.data));
  if (frame.kind !== "payload") {
    return; // multi-frame (none expected here) or another tester's traffic
  }
  const reply = interpret(frame.payload);
  if (reply.negativeCode === 0x78) {
    // responsePending: the micro is asking for more time; keep waiting, do not resolve.
    console.log("    … responsePending (0x78), waiting");
    return;
  }
  const resolve = pending;
  pending = null;
  resolve(reply);
});
channel.start();

// Declared before the top-level runSequence() call: `let` is not hoisted, so holdSession()
// reading it earlier would hit the temporal dead zone.
let aborted = false;
process.on("SIGINT", () => {
  aborted = true;
  console.log("\n(Ctrl-C) releasing…");
});

await runSequence();

process.exit(0);

// ── the sequence ───────────────────────────────────────────────────────────────

async function runSequence(): Promise<void> {
  console.log("\n→ StartDiagnosticSession (10 81)");
  const session = await transact([SERVICE_START_SESSION, STANDARD_SESSION]);
  if (!session.ok) {
    console.log(`  ✗ ${options.node} refused the session: ${describe(session)}`);
    console.log("    Without a session nothing here can proceed. Is the key ON and the bike awake?");
    return;
  }
  console.log("  ✓ session open");

  if (!(await unlock())) {
    return;
  }

  if (options.sweepMax !== null) {
    await sweep(options.sweepMax);
    await stopSession();
    return;
  }

  await readControl("before");

  if (options.forceValue === null) {
    console.log("\nrecon complete — session + SecurityAccess granted, control readable. Nothing was switched.");
    await stopSession();
    return;
  }

  console.log(`\n→ InputOutputControl set: output ${options.control} := ${options.forceValue}`);
  const forced = await ioSetWithRelockRetry(options.control, options.forceValue);
  if (!forced.ok) {
    console.log(`  ✗ force refused: ${describe(forced)}`);
    await stopSession();
    return;
  }
  console.log(`  ✓ force accepted — reply ${hex(forced.payload)}`); // raw bytes: confirm a true positive 6F echo, not a quirk
  await holdForce(options.control, options.forceValue, options.holdSeconds);
  await stopSession();
}

/**
 * Read-only map of every output/sense id in [1..maxId]: its commanded output (sub 0x00) and its
 * live reading (sub 0x01). Finds which output is actually driving a load right now — the beam's
 * real id is whichever reads a non-zero commanded output and carries the ~3.5 A we measured on
 * sense 18. Nothing is forced. Short per-id timeout so a wall of non-responding ids stays quick.
 */
async function sweep(maxId: number): Promise<void> {
  console.log(`\n→ SWEEP ids 1..${maxId} (read-only: commanded output + sense per id)`);
  for (let id = 1; id <= maxId; id += 1) {
    const output = await transact([SERVICE_IO_CONTROL, ...controlBytes(id), IO_GET_OUTPUT], {
      timeoutMs: 200,
      quietTimeout: true,
    });
    const reading = await transact([SERVICE_IO_CONTROL, ...controlBytes(id), IO_GET_READING], {
      timeoutMs: 200,
      quietTimeout: true,
    });
    if (!output.ok && !reading.ok) {
      continue; // id not present on this node — skip silently to keep the map readable
    }
    const outputText = output.ok
      ? `cmd=${ioValue(output.payload)} [${hex(output.payload)}]`
      : `cmd=${describe(output)}`;
    const readingText = reading.ok
      ? `read=${ioValue(reading.payload)} [${hex(reading.payload)}]`
      : `read=${describe(reading)}`;
    console.log(`  id ${String(id).padStart(3)}: ${outputText.padEnd(34)} ${readingText}`);
  }
  console.log("sweep complete.");
}

async function unlock(): Promise<boolean> {
  console.log("\n→ SecurityAccess: request seed (27 01)");
  const seedReply = await transact([SERVICE_SECURITY, SECURITY_REQUEST_SEED]);
  if (!seedReply.ok || seedReply.payload.length < 6) {
    console.log(`  ✗ seed refused: ${describe(seedReply)}`);
    return false;
  }
  const seed = readUint32(seedReply.payload, 2);
  if (seed === 0) {
    console.log("  ✓ already unlocked (seed = 0)");
    return true;
  }
  const key = calcKey(seed);
  console.log(`  seed 0x${seed.toString(16).padStart(8, "0")} → key 0x${key.toString(16).padStart(8, "0")}`);
  const keyReply = await transact([SERVICE_SECURITY, SECURITY_SEND_KEY, ...uint32Bytes(key)]);
  if (!keyReply.ok) {
    console.log(`  ✗ key rejected: ${describe(keyReply)}`);
    console.log("    (If this is securityAccessDenied, the algorithm or seed width is wrong for this micro.)");
    return false;
  }
  console.log("  ✓ unlocked");
  return true;
}

/** Read the control's commanded output (sub 0) and its sense (sub 1). Non-destructive. */
async function readControl(label: string): Promise<void> {
  const output = await transact([SERVICE_IO_CONTROL, ...controlBytes(options.control), IO_GET_OUTPUT]);
  const sense = await transact([SERVICE_IO_CONTROL, ...controlBytes(options.sense), IO_GET_READING]);
  const outputText = output.ok ? `${ioValue(output.payload)} [${hex(output.payload)}]` : describe(output);
  const senseText = sense.ok ? `${ioValue(sense.payload)} mA [${hex(sense.payload)}]` : describe(sense);
  console.log(
    `  [${label}] output ${options.control} commanded = ${outputText}; sense ${options.sense} = ${senseText}`
  );
}

/** io_set, re-unlocking once if the ECU says securityAccessDenied (the unlock can age out on a quiet bus). */
async function ioSetWithRelockRetry(control: number, value: number): Promise<Reply> {
  const send = () => transact([SERVICE_IO_CONTROL, ...controlBytes(control), IO_SET, value & 0xff]);
  const first = await send();
  if (first.negativeCode !== 0x33) {
    return first;
  }
  console.log("    unlock lapsed (securityAccessDenied) — re-unlocking and retrying once");
  if (!(await unlock())) {
    return first;
  }
  return send();
}

async function holdForce(control: number, value: number, seconds: number): Promise<void> {
  const cadence = options.cadenceMs;
  const watchNote = options.watchDuringHold
    ? "; reading the sense each second (each read briefly lets the output recover — expect a periodic blink)"
    : "";
  console.log(
    `\nholding output ${control} := ${value} for ${seconds}s by re-asserting io_set every ${cadence} ms (Ctrl-C to release)${watchNote}.`
  );
  const deadline = seconds * 1000;
  let elapsed = 0;
  let sinceRead = 0;
  while (elapsed < deadline && !aborted) {
    await transact([SERVICE_IO_CONTROL, ...controlBytes(control), IO_SET, value & 0xff], {
      timeoutMs: 300,
      quietTimeout: true,
    });
    await sleep(cadence);
    elapsed += cadence;
    sinceRead += cadence;
    // A sense read pauses the re-assert for two round-trips, long enough for the override to
    // lapse and the output to blink back — so it is opt-in (--watch), off by default for a clean hold.
    if (options.watchDuringHold && sinceRead >= 1000) {
      sinceRead = 0;
      await readControl("holding");
    }
  }
}

async function stopSession(): Promise<void> {
  // StopDiagnosticSession hands the output back explicitly — cleaner than just letting the override
  // pulse lapse. Fire-and-forget: we are on our way out either way.
  console.log("\n→ StopDiagnosticSession (20) — handing the output back to the VCU");
  await transact([SERVICE_STOP_SESSION], { timeoutMs: 300, quietTimeout: true });
  console.log("done. The VCU is driving its outputs again.");
}

// ── transport ────────────────────────────────────────────────────────────────

/** One request/response exchange. Builds an extended-addressed single frame to the node, waits for the reply. */
function transact(payload: number[], config: { timeoutMs?: number; quietTimeout?: boolean } = {}): Promise<Reply> {
  const timeoutMs = config.timeoutMs ?? 600;
  if (payload.length > 6) {
    throw new Error(`probe: payload of ${payload.length} bytes does not fit one extended-addressed frame`);
  }
  const frame = Buffer.alloc(8);
  frame[0] = targetAddress;
  frame[1] = payload.length;
  for (let index = 0; index < payload.length; index += 1) {
    frame[2 + index] = payload[index];
  }

  return new Promise<Reply>(resolve => {
    const timer = setTimeout(() => {
      if (pending !== null) {
        pending = null;
        if (!config.quietTimeout) {
          console.log("    … no reply (timeout)");
        }
        resolve({ ok: false, service: null, negativeCode: null, payload: new Uint8Array() });
      }
    }, timeoutMs);
    pending = reply => {
      clearTimeout(timer);
      resolve(reply);
    };
    channel.send({ id: REQUEST_CAN_ID, ext: false, rtr: false, data: frame });
  });
}

function interpret(payload: Uint8Array): Reply {
  if (payload.length >= 3 && payload[0] === NEGATIVE_RESPONSE) {
    return { ok: false, service: null, negativeCode: payload[2], payload };
  }
  return { ok: true, service: payload[0], negativeCode: null, payload };
}

function describe(reply: Reply): string {
  if (reply.negativeCode !== null) {
    const name = NRC_NAMES[reply.negativeCode] ?? "?";
    return `NEGATIVE NRC 0x${reply.negativeCode.toString(16)} (${name})`;
  }
  if (reply.service === null) {
    return "no reply";
  }
  return `positive, data ${hex(reply.payload)}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function calcKey(seed: number): number {
  const swapped = (((seed >>> 1) & 0x55555555) | ((seed << 1) & 0xaaaaaaaa)) >>> 0;
  return (swapped - KEY_SUBTRAHEND) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function uint32Bytes(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function controlBytes(control: number): number[] {
  return [(control >> 8) & 0xff, control & 0xff];
}

/**
 * The value from a 0x6F IOControl reply, decoded exactly as the service tool does:
 * the reply echoes the identifier first, so the value is the trailing byte(s). Our payload keeps
 * the leading service byte, so measure the post-service length: ≥5 → a signed 16-bit reading,
 * else the trailing single byte (an output command). This is why a get-output shows 0/255 and a
 * sense shows a full milliamp reading.
 */
function ioValue(payload: Uint8Array): number {
  const afterService = payload.subarray(1);
  if (afterService.length >= 5) {
    const raw = (afterService[afterService.length - 2] << 8) | afterService[afterService.length - 1];
    return raw >= 0x8000 ? raw - 0x10000 : raw;
  }
  return afterService.length > 0 ? afterService[afterService.length - 1] : NaN;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" ");
}

function hexId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface Options {
  node: "A8" | "A9";
  control: number;
  sense: number;
  forceValue: number | null; // null = read-only recon
  holdSeconds: number;
  cadenceMs: number; // how often holdForce re-asserts the io_set override (the pulse decays fast)
  watchDuringHold: boolean; // --watch: read the sense each second during a hold (causes a periodic blink)
  sweepMax: number | null; // non-null = read-only sweep of ids 1..sweepMax instead of a single control
}

function parseArguments(argv: string[]): Options {
  let node: Options["node"] = DEFAULT_NODE;
  let control = BEAM_OUTPUT_CONTROL;
  let sense = BEAM_SENSE_CONTROL;
  let forceValue: number | null = null;
  let holdSeconds = 15;
  let cadenceMs = DEFAULT_REASSERT_MS;
  let watchDuringHold = false;
  let sweepMax: number | null = null;
  let controlSetExplicitly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--off") {
      forceValue = 0;
    } else if (flag === "--on") {
      forceValue = 255;
    } else if (flag === "--node") {
      const next = argv[++index];
      if (next !== "A8" && next !== "A9") {
        throw new Error(`--node must be A8 or A9, got ${next}`);
      }
      node = next;
    } else if (flag === "--control") {
      control = Number(argv[++index]);
      controlSetExplicitly = true;
    } else if (flag === "--sense") {
      sense = Number(argv[++index]);
    } else if (flag === "--value") {
      forceValue = Number(argv[++index]);
    } else if (flag === "--hold") {
      holdSeconds = Number(argv[++index]);
    } else if (flag === "--cadence") {
      cadenceMs = Number(argv[++index]);
    } else if (flag === "--watch") {
      watchDuringHold = true;
    } else if (flag === "--sweep") {
      // optional max id; defaults to 48, comfortably past the highest documented light id (43)
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        sweepMax = Number(argv[++index]);
      } else {
        sweepMax = 48;
      }
    } else {
      throw new Error(`unknown argument ${flag}. See the header for options.`);
    }
  }

  // When forcing an arbitrary control, default the sense to that same id unless one was given.
  if (controlSetExplicitly && sense === BEAM_SENSE_CONTROL) {
    sense = control + 1;
  }
  if (!Number.isInteger(control) || control < 0 || control > 0xffff) {
    throw new Error(`--control must be a 16-bit id, got ${control}`);
  }
  if (forceValue !== null && (!Number.isInteger(forceValue) || forceValue < 0 || forceValue > 255)) {
    throw new Error(`--value / --off / --on must give a byte 0-255, got ${forceValue}`);
  }
  if (!Number.isFinite(holdSeconds) || holdSeconds < 1) {
    throw new Error(`--hold must be a positive number of seconds, got ${holdSeconds}`);
  }
  if (!Number.isFinite(cadenceMs) || cadenceMs < 1) {
    throw new Error(`--cadence must be a positive number of milliseconds, got ${cadenceMs}`);
  }
  if (sweepMax !== null && (!Number.isInteger(sweepMax) || sweepMax < 1 || sweepMax > 0xffff)) {
    throw new Error(`--sweep max must be a positive 16-bit id, got ${sweepMax}`);
  }
  return { node, control, sense, forceValue, holdSeconds, cadenceMs, watchDuringHold, sweepMax };
}
