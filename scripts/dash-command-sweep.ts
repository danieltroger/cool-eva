// Reads every command id on the VCU's 0x120/0x121 dashboard command channel — the same injectable
// channel that already carries charge-stop (0x16), charge-current (0x18/0x1A) and the RTC clock
// (0x14). READ-ONLY: every request here has bit 7 CLEAR, which the factory tool documents as
// non-mutating — a read cannot change a setting (the service tool's dash-read path, and
// energica-rnd's dashboard-settings.md "proven not to change anything").
//
// The point is to map which command ids THIS bike honours. The service-tool analysis was mapped on an SS9,
// where ~19 of the 128 ids answered and only a handful are labelled — and we are hunting a
// non-diagnostic light control. 0x2A ("Light in charge") and 0x15 ("LPR mode") are the labelled
// light-related ids, but an UNLABELLED live id could be a general beam control, so the sweep lists
// every live id and flags the ones nobody has named. See docs/headlight-charge-interlock.md.
//
//   sudo systemctl stop cool-eva     # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/dash-command-sweep.ts
//
// Protocol: send [cmd, 0xFF, 0,0,0,0,0,0] on 0x120, read 0x121 for a frame whose (b0 & 0x7F) == cmd.
// b0 bit 7 set in the reply = "unsupported" (the VCU echoes the id, no data); data present = "live",
// value in bytes 2..; no reply = "silent". This NEVER sets bit 7 on a request, so it can only read.
// WRITING a command id (bit 7 set) is a separate, UNTESTED operation and is deliberately absent.

// No static import (socket.ts is loaded dynamically below so tsc/CI don't pull in
// the Linux-only socketcan native build); this marks the file a module for top-level await.
export {};

const DASH_COMMAND_REQUEST_ID = 0x120; // VCU_COMMAND_REQ — we transmit read requests here
const DASH_COMMAND_RESPONSE_ID = 0x121; // VCU_COMMAND_RES — the VCU answers here
const SEPARATOR_BYTE = 0xff; // b1 in every frame on this channel (charge-command.ts calls it that)
const WRITE_BIT = 0x80; // b0 bit 7: set = write/echo, clear = read. We only ever clear it.
const HIGHEST_COMMAND_ID = 0x7f; // 7-bit id space (0..127); bit 7 is the read/write flag
const READ_TIMEOUT_MS = 150; // a live id answers in a few ms; this is how long we wait on silence

// The ids the service-tool analysis could put a name to (its dash-command name table). Light-related ones
// are the reason for this sweep; the rest are here so a live reply is recognised, not re-derived.
const KNOWN_COMMANDS: Record<number, string> = {
  0x01: "Ride map",
  0x02: "Regen map",
  0x15: "LPR mode (0=off / 1=on)",
  0x18: "DC charge current (value, min, max)",
  0x1a: "AC charge current (value, min, max)",
  0x2a: "Light in charge (0=off / 1=on)",
  0x2b: "Fan limit % (30-100)",
  0x2c: "Charge limit % (0=no limit)",
};

// The light-related ids we most want a verdict on.
const LIGHT_COMMAND_IDS = [0x2a, 0x15];

type CommandStatus = "live" | "unsupported" | "silent";

interface SweepReply {
  status: CommandStatus;
  payload: Uint8Array; // bytes 2.. of the 0x121 reply (empty unless live)
}

const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("dash command-channel sweep — READ-ONLY (bit 7 clear). Reading ids 0x00..0x7F on 0x120/0x121.");
console.log("bringing can0 up ACTIVE (TX enabled)…");
await bringUpCan("can0", true);
const channel = openChannel("can0");

// One request is outstanding at a time, so a single resolver keyed to the id we asked for is enough.
// 0x121 also carries unsolicited charge telemetry, so the listener drops any frame whose id does not
// match the command we are currently reading.
let pending: { cmd: number; resolve: (reply: SweepReply) => void } | null = null;
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

await runSweep();

process.exit(0);

// ── the sweep ───────────────────────────────────────────────────────────────

async function runSweep(): Promise<void> {
  const live: Array<{ cmd: number; payload: Uint8Array }> = [];
  const counts: Record<CommandStatus, number> = { live: 0, unsupported: 0, silent: 0 };

  for (let cmd = 0; cmd <= HIGHEST_COMMAND_ID; cmd += 1) {
    const reply = await readCommand(cmd);
    counts[reply.status] += 1;
    if (reply.status === "live") {
      live.push({ cmd, payload: reply.payload });
      const label = KNOWN_COMMANDS[cmd] ?? "(unlabelled)";
      console.log(`  0x${hex(cmd)}  live         reply ${bytes(reply.payload).padEnd(17)}  ${label}`);
    }
  }

  console.log(`\nswept 128 ids: ${counts.live} live, ${counts.unsupported} unsupported, ${counts.silent} silent`);

  console.log("\nlight-related ids:");
  for (const cmd of LIGHT_COMMAND_IDS) {
    const found = live.find(entry => entry.cmd === cmd);
    const state = found ? `LIVE — reply ${bytes(found.payload)}` : "not live on this bike";
    console.log(`  0x${hex(cmd)}  ${KNOWN_COMMANDS[cmd]}: ${state}`);
  }

  const unlabelled = live.filter(entry => KNOWN_COMMANDS[entry.cmd] === undefined);
  console.log("\nunlabelled live ids (candidates for an undiscovered control):");
  if (unlabelled.length === 0) {
    console.log("  none — every live id is already named.");
  } else {
    for (const entry of unlabelled) {
      console.log(`  0x${hex(entry.cmd)}  reply ${bytes(entry.payload)}`);
    }
  }
}

/** Read one command id: send the read request, wait for its 0x121 reply, classify live/unsupported/silent. */
function readCommand(cmd: number): Promise<SweepReply> {
  return new Promise<SweepReply>(resolve => {
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
    frame[0] = cmd & HIGHEST_COMMAND_ID; // bit 7 forced clear — this is a read, never a write
    frame[1] = SEPARATOR_BYTE;
    channel.send({ id: DASH_COMMAND_REQUEST_ID, ext: false, rtr: false, data: frame });
  });
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
