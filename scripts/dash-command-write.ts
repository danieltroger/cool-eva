// WRITES one command id on the VCU's 0x120/0x121 dashboard command channel, then reads it back to
// confirm and (by default) restores the original value. This is the WRITE counterpart to the
// read-only dash-command-sweep.ts, kept separate so that sweep stays provably non-mutating.
//
// A write is b0 = (id | 0x80) — the "request-twin" high bit — b1 = 0xFF, b2 = value, sent on 0x120
// ALONE. That is exactly the frame the shipping charge-stop builds (charge-command.ts: 0x16 → the
// 0x120 `96 ff 01`), and the RTC write (service-actions.ts: 0x14 → `94 ff …`). Writes on this
// channel are fire-and-forget — the VCU emits no 0x121 ack for an injected 0x120 write — so we
// confirm the change by a follow-up READ, not by a reply.
//
// This crosses no diagnostic ban: 0x120 writes are the same class the app already ships, NOT the
// 0x2F/0x27 safety-node route. But dash-command writes are UNTESTED (the service-tool analysis leaves them
// out), so this is genuinely new. It refuses any id outside the two light-labelled candidates
// unless --force-id is given, and restores the read-back value afterwards unless --no-restore.
//
//   sudo systemctl stop cool-eva     # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/dash-command-write.ts --id 0x15 --value 1
//
// Purpose here: 0x15 "LPR mode" reads 0 on this bike; write 1, WATCH THE BEAM, then restore. See
// docs/dash-command-channel.md for why 0x15 is the last CAN candidate for a non-diagnostic light off.

// No static import (socket.ts is loaded dynamically below so tsc/CI don't pull in
// the Linux-only socketcan native build); this marks the file a module for top-level await.
export {};

const DASH_COMMAND_REQUEST_ID = 0x120; // VCU_COMMAND_REQ — we transmit here (both reads and writes)
const DASH_COMMAND_RESPONSE_ID = 0x121; // VCU_COMMAND_RES — the VCU answers reads here
const SEPARATOR_BYTE = 0xff; // b1 in every frame on this channel
const WRITE_BIT = 0x80; // b0 bit 7: set = write, clear = read
const HIGHEST_COMMAND_ID = 0x7f; // 7-bit id space (0..127); bit 7 is the read/write flag
const READ_TIMEOUT_MS = 150; // a live id answers in a few ms; this is how long we wait on silence
const WRITE_SETTLE_MS = 40; // let the VCU apply a write before the confirming read-back
const DEFAULT_HOLD_SECONDS = 8; // time to eyeball the beam with the value set, before restoring

// Only these two ids may be written without --force-id: the light-labelled dash commands
// (the service tool's dash-command name table). Everything else on this channel is charge/map/fan config we do
// not want to fat-finger onto a live bus. --force-id lifts the guard deliberately.
const WRITE_ALLOWLIST: Record<number, string> = {
  0x15: "LPR mode (0=off / 1=on)",
  0x2a: "Light in charge (0=off / 1=on)",
};

type CommandStatus = "live" | "unsupported" | "silent";

interface CommandReply {
  status: CommandStatus;
  payload: Uint8Array; // bytes 2.. of the 0x121 reply (empty unless live)
}

interface Options {
  id: number;
  value: number;
  holdSeconds: number;
  restore: boolean;
}

const options = parseArguments(process.argv.slice(2));

const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("bringing can0 up ACTIVE (TX enabled)…");
await bringUpCan("can0", true);
const channel = openChannel("can0");

// One request is outstanding at a time (read or read-back), so a single resolver keyed to the id we
// asked for is enough. 0x121 also carries unsolicited charge telemetry, so drop any non-matching id.
let pending: { cmd: number; resolve: (reply: CommandReply) => void } | null = null;
channel.addListener("onMessage", message => {
  if (message.id !== DASH_COMMAND_RESPONSE_ID || pending === null) {
    return;
  }
  const data = Uint8Array.from(message.data);
  if (data.length < 1 || (data[0] & HIGHEST_COMMAND_ID) !== pending.cmd) {
    return; // a reply for another id, or unsolicited traffic on 0x121
  }
  const supported = (data[0] & WRITE_BIT) === 0;
  const resolve = pending.resolve;
  pending = null;
  resolve({ status: supported ? "live" : "unsupported", payload: data.subarray(2) });
});
channel.start();

await runWriteProbe(options);

process.exit(0);

// ── the probe ─────────────────────────────────────────────────────────────────

async function runWriteProbe(options: Options): Promise<void> {
  const label = WRITE_ALLOWLIST[options.id] ?? "(unlabelled — forced)";
  console.log(`dash command WRITE probe — id 0x${hex(options.id)} "${label}", value ${options.value}`);

  const before = await readCommand(options.id);
  console.log(`  before:      ${describe(before)}`);
  const originalValue = before.status === "live" && before.payload.length > 0 ? before.payload[0] : null;

  console.log(
    `  writing 0x${hex(options.id)} = ${options.value} on 0x120 (b0 = 0x${hex((options.id & HIGHEST_COMMAND_ID) | WRITE_BIT)})…`
  );
  writeCommand(options.id, options.value);
  await delay(WRITE_SETTLE_MS);

  const afterWrite = await readCommand(options.id);
  console.log(`  after write: ${describe(afterWrite)}`);
  if (afterWrite.status === "live" && afterWrite.payload.length > 0 && afterWrite.payload[0] === options.value) {
    console.log(`  ✓ value took — reads back ${options.value}`);
  } else {
    console.log(`  ✗ value did NOT read back as ${options.value} — the VCU may have ignored, rejected, or clamped it`);
  }

  console.log(`\n  >>> WATCH THE BEAM now — holding for ${options.holdSeconds}s <<<\n`);
  await delay(options.holdSeconds * 1000);

  if (!options.restore) {
    console.log(`  --no-restore: leaving 0x${hex(options.id)} = ${options.value}.`);
    return;
  }
  if (originalValue === null) {
    console.warn(
      `  cannot restore: the before-read was "${before.status}", so there is no original value to write back. Leaving 0x${hex(options.id)} = ${options.value}.`
    );
    return;
  }
  console.log(`  restoring 0x${hex(options.id)} = ${originalValue}…`);
  writeCommand(options.id, originalValue);
  await delay(WRITE_SETTLE_MS);
  const afterRestore = await readCommand(options.id);
  console.log(`  after restore: ${describe(afterRestore)}`);
}

/** Send a WRITE: b0 = id|0x80, b1 = 0xFF, b2 = value, on 0x120 alone. Fire-and-forget (no ack). */
function writeCommand(cmd: number, value: number): void {
  const frame = Buffer.alloc(8);
  frame[0] = (cmd & HIGHEST_COMMAND_ID) | WRITE_BIT;
  frame[1] = SEPARATOR_BYTE;
  frame[2] = value & 0xff;
  channel.send({ id: DASH_COMMAND_REQUEST_ID, ext: false, rtr: false, data: frame });
}

/** Read one command id (bit 7 clear): send the request, wait for its 0x121 reply, classify it. */
function readCommand(cmd: number): Promise<CommandReply> {
  return new Promise<CommandReply>(resolve => {
    const timer = setTimeout(() => {
      if (pending !== null && pending.cmd === cmd) {
        pending = null;
        resolve({ status: "silent", payload: new Uint8Array() });
      }
    }, READ_TIMEOUT_MS);
    pending = {
      cmd,
      resolve: reply => {
        clearTimeout(timer);
        resolve(reply);
      },
    };
    const frame = Buffer.alloc(8);
    frame[0] = cmd & HIGHEST_COMMAND_ID; // bit 7 forced clear — this is a read
    frame[1] = SEPARATOR_BYTE;
    channel.send({ id: DASH_COMMAND_REQUEST_ID, ext: false, rtr: false, data: frame });
  });
}

function parseArguments(argv: string[]): Options {
  let id: number | null = null;
  let value: number | null = null;
  let holdSeconds = DEFAULT_HOLD_SECONDS;
  let restore = true;
  let forceId = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--id") {
      id = parseNumeric(argv[index + 1], "--id");
      index += 1;
    } else if (arg === "--value") {
      value = parseNumeric(argv[index + 1], "--value");
      index += 1;
    } else if (arg === "--hold") {
      holdSeconds = parseNumeric(argv[index + 1], "--hold");
      index += 1;
    } else if (arg === "--no-restore") {
      restore = false;
    } else if (arg === "--force-id") {
      forceId = true;
    } else {
      throw new Error(`dash-command-write: unknown argument "${arg}"`);
    }
  }

  if (id === null || value === null) {
    throw new Error("dash-command-write: --id <hex> and --value <n> are both required, e.g. --id 0x15 --value 1");
  }
  if (id < 0 || id > HIGHEST_COMMAND_ID) {
    throw new Error(`dash-command-write: id 0x${hex(id)} is outside the 0x00…0x7F command range`);
  }
  if (value < 0 || value > 0xff) {
    throw new Error(`dash-command-write: value ${value} does not fit in one byte (0…255)`);
  }
  if (holdSeconds < 0) {
    throw new Error(`dash-command-write: --hold ${holdSeconds} must be ≥ 0`);
  }
  if (WRITE_ALLOWLIST[id] === undefined && !forceId) {
    const allowed = Object.keys(WRITE_ALLOWLIST)
      .map(key => `0x${hex(Number(key))}`)
      .join(", ");
    throw new Error(
      `dash-command-write: refusing to write 0x${hex(id)} — only ${allowed} (the light-labelled ids) are allowed. ` +
        "Pass --force-id to write another id (charge/map/fan config) at your own risk."
    );
  }

  return { id, value, holdSeconds, restore };
}

function parseNumeric(raw: string | undefined, flag: string): number {
  if (raw === undefined) {
    throw new Error(`dash-command-write: ${flag} needs a value`);
  }
  const radix = raw.startsWith("0x") || raw.startsWith("0X") ? 16 : 10;
  const parsed = Number.parseInt(raw, radix);
  if (Number.isNaN(parsed)) {
    throw new Error(`dash-command-write: ${flag} value "${raw}" is not a number`);
  }
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

function describe(reply: CommandReply): string {
  if (reply.status === "silent") {
    return "silent (no reply)";
  }
  if (reply.status === "unsupported") {
    return "unsupported (echoed, no data)";
  }
  return `live — ${bytes(reply.payload)}`;
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function bytes(data: Uint8Array): string {
  if (data.length === 0) {
    return "(none)";
  }
  return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join(" ");
}
