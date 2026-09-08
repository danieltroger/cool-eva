import { decodeFrame } from "../src/can/decode.ts";
import {
  buildChargeCurrentCommand,
  decodeChargeCurrentCommand,
  CHARGE_COMMAND_CAN_ID,
  type ChargeMode,
} from "../src/can/charge-command.ts";
import { monotonicNow, since } from "../src/monotonic.ts";

// GARAGE VALIDATION for the "change the charge current mid-session" feature — the one
// experiment that decides whether the feature is buildable at all. It answers a single
// question the corpus cannot: will the VCU honour a 0x121 charge-current command that the
// PI injects, given the bike's own dash is the legitimate sender on that id?
//
//   sudo systemctl stop cool-eva     # the service owns can0; one raw socket at a time
//   node --experimental-strip-types scripts/probe-charge-command.ts --mode ac --amps 6 [opts]
//     --mode ac|dc     which opcode (0x1A / 0x18). Match the live charge type.
//     --amps N         the current to command, whole amps
//     --ceiling N      b4, the paired ceiling. Default 75 for dc; for ac it is a GUESS (see below)
//     --repeat N       send the frame N times, 500 ms apart (default 1) — 0x121 is an event
//     --watch S        seconds to watch the response before and after (default 25)
//     --dry-run        print the crafted bytes and the round-trip, send NOTHING
//     --listen         TRANSMIT nothing: bring can0 up listen-only and print every raw 0x121
//                      frame the DASH sends. Change the AC current on the bike's own screen
//                      through known values to read the real byte layout — this is how the AC
//                      opcode/encoding gets reverse-engineered when our guessed frame is ignored.
//
// ⚠️ This TRANSMITS on the bike's bus. It is safe-by-design in three ways and it is worth
// knowing why before pressing enter: the VCU clamps a request above its own ceiling
// (charge-setpoint.ts §"dialling up is NOT obeyed"), the setting is transient (unplugging
// resets it), and the rider can override it on the bike's own screen at any time. LOWERING
// the current is the benign direction and is what this should be tried with first.
//
// ⚠️ b4/ceiling for AC is unproven. No bus signal states the AC ceiling this byte should
// carry, so --ceiling for --mode ac is a guess; if the AC command is ignored, a wrong b4 is
// the first thing to vary. For DC, fast_dc_limit_max_a broadcasts the 75 that belongs here.
//
// VERDICT: watch dc_charge_limit_selected_a (0x121, the dash's own echo of the setting),
// charge_limit_a (0x10A, the AC setpoint) and the delivered current (dc_a / mains_a). If any
// of them steps to the commanded value within a few seconds of the send, injection WORKS and
// the feature is buildable. If nothing moves, the VCU ignores a Pi-sourced 0x121 and the
// feature is not possible by this route — record that and stop.

const WATCHED_KEYS = [
  "dc_charge_limit_selected_a",
  "charge_limit_a",
  "ac_supply_limit_a",
  "fast_dc_limit_max_a",
  "fast_dc_target_a",
  "charge_type",
  "dc_a",
  "mains_a",
  "dc_v",
  "mains_v",
];

const options = parseArguments(process.argv.slice(2));

if (options.listen) {
  await runListen(options.watchSeconds);
  process.exit(0);
}

// A builder checked only against its own output proves nothing — so refuse to transmit
// anything until the frame round-trips through the VCU's own decode shape.
selfCheckCodec();

const frames = buildChargeCurrentCommand(options.mode, options.amps, options.ceiling);
console.log(
  `\ncrafted charge-current pair: ${frames.map(f => `0x${f.id.toString(16)} ${hex(f.data)}`).join("  ")}` +
    `  (mode=${options.mode} selected=${options.amps} A ceiling=${options.ceiling} A)`
);

if (options.dryRun) {
  console.log("--dry-run: nothing was transmitted.");
  process.exit(0);
}

const latest = new Map<string, number>();

// Imported here, not at the top, so --dry-run and the codec self-check run on macOS/CI where
// socketcan (a Linux-only optionalDependency) is not built. Only the transmit path needs it.
const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("\nbringing can0 up ACTIVE (TX enabled) and watching the bus…");
await bringUpCan("can0", true);
const channel = openChannel("can0");
channel.addListener("onMessage", message => {
  for (const { key, value } of decodeFrame(message.id, message.data)) {
    if (WATCHED_KEYS.includes(key)) {
      latest.set(key, value);
    }
  }
});
channel.start();

await watchWindow("BEFORE", options.watchSeconds);

console.log(`\n→ transmitting the pair (0x120 commit twin, then 0x121) ${options.repeat}×…`);
for (let sent = 0; sent < options.repeat; sent++) {
  for (const frame of frames) {
    try {
      channel.send({ id: frame.id, ext: false, rtr: false, data: Buffer.from(frame.data) });
    } catch (error) {
      console.error("send failed — is the cool-eva service still holding can0? Stop it and retry.", error);
      process.exit(1);
    }
    await sleep(5);
  }
  await sleep(500);
}

await watchWindow("AFTER", options.watchSeconds);

console.log(
  "\nVerdict is yours to read: did dc_charge_limit_selected_a / charge_limit_a / the delivered\n" +
    "current step toward the commanded value? If yes, injection works. If nothing moved, the VCU\n" +
    "ignores a Pi-sourced 0x121 — write that in docs/ and the feature stops here."
);
process.exit(0);

// ── helpers ──────────────────────────────────────────────────────────────────

// Listen-only capture of the dash's own 0x121 frames. No TX, so it is safe to run with
// nothing to command — the point is to read the REAL byte layout off the bike when our
// guessed AC frame is ignored: dial the AC current on the bike's screen through known
// values and match the byte that tracks them.
async function runListen(seconds: number): Promise<void> {
  const { bringUpCan, openChannel } = await import("../src/can/socket.ts");
  console.log("\nbringing can0 up LISTEN-ONLY (no TX) and watching 0x121…");
  console.log("→ now change the AC charge current on the bike's OWN screen through a few values.");
  await bringUpCan("can0", false);
  const channel = openChannel("can0");
  const started = monotonicNow();
  let lastPayload = "";
  channel.addListener("onMessage", message => {
    if (message.id !== CHARGE_COMMAND_CAN_ID) return;
    const payload = hex(message.data);
    if (payload === lastPayload) return; // dedupe: 0x121 repeats the same frame between events
    lastPayload = payload;
    const decoded = decodeChargeCurrentCommand(message.data);
    const stamp = (since(started) / 1000).toFixed(1);
    console.log(`t+${stamp}s  0x121  ${payload}  ${decoded ? JSON.stringify(decoded) : "(not a current-limit frame)"}`);
  });
  channel.start();
  await sleep(seconds * 1000);
  console.log("\nlisten window closed. The byte that tracked your dashed-in values is the AC current field.");
}

async function watchWindow(label: string, seconds: number): Promise<void> {
  const deadline = seconds;
  for (let elapsed = 0; elapsed < deadline; elapsed += 1) {
    await sleep(1000);
  }
  console.log(`\n[${label}]  ${snapshot()}`);
}

function snapshot(): string {
  return WATCHED_KEYS.map(key => (latest.has(key) ? `${key}=${latest.get(key)}` : `${key}=—`)).join("  ");
}

function selfCheckCodec(): void {
  // The decoder reads the 0x121 command frame — the half that carries the ceiling — so pick it
  // out of the pair the builder now returns.
  const built = buildChargeCurrentCommand(options.mode, options.amps, options.ceiling);
  const command = built.find(frame => frame.id === CHARGE_COMMAND_CAN_ID);
  const roundTrip = command ? decodeChargeCurrentCommand(command.data) : null;
  if (
    roundTrip === null ||
    roundTrip.mode !== options.mode ||
    roundTrip.selectedAmps !== options.amps ||
    roundTrip.ceilingAmps !== options.ceiling
  ) {
    throw new Error(`charge-command codec self-check failed: round-trip was ${JSON.stringify(roundTrip)}`);
  }
  console.log("codec self-check ok (build → decode round-trips).");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" ");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface Options {
  mode: ChargeMode;
  amps: number;
  ceiling: number;
  repeat: number;
  watchSeconds: number;
  dryRun: boolean;
  listen: boolean;
}

function parseArguments(argv: string[]): Options {
  let mode: ChargeMode | null = null;
  let amps: number | null = null;
  let ceiling: number | null = null;
  let repeat = 1;
  let watchSeconds = 25;
  let dryRun = false;
  let listen = false;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => argv[++index];
    if (flag === "--mode") {
      const value = next();
      if (value !== "ac" && value !== "dc") {
        throw new Error(`--mode must be ac or dc, got ${value}`);
      }
      mode = value;
    } else if (flag === "--amps") {
      amps = Number(next());
    } else if (flag === "--ceiling") {
      ceiling = Number(next());
    } else if (flag === "--repeat") {
      repeat = Number(next());
    } else if (flag === "--watch") {
      watchSeconds = Number(next());
    } else if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--listen") {
      listen = true;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }

  // --listen transmits nothing, so it needs neither a mode nor an amps; give the unused fields
  // harmless placeholders rather than thread nullability through a path that never reads them.
  if (listen) {
    // A listen window of a few seconds is uselessly short — default it long enough to dial a
    // couple of values on the dash, but honour an explicit --watch if the caller gave one.
    if (watchSeconds === 25) {
      watchSeconds = 120;
    }
    return { mode: mode ?? "ac", amps: amps ?? 1, ceiling: ceiling ?? 32, repeat, watchSeconds, dryRun, listen };
  }

  if (mode === null || amps === null) {
    throw new Error("required: --mode ac|dc and --amps N. See the header for the full option list.");
  }
  // 75 is fast_dc_limit_max_a, broadcast on a merely-awake bike, so it is the right DC default.
  // 15 is the AC ceiling (b4=0x0f) the DASH's own 0x121 frames carry — captured 2026-08-25 with
  // --listen; it is NOT ac_supply_limit_a (31), it is the pilot/cable rating, and is likely
  // charger-specific, so echo the dash's last b4 rather than trust this default off the bench.
  if (ceiling === null) {
    ceiling = mode === "dc" ? 75 : 15;
  }
  return { mode, amps, ceiling, repeat, watchSeconds, dryRun, listen };
}
