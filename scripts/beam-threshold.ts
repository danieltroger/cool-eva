import { canIdsFor, identifierForIndex, parseResponseFrame, toHex } from "../src/vcu/param-codec.ts";

// Reads — and, with a write flag, changes — the VCU-Safety LIGHT current-threshold parameters that
// decide when each light circuit's output is cut. Originally beam-only; now covers every light the VCU
// current-senses: beam, front/rear position, stop, indicators (src/vcu/param-file.ts, groups LIGHTS +
// BLINKER, all node A8). See docs/headlight-beam-threshold.md for the proven beam route.
//
// SEPARATE mechanism from scripts/headlight-off.ts: that one FORCES an output (io_set 0x2F), an
// override that decays in <40 ms and needs a 5 ms re-assert. This one writes a STORED CALIBRATION
// (WriteDataByCommonID 0x2E) that persists across power cycles until written back. Write MAX below the
// real draw and at the next init the VCU reads over-current and brings that circuit up OFF, storing an
// open-circuit DTC. That is why --restore exists and why every write reads back.
//
//   sudo systemctl stop cool-eva      # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/beam-threshold.ts                       # READ-ONLY recon (beam)
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --all                 # READ-ONLY recon, all five
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --light stop          # recon one circuit
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --light beam --off    # force beam off (persistent)
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --all-off             # every light off
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --light beam --restore
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --all --restore       # undo all five
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --light stop --write max 20
//
// ⚠️ Deliberately crosses this repo's standing ban on transmitting 0x2E/0x27 — SCRATCH probe, same
// footing as scripts/headlight-off.ts. It reuses param-codec's PROVEN framing but builds the write
// frame itself, because the shipped codec is read-only by construction.
//
// ⚠️ A write here is PERSISTENT and stores a DTC the VCU keeps until cleared. --restore writes the
// CATALOGUE-BASE factory values (param-file.ts is table 16406, NOT this bike's 16407), so for anything
// but beam prefer the live-value restore recipe this tool prints before it writes.
//
// PRECONDITIONS for a write: bike on its stand, key ON, the light on if you want its draw measured,
// clear of moving parts, not ridden.

const NODE = "A8"; // VCU-Safety — owns the LIGHTS + BLINKER parameter groups (ecu 168 / 0xA8)
const TARGET_ADDRESS = 0xa8;

const SERVICE_START_SESSION = 0x10;
const STANDARD_SESSION = 0x81;
const SERVICE_STOP_SESSION = 0x20;
const SERVICE_SECURITY = 0x27;
const SERVICE_READ_PARAM = 0x22; // ReadDataByCommonID
const SERVICE_WRITE_PARAM = 0x2e; // WriteDataByCommonID
const SERVICE_IO_CONTROL = 0x2f; // only sub 0x01 (io_get_reading) is used here — a read of the live sense
const NEGATIVE_RESPONSE = 0x7f;

const SECURITY_REQUEST_SEED = 0x01;
const SECURITY_SEND_KEY = 0x02;
const IO_GET_READING = 0x01;
const NRC_SECURITY_ACCESS_DENIED = 0x33;

// The VCU family's SecurityAccess key: swap adjacent bits of the 32-bit seed, then subtract
// 0x3E5F4542 (fixed per module). Confirmed on this bike — see docs/headlight-diagnostic-control.md.
const KEY_SUBTRAHEND = 0x3e5f4542;

interface ParamSpec {
  index: number; // bank-1 parameter index; CommonIdentifier = identifierForIndex(index)
  name: string;
  bytes: number;
  factory: number; // CATALOGUE-BASE default (table 16406) — NOT necessarily this bike's value
  signed: boolean; // the S/U column — RPOSLIGHTS are two's-complement
}

interface LightCircuit {
  key: string; // --light selector
  name: string;
  min: ParamSpec; // healthy-window floor (raise above the draw for a bulb-out fault)
  max: ParamSpec; // healthy-window ceiling — the one --off lowers below the draw
  hilo: ParamSpec | null; // beam only: the low/high split threshold
  senseControl: number | null; // io_get control for the live draw; only the beam's (18) is confirmed
  note: string | null; // a per-circuit caution printed before touching it
}

function word(index: number, name: string, factory: number, signed = false): ParamSpec {
  return { index, name, bytes: 2, factory, signed };
}

// All from src/vcu/param-file.ts (Energica's params.ecf), node A8, bank 1, WORD/mA.
const LIGHT_CIRCUITS: Record<string, LightCircuit> = {
  beam: {
    key: "beam",
    name: "Headlight beam",
    min: word(242, "BEAM_MIN_CURR_TH", 1500),
    max: word(240, "BEAM_MAX_CURR_TH", 7500),
    hilo: word(241, "BEAM_HILO_CURR_TH", 3750),
    senseControl: 18, // confirmed: the LOW_BEAM guided test reads control 18 on ecu 168
    note: null,
  },
  frontpos: {
    key: "frontpos",
    name: "Front position lights",
    min: word(243, "POSLIGHTS_MIN_CURR_TH", 50),
    max: word(244, "POSLIGHTS_MAX_CURR_TH", 300),
    hilo: null,
    senseControl: null, // the io_set sweep saw id 10 ≈ 60 mA "front position" — a candidate, unconfirmed
    note: null,
  },
  rearpos: {
    key: "rearpos",
    name: "Rear position lights",
    min: word(251, "RPOSLIGHTS_MIN_CURR_TH", 15, true),
    max: word(252, "RPOSLIGHTS_MAX_CURR_TH", 500, true),
    hilo: null,
    senseControl: null,
    note: "idx 251/252 contested — param-file.ts=RPOSLIGHTS (signed), table-catalog=LIGHTS_DUMMY. Confirm by read-back before writing.",
  },
  stop: {
    key: "stop",
    name: "Stop / brake light",
    min: word(245, "STOPLIGHTS_MIN_CURR_TH", 50),
    max: word(246, "STOPLIGHTS_MAX_CURR_TH", 300),
    hilo: null,
    senseControl: null,
    note: "normally OFF — the fault latches when the brake circuit is next energized/tested (STOPLIGHTS_INITIAL_TEST=1).",
  },
  indicator: {
    key: "indicator",
    name: "Indicators (blinkers)",
    min: word(235, "INDICATOR_MIN_CURR_TH", 200),
    max: word(236, "INDICATOR_MAX_CURR_TH", 500),
    hilo: null,
    senseControl: null,
    note: "BLINKER group; INDICATORLIGHTS_INITIAL_TEST=0, so the fault may only latch when you actually signal.",
  },
};

const NRC_NAMES: Record<number, string> = {
  0x12: "subFunctionNotSupported",
  0x22: "conditionsNotCorrect",
  0x31: "requestOutOfRange",
  0x33: "securityAccessDenied",
  0x78: "responsePending",
};

interface Reply {
  ok: boolean;
  service: number | null;
  negativeCode: number | null;
  payload: Uint8Array; // excludes the address and PCI byte; includes the service byte
}

interface CircuitReading {
  min: number | null;
  max: number | null;
  hilo: number | null;
  senseMilliamps: number | null;
}

const options = parseArguments(process.argv.slice(2));
const { request: REQUEST_CAN_ID, response: RESPONSE_CAN_ID } = canIdsFor(NODE);

console.log(
  `light-threshold probe — target VCU-Safety (0x${TARGET_ADDRESS.toString(16)}) on ${hexId(REQUEST_CAN_ID)}/${hexId(RESPONSE_CAN_ID)}`
);
describeMode();

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
    console.log("    … responsePending (0x78), waiting");
    return;
  }
  const resolve = pending;
  pending = null;
  resolve(reply);
});
channel.start();

await runSequence();
process.exit(0);

// ── the sequence ───────────────────────────────────────────────────────────────

async function runSequence(): Promise<void> {
  console.log("\n→ StartDiagnosticSession (10 81)");
  const session = await transact([SERVICE_START_SESSION, STANDARD_SESSION]);
  if (!session.ok) {
    console.log(`  ✗ VCU-Safety refused the session: ${describe(session)}`);
    console.log("    Without a session nothing here can proceed. Is the key ON and the bike awake?");
    return;
  }
  console.log("  ✓ session open");

  if (!(await unlock())) {
    return;
  }

  for (const key of options.circuits) {
    const circuit = LIGHT_CIRCUITS[key];
    if (circuit.note !== null) {
      console.log(`\n⚠ ${circuit.name}: ${circuit.note}`);
    }
    const before = await readCircuit(circuit, "before");

    if (options.mode === "read") {
      recommend(circuit, before);
      continue;
    }

    printRestoreRecipe(circuit, before);
    const writes = plannedWrites(circuit, before);
    if (writes === null) {
      continue; // refused for this circuit (reason already printed); keep the rest of the run going
    }
    let allWritten = true;
    for (const write of writes) {
      if (!(await writeParam(write.spec, write.value))) {
        console.log(`  aborting ${circuit.name} — a write failed; earlier writes (if any) already persisted.`);
        allWritten = false;
        break;
      }
    }
    if (allWritten) {
      await readCircuit(circuit, "after");
    }
  }

  if (options.mode === "read") {
    console.log("\nrecon complete — nothing was written.");
  } else {
    console.log(
      "\nnote: these are STORED calibrations and persist across power cycles. Each forced circuit stores an " +
        "open-circuit DTC (shown on the dash) that must be cleared separately. Undo with the printed restore " +
        "recipe (this bike's live values) or --restore (catalogue factory)."
    );
  }
  await stopSession();
}

/** Plan the writes for --off / --restore / --write on one circuit. Null means refuse (reason printed). */
function plannedWrites(circuit: LightCircuit, before: CircuitReading): { spec: ParamSpec; value: number }[] | null {
  if (options.mode === "restore") {
    if (circuit.key !== "beam") {
      console.log(`  ⚠ --restore writes CATALOGUE factory for ${circuit.name}, which may differ from this bike.`);
    }
    const specs = [circuit.min, circuit.max, ...(circuit.hilo ? [circuit.hilo] : [])];
    return specs.map(spec => ({ spec, value: spec.factory }));
  }
  if (options.mode === "write") {
    const spec = writeTarget(circuit, options.writeKey);
    if (spec === null) {
      console.log(`  ✗ ${circuit.name} has no '${options.writeKey}' threshold.`);
      return null;
    }
    return [{ spec, value: options.writeValue }];
  }
  return offWrites(circuit, before);
}

/** --off: lower MAX below the draw (or, with --via-min, raise MIN above it). */
function offWrites(circuit: LightCircuit, before: CircuitReading): { spec: ParamSpec; value: number }[] | null {
  const spec = options.viaMin ? circuit.min : circuit.max;
  if (options.value !== null) {
    return [{ spec, value: options.value }];
  }
  const draw = before.senseMilliamps;
  if (circuit.senseControl !== null && draw !== null && draw >= 30) {
    // MAX route: set the ceiling below the draw → sensed current reads over-max → cut.
    // MIN route: set the floor above the draw → sensed current reads under-min → bulb-out.
    const value = options.viaMin ? Math.round(draw * 1.5) : Math.round(draw * 0.5);
    console.log(`  --off: ${circuit.name} draws ${draw} mA → ${spec.name} := ${value} mA`);
    if (!options.viaMin && before.min !== null && value < before.min) {
      console.log(
        `    (that is below the stored MIN ${before.min}; the window inverts — expected for a low-draw light)`
      );
    }
    return [{ spec, value }];
  }
  if (options.viaMin) {
    console.log(`  ✗ ${circuit.name}: no current sense to size --via-min. Pass --value <mA> (above the real draw).`);
    return null;
  }
  if (before.min === null) {
    console.log(`  ✗ ${circuit.name}: MIN threshold unreadable; cannot size a fallback. Pass --value <mA>.`);
    return null;
  }
  // No sense mapped: size from THIS bike's stored floor. A value below MIN is below any real "on"
  // draw, so the circuit reads over-max whenever it is actually lit.
  const value = Math.max(1, Math.round(before.min * 0.5));
  console.log(
    `  ⚠ ${circuit.name}: no current sense — fallback ${circuit.max.name} := ${value} mA (below stored MIN ${before.min}). VERIFY on-bike.`
  );
  return [{ spec: circuit.max, value }];
}

function writeTarget(circuit: LightCircuit, key: "min" | "max" | "hilo"): ParamSpec | null {
  if (key === "min") return circuit.min;
  if (key === "max") return circuit.max;
  return circuit.hilo;
}

/** Print the exact commands to put THIS bike's live thresholds back — a bike-correct undo. */
function printRestoreRecipe(circuit: LightCircuit, before: CircuitReading): void {
  const parts: string[] = [];
  if (before.min !== null) {
    parts.push(`--write min ${before.min}`);
  }
  if (before.max !== null) {
    parts.push(`--write max ${before.max}`);
  }
  if (circuit.hilo && before.hilo !== null) {
    parts.push(`--write hilo ${before.hilo}`);
  }
  if (parts.length === 0) {
    console.log(`  (could not read ${circuit.name} thresholds to build a restore recipe)`);
    return;
  }
  console.log(`  to undo ${circuit.name} with THIS bike's live values:`);
  for (const part of parts) {
    console.log(`    beam-threshold.ts --light ${circuit.key} ${part}`);
  }
}

// ── UDS operations ───────────────────────────────────────────────────────────

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
    return false;
  }
  console.log("  ✓ unlocked");
  return true;
}

/** Read one circuit's thresholds plus its live draw (if a sense is mapped), and print them lined up. */
async function readCircuit(circuit: LightCircuit, label: string): Promise<CircuitReading> {
  console.log(`\n[${label}] ${circuit.name}`);
  const min = await readParam(circuit.min);
  const max = await readParam(circuit.max);
  const hilo = circuit.hilo ? await readParam(circuit.hilo) : null;
  printParam(circuit.min, min);
  printParam(circuit.max, max);
  if (circuit.hilo) {
    printParam(circuit.hilo, hilo);
  }
  let senseMilliamps: number | null = null;
  if (circuit.senseControl !== null) {
    senseMilliamps = await readSense(circuit.senseControl);
    const text = senseMilliamps === null ? "no reply" : `${senseMilliamps} mA`;
    console.log(`  live draw (io_get ${circuit.senseControl})  = ${text}`);
  } else {
    console.log("  live draw                       = (no current sense mapped for this circuit)");
  }
  return { min, max, hilo, senseMilliamps };
}

function printParam(spec: ParamSpec, value: number | null): void {
  const text = value === null ? "unreadable" : `${value} mA`;
  console.log(`  ${spec.name.padEnd(20)} (idx ${spec.index}) = ${text}   [catalogue ${spec.factory}]`);
}

/** ReadDataByCommonID for one parameter. Returns its value in mA, or null if unreadable. */
async function readParam(spec: ParamSpec): Promise<number | null> {
  const identifier = identifierForIndex(spec.index);
  const reply = await transact([SERVICE_READ_PARAM, (identifier >> 8) & 0xff, identifier & 0xff]);
  if (!reply.ok || reply.payload.length < 3 + spec.bytes) {
    return null;
  }
  // Positive 0x62 reply echoes the 2-byte identifier, then the value bytes (big-endian).
  const bytes = reply.payload.subarray(reply.payload.length - spec.bytes);
  let value = bytes.reduce((accumulated, byte) => accumulated * 256 + byte, 0);
  if (spec.signed && value >= 1 << (spec.bytes * 8 - 1)) {
    value -= 1 << (spec.bytes * 8); // two's-complement for the S-column params (e.g. RPOSLIGHTS)
  }
  return value;
}

/** WriteDataByCommonID for one parameter, then read it back and confirm. Retries once on 0x33. */
async function writeParam(spec: ParamSpec, value: number): Promise<boolean> {
  const identifier = identifierForIndex(spec.index);
  const valueBytes = uintBytes(value, spec.bytes);
  const send = () => transact([SERVICE_WRITE_PARAM, (identifier >> 8) & 0xff, identifier & 0xff, ...valueBytes]);

  console.log(
    `\n→ WriteDataByCommonID: ${spec.name} (idx ${spec.index}) := ${value} mA  [${toHex(Uint8Array.from(valueBytes))}]`
  );
  let written = await send();
  if (written.negativeCode === NRC_SECURITY_ACCESS_DENIED) {
    console.log("    unlock lapsed (securityAccessDenied) — re-unlocking and retrying once");
    if (!(await unlock())) {
      return false;
    }
    written = await send();
  }
  if (!written.ok) {
    console.log(`  ✗ write refused: ${describe(written)}`);
    return false;
  }
  const readBack = await readParam(spec);
  if (readBack !== value) {
    console.log(`  ✗ read-back mismatch: wrote ${value}, reads ${readBack ?? "unreadable"}`);
    return false;
  }
  console.log(`  ✓ write accepted and confirmed (reads ${readBack} mA)`);
  return true;
}

/** Live current via io_get (0x2F sub 0x01). Signed 16-bit trailing, per the service tool's decode. */
async function readSense(control: number): Promise<number | null> {
  const reply = await transact([SERVICE_IO_CONTROL, (control >> 8) & 0xff, control & 0xff, IO_GET_READING]);
  if (!reply.ok) {
    return null;
  }
  const afterService = reply.payload.subarray(1);
  if (afterService.length < 2) {
    return null;
  }
  const raw = (afterService[afterService.length - 2] << 8) | afterService[afterService.length - 1];
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

async function stopSession(): Promise<void> {
  console.log("\n→ StopDiagnosticSession (20)");
  await transact([SERVICE_STOP_SESSION], { timeoutMs: 300, quietTimeout: true });
  console.log("done.");
}

function recommend(circuit: LightCircuit, before: CircuitReading): void {
  const draw = before.senseMilliamps;
  if (circuit.senseControl !== null && draw !== null && draw >= 30) {
    console.log(`  ${circuit.name} draws ${draw} mA. To force it off persistently:`);
    console.log(
      `    --light ${circuit.key} --off            → ${circuit.max.name} ≈ ${Math.round(draw * 0.5)} mA (over-current cut)`
    );
    console.log(
      `    --light ${circuit.key} --off --via-min  → ${circuit.min.name} ≈ ${Math.round(draw * 1.5)} mA (bulb-out)`
    );
    return;
  }
  if (before.min !== null) {
    const fallback = Math.max(1, Math.round(before.min * 0.5));
    console.log(
      `  ${circuit.name}: no current sense mapped. --light ${circuit.key} --off would use a fallback ` +
        `${circuit.max.name} := ${fallback} mA (below stored MIN ${before.min}); verify on-bike, or pass --value.`
    );
    return;
  }
  console.log(`  ${circuit.name}: thresholds unreadable — is the key on and the bike awake?`);
}

// ── transport ────────────────────────────────────────────────────────────────

/** One request/response exchange. Extended-addressed single frame to VCU-Safety; reply to the tester. */
function transact(payload: number[], config: { timeoutMs?: number; quietTimeout?: boolean } = {}): Promise<Reply> {
  const timeoutMs = config.timeoutMs ?? 600;
  if (payload.length > 6) {
    throw new Error(`beam-threshold: payload of ${payload.length} bytes does not fit one extended-addressed frame`);
  }
  const frame = Buffer.alloc(8);
  frame[0] = TARGET_ADDRESS;
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
    return `NEGATIVE NRC 0x${reply.negativeCode.toString(16)} (${NRC_NAMES[reply.negativeCode] ?? "?"})`;
  }
  if (reply.service === null) {
    return "no reply";
  }
  return `positive, data ${toHex(reply.payload)}`;
}

function describeMode(): void {
  const scope =
    options.circuits.length === 1
      ? LIGHT_CIRCUITS[options.circuits[0]].name
      : `${options.circuits.length} circuits (${options.circuits.join(", ")})`;
  if (options.mode === "read") {
    console.log(`mode: READ-ONLY recon — reading thresholds + live draw for ${scope}. Nothing is written.`);
    return;
  }
  if (options.mode === "restore") {
    console.log(`mode: RESTORE — writing catalogue-factory thresholds for ${scope}.`);
  } else if (options.mode === "write") {
    console.log(
      `mode: WRITE — ${options.writeKey} := ${options.writeValue} mA on ${scope} (raw single-threshold write).`
    );
  } else {
    console.log(
      `mode: OFF — ${options.viaMin ? "raising MIN above" : "lowering MAX below"} the draw to cut ${scope} (PERSISTENT).`
    );
  }
  console.log(
    "⚠️  Bike on its stand, key ON, clear of moving parts. Writes persist across power cycles; a restore recipe is printed per circuit."
  );
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

/** Big-endian byte array of a non-negative integer in `width` bytes. */
function uintBytes(value: number, width: number): number[] {
  const bytes = new Array<number>(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return bytes;
}

function hexId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

type Mode = "read" | "off" | "restore" | "write";

interface Options {
  circuits: string[]; // one or more LIGHT_CIRCUITS keys
  mode: Mode;
  value: number | null; // --value <mA> for --off (null = derive from live draw or the stored floor)
  viaMin: boolean; // --via-min: raise MIN above the draw instead of lowering MAX below it
  writeKey: "min" | "max" | "hilo"; // --write <key> <mA>
  writeValue: number;
}

function parseArguments(argv: string[]): Options {
  let circuits = ["beam"];
  let mode: Mode = "read";
  let value: number | null = null;
  let viaMin = false;
  let writeKey: "min" | "max" | "hilo" = "max";
  let writeValue = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--all-off") {
      circuits = Object.keys(LIGHT_CIRCUITS);
      mode = "off";
    } else if (flag === "--all") {
      // Select every circuit but leave the mode alone: `--all` alone is read-only recon of all five,
      // `--all --restore` undoes all five. `--all-off` stays as the one-word "cut everything".
      circuits = Object.keys(LIGHT_CIRCUITS);
    } else if (flag === "--light") {
      circuits = parseCircuitList(argv[++index]);
    } else if (flag === "--off") {
      mode = "off";
    } else if (flag === "--restore") {
      mode = "restore";
    } else if (flag === "--via-min") {
      viaMin = true;
    } else if (flag === "--value") {
      value = Number(argv[++index]);
    } else if (flag === "--write") {
      mode = "write";
      const key = argv[++index];
      if (key !== "max" && key !== "min" && key !== "hilo") {
        throw new Error(`--write key must be max|min|hilo, got ${key}`);
      }
      writeKey = key;
      writeValue = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument ${flag}. See the header for options.`);
    }
  }

  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 0xffff)) {
    throw new Error(`--value must be a 16-bit milliamp value, got ${value}`);
  }
  if (mode === "write") {
    if (circuits.length !== 1) {
      throw new Error("--write acts on one circuit — select it with --light <name>");
    }
    if (!Number.isInteger(writeValue) || writeValue < 0 || writeValue > 0xffff) {
      throw new Error(`--write value must be a 16-bit milliamp value, got ${writeValue}`);
    }
  }
  return { circuits, mode, value, viaMin, writeKey, writeValue };
}

function parseCircuitList(raw: string | undefined): string[] {
  if (raw === undefined) {
    throw new Error(
      `--light needs a circuit name (${Object.keys(LIGHT_CIRCUITS).join("|")}), or a comma-separated list`
    );
  }
  const keys = raw.split(",").map(part => part.trim());
  for (const key of keys) {
    if (!(key in LIGHT_CIRCUITS)) {
      throw new Error(`--light: unknown circuit '${key}'. Known: ${Object.keys(LIGHT_CIRCUITS).join(", ")}`);
    }
  }
  return keys;
}
