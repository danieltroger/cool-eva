// Enables / disables the VCU's "LPR mode" — dash command 0x15 on the 0x120/0x121 command channel
// (the service tool's dash-command name table: "LPR mode, 0 = off / 1 = on"). Confirmed on-bike 2026-08-27:
// writing 0x15 = 1 makes the dash read "LPR mode active", and the value persists as a stored setting
// (it survives the script exiting), unlike the decaying 0x2F diagnostic force. What "LPR" stands for
// is not spelled out anywhere in the vendor tool. It is NOT a light control — toggling it moved the
// dash but no beam, lamp, or DRL (the headlight hunt continues; see docs/dash-command-channel.md).
//
// A write is b0 = (0x15 | 0x80) = 0x95, b1 = 0xFF, b2 = value, on 0x120 alone — the same frame class
// the shipping charge-stop/RTC writes use, NOT the 0x2F/0x27 diagnostic route. No session needed.
//
//   sudo systemctl stop cool-eva     # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/lpr-mode.ts --on    # enable (leaves it on)
//   sudo node --experimental-strip-types scripts/lpr-mode.ts --off   # disable
//   sudo node --experimental-strip-types scripts/lpr-mode.ts         # read current state, no write

// No static import (socket.ts is loaded dynamically below so tsc/CI don't pull in
// the Linux-only socketcan native build); this marks the file a module for top-level await.
export {};

const DASH_COMMAND_REQUEST_ID = 0x120; // VCU_COMMAND_REQ — we transmit here (reads and writes)
const DASH_COMMAND_RESPONSE_ID = 0x121; // VCU_COMMAND_RES — the VCU answers reads here
const SEPARATOR_BYTE = 0xff; // b1 in every frame on this channel
const WRITE_BIT = 0x80; // b0 bit 7: set = write, clear = read
const COMMAND_ID_MASK = 0x7f; // b0 low 7 bits = the command id
const READ_TIMEOUT_MS = 150; // a live id answers in a few ms; this is how long we wait on silence
const WRITE_SETTLE_MS = 40; // let the VCU store the write before the confirming read-back
const LPR_MODE_COMMAND_ID = 0x15; // the "LPR mode" dash command

type LprAction = "on" | "off" | "status";
type CommandStatus = "live" | "unsupported" | "silent";

interface CommandReply {
  status: CommandStatus;
  payload: Uint8Array; // bytes 2.. of the 0x121 reply (empty unless live)
}

const action = parseAction(process.argv.slice(2));

const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("bringing can0 up ACTIVE (TX enabled)…");
await bringUpCan("can0", true);
const channel = openChannel("can0");

// One request is outstanding at a time, so a single resolver keyed to 0x15 is enough. 0x121 also
// carries unsolicited charge telemetry, so the listener drops any frame whose id does not match.
let pending: { cmd: number; resolve: (reply: CommandReply) => void } | null = null;
channel.addListener("onMessage", message => {
  if (message.id !== DASH_COMMAND_RESPONSE_ID || pending === null) {
    return;
  }
  const data = Uint8Array.from(message.data);
  if (data.length < 1 || (data[0] & COMMAND_ID_MASK) !== pending.cmd) {
    return; // a reply for another id, or unsolicited traffic on 0x121
  }
  const supported = (data[0] & WRITE_BIT) === 0;
  const resolve = pending.resolve;
  pending = null;
  resolve({ status: supported ? "live" : "unsupported", payload: data.subarray(2) });
});
channel.start();

await runLprMode(action);

process.exit(0);

// ── enable / disable / read LPR mode ────────────────────────────────────────────

async function runLprMode(action: LprAction): Promise<void> {
  const before = await readLprMode();
  console.log(`  current: ${describeMode(before)}`);

  if (action === "status") {
    return;
  }

  const target = action === "on" ? 1 : 0;
  console.log(`  writing LPR mode = ${target} on 0x120 (b0 = 0x${hex(LPR_MODE_COMMAND_ID | WRITE_BIT)})…`);
  writeLprMode(target);
  await delay(WRITE_SETTLE_MS);

  const after = await readLprMode();
  console.log(`  now:     ${describeMode(after)}`);
  if (after.status !== "live" || after.value !== target) {
    console.log(`  ✗ LPR mode did NOT read back as ${target} — the write did not take.`);
    return;
  }
  if (action === "on") {
    console.log('  ✓ LPR mode ENABLED — the dash should now read "LPR mode active". Left on; run --off to clear.');
  } else {
    console.log("  ✓ LPR mode disabled.");
  }
}

/** Write LPR mode: b0 = 0x15|0x80, b1 = 0xFF, b2 = value, on 0x120 alone. Fire-and-forget (no ack). */
function writeLprMode(value: number): void {
  const frame = Buffer.alloc(8);
  frame[0] = LPR_MODE_COMMAND_ID | WRITE_BIT;
  frame[1] = SEPARATOR_BYTE;
  frame[2] = value & 0xff;
  channel.send({ id: DASH_COMMAND_REQUEST_ID, ext: false, rtr: false, data: frame });
}

interface LprState {
  status: CommandStatus;
  value: number | null; // b2 of the reply when live, else null
  raw: Uint8Array;
}

/** Read LPR mode (bit 7 clear): send the request, wait for the 0x121 reply, extract b2 as the value. */
function readLprMode(): Promise<LprState> {
  return new Promise<LprState>(resolve => {
    const timer = setTimeout(() => {
      if (pending !== null && pending.cmd === LPR_MODE_COMMAND_ID) {
        pending = null;
        resolve({ status: "silent", value: null, raw: new Uint8Array() });
      }
    }, READ_TIMEOUT_MS);
    pending = {
      cmd: LPR_MODE_COMMAND_ID,
      resolve: reply => {
        clearTimeout(timer);
        const value = reply.status === "live" && reply.payload.length > 0 ? reply.payload[0] : null;
        resolve({ status: reply.status, value, raw: reply.payload });
      },
    };
    const frame = Buffer.alloc(8);
    frame[0] = LPR_MODE_COMMAND_ID & COMMAND_ID_MASK; // bit 7 clear — this is a read
    frame[1] = SEPARATOR_BYTE;
    channel.send({ id: DASH_COMMAND_REQUEST_ID, ext: false, rtr: false, data: frame });
  });
}

function parseAction(argv: string[]): LprAction {
  for (const arg of argv) {
    if (arg !== "--on" && arg !== "--off" && arg !== "--status") {
      throw new Error(`lpr-mode: unknown argument "${arg}". Use --on, --off, or nothing (reads state).`);
    }
  }
  const chosen = ["--on", "--off", "--status"].filter(flag => argv.includes(flag));
  if (chosen.length > 1) {
    throw new Error(`lpr-mode: pass only one of --on / --off / --status, got ${chosen.join(" ")}`);
  }
  if (argv.includes("--on")) {
    return "on";
  }
  if (argv.includes("--off")) {
    return "off";
  }
  return "status"; // default (and explicit --status): read-only, no write
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

function describeMode(state: LprState): string {
  if (state.status === "silent") {
    return "no reply (0x15 silent)";
  }
  if (state.status === "unsupported") {
    return "unsupported on this bike";
  }
  const name = state.value === 1 ? "ON" : state.value === 0 ? "off" : `value ${state.value}`;
  return `${name} (raw ${bytes(state.raw)})`;
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
