import { createInterface } from "node:readline/promises";
import { canIdsFor, parseResponseFrame, toHex } from "../src/vcu/param-codec.ts";
import { decodeFrame } from "../src/can/decode.ts";
import { CHARGE_BMS_COMMAND_CAN_ID, CHARGE_STATE_CAN_ID } from "../src/can/charge-manager.ts";

// Reboots the two VCU micros with UDS ECUReset (service 0x11, sub-function 0x02 = keyOffOnReset) —
// the same key-cycle restart the manufacturer's service tool performs between installation steps. Nothing
// is erased and no setting is reverted; the ECUs simply drop off the bus for a second or two and come
// back. Proven in the service-tool analysis (its ResetVCU); this is its port.
//
//   sudo systemctl stop cool-eva      # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/reboot-vcu.ts            # interlock check + confirm prompt
//   sudo node --experimental-strip-types scripts/reboot-vcu.ts --yes      # skip the interactive confirm
//
// ⚠️ BOTH nodes are always restarted, back-to-back, and sessions are opened on both BEFORE the first
// reset — exactly as the service tool's ResetVCU does. The two processors watch each other: restart one alone
// and its partner sees it drop off the bus and latches a fault (a U1000). That is how "restart the
// selected node" on 0xA9 once put a bike into error, so there is deliberately no single-node mode here.
//
// ⚠️ Deliberately crosses this repo's standing ban on transmitting 0x11 — every shipped codec
// (param-codec.ts, write-codec.ts) refuses ECUReset by construction. This is a SCRATCH probe on the
// same footing as scripts/beam-threshold.ts and scripts/headlight-off.ts: it reuses param-codec's
// proven CAN-id/response helpers but builds the reset frame itself, because no shipped path will.
//
// ⚠️ Do not reset the VCU mid-charge — a live charge session is managed by these controllers, and
// ECUReset is also the charge manager's bootloader-entry service (docs/vcu-parameters.md). The
// interlock refuses (no override) if the charge-session frames (0x605/0x610) are broadcasting or the
// bike is moving. It keys on those frames' PRESENCE, NOT the 0x625 b4 flag: that flag's DC bit is
// read inverted and an all-zero idle byte decodes to a spurious `dc_charging` — which false-refused a
// legitimate parked reset on 2026-08-27. Reset needs only a diagnostic session — no SecurityAccess
// (0x27) unlock — matching the service tool's reset path.
//
// PRECONDITIONS: bike stationary and awake (key ON), NOT charging, on its stand. If a fault stays
// latched afterwards, key off for 30 s and on — a real power cycle clears what a reset leaves behind.

const NODES = [
  { name: "VCU-Control", address: 0xa9 },
  { name: "VCU-Safety", address: 0xa8 },
] as const;
type Node = (typeof NODES)[number];

const SERVICE_START_SESSION = 0x10;
const STANDARD_SESSION = 0x81;
const SERVICE_ECU_RESET = 0x11;
const RESET_KEY_OFF_ON = 0x02; // keyOffOnReset — the only mode the service tool uses on the bike (a restart, not a factory reset)
const NEGATIVE_RESPONSE = 0x7f;

// How long to sample the broadcast bus for the safety interlock before touching anything.
const INTERLOCK_WINDOW_MS = 1500;
// Above this the bike is moving, not parked. Chosen well below any real riding speed but above the
// noise floor of a stationary 0x104 reading.
const MAX_STATIONARY_KMH = 3;

const NRC_NAMES: Record<number, string> = {
  0x11: "serviceNotSupported",
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

const options = parseArguments(process.argv.slice(2));

// Both micros share one request/response pair (0x7C0 / 0x7E0) and differ only by the address byte,
// so a single id pair drives the whole sequence.
const { request: REQUEST_CAN_ID, response: RESPONSE_CAN_ID } = canIdsFor("A8");

console.log(`reboot-vcu — restarts ${NODES.map(node => `${node.name} (0x${node.address.toString(16)})`).join(" + ")}`);
console.log(
  `  request ${hexId(REQUEST_CAN_ID)} / response ${hexId(RESPONSE_CAN_ID)}, ECUReset mode ${RESET_KEY_OFF_ON}`
);
console.log("⚠️  Bike stationary, key ON, NOT charging, on its stand. Both VCU nodes restart together.");

// Dynamic import so arg parsing works on macOS/CI where socketcan is not built.
const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("\nbringing can0 up ACTIVE (TX enabled)…");
await bringUpCan("can0", true);
const channel = openChannel("can0");

// Latest value seen for each broadcast signal the interlock cares about, updated as frames arrive.
const liveSignals = new Map<string, number>();
// CAN ids that only broadcast while an actual charge session is up. Their PRESENCE is the charge
// interlock — not the 0x625 b4 flag, whose DC bit reads inverted and decodes an all-zero idle byte to
// a spurious `dc_charging` (see charge-manager.ts and the on-bike false positive of 2026-08-27).
const CHARGE_SESSION_CAN_IDS = new Set<number>([CHARGE_BMS_COMMAND_CAN_ID, CHARGE_STATE_CAN_ID]);
const chargeSessionIdsSeen = new Set<number>();
let pending: ((reply: Reply) => void) | null = null;

channel.addListener("onMessage", message => {
  if (CHARGE_SESSION_CAN_IDS.has(message.id)) {
    chargeSessionIdsSeen.add(message.id);
  }
  // Feed every broadcast frame through the shipped decoders so the interlock reads the same numbers
  // the dashboard would. The VCU reply id is handled separately below.
  const data = Buffer.from(message.data);
  for (const reading of decodeFrame(message.id, data)) {
    if (typeof reading.value === "number") {
      liveSignals.set(reading.key, reading.value);
    }
  }

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
  if (!(await interlockPasses())) {
    return;
  }

  // Open a session on EVERY node BEFORE the first reset, like the service tool's ResetVCU: opening the second
  // node's session after the first is already down is one more round trip during which the partner
  // sees it gone and stores a fault.
  for (const node of NODES) {
    console.log(`\n→ StartDiagnosticSession on ${node.name} (10 81)`);
    const session = await transact(node, [SERVICE_START_SESSION, STANDARD_SESSION]);
    if (!session.ok) {
      console.log(`  ✗ ${node.name} refused the session: ${describe(session)}`);
      console.log("    Without a session on both nodes nothing here proceeds. Is the key ON and the bike awake?");
      return;
    }
    console.log("  ✓ session open");
  }

  if (!(await confirm())) {
    console.log("\naborted — nothing was sent.");
    return;
  }

  // Reset every node back-to-back. The ECU drops its session on the way down, so there is no
  // teardown to do and no reply to depend on (the reply usually never arrives — the bus goes quiet).
  for (const node of NODES) {
    console.log(`\n→ ECUReset on ${node.name} (11 02)`);
    const reset = await transact(node, [SERVICE_ECU_RESET, RESET_KEY_OFF_ON], { timeoutMs: 400, quietTimeout: true });
    if (reset.negativeCode !== null) {
      console.log(`  ✗ ${node.name} refused the reset: ${describe(reset)}`);
      console.log("    A partner may already be restarting — key off for 30 s and on to be sure of a clean state.");
      return;
    }
    // A positive 0x51 or silence (the ECU rebooted before replying) both mean the request was taken.
    console.log(reset.ok ? "  ✓ reset accepted (51)" : "  ✓ reset issued (no reply — the ECU is rebooting)");
  }

  console.log("\nboth VCU nodes are restarting — the bus goes quiet for a second or two.");
  console.log("waiting for them to come back…");
  await delay(2500);
  await confirmBackOnBus();
  console.log(
    "\ndone. If the dash still shows a fault, key off for 30 s and on — a real power cycle clears what a reset leaves latched."
  );
}

/** Sample the broadcast bus and refuse if the bike is moving or charging. Hard refusal — no override. */
async function interlockPasses(): Promise<boolean> {
  console.log(`\nchecking the bus for ${INTERLOCK_WINDOW_MS} ms (must be stationary and not charging)…`);
  await delay(INTERLOCK_WINDOW_MS);

  const speed = liveSignals.get("speed_can_kmh") ?? null;
  const sawAnyFrame = liveSignals.size > 0;

  if (chargeSessionIdsSeen.size > 0) {
    const ids = [...chargeSessionIdsSeen].map(id => `0x${id.toString(16)}`).join(", ");
    console.log(`  ✗ REFUSED: a charge session is live (${ids} broadcasting). Do not reset mid-charge.`);
    return false;
  }
  if (speed !== null && speed > MAX_STATIONARY_KMH) {
    console.log(`  ✗ REFUSED: bike is moving (${speed} km/h > ${MAX_STATIONARY_KMH}). Do this stationary.`);
    return false;
  }
  if (!sawAnyFrame) {
    console.log("  ⚠️  saw no broadcast traffic — cannot confirm the bike is stationary or idle.");
    console.log("      Proceeding only on your explicit confirmation below. Make sure it is parked and unplugged.");
    return true;
  }
  console.log(`  ✓ stationary (${speed ?? "speed unseen"} km/h) and not charging — clear to proceed.`);
  return true;
}

/** Poll for the bike answering a session again, so the operator knows it came back rather than hung. */
async function confirmBackOnBus(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await transact(NODES[0], [SERVICE_START_SESSION, STANDARD_SESSION], {
      timeoutMs: 800,
      quietTimeout: true,
    });
    if (session.ok) {
      console.log(`  ✓ ${NODES[0].name} is answering again — the VCU is back up.`);
      return;
    }
    await delay(1000);
  }
  console.log(
    "  ⚠️  the VCU has not answered a session yet. Give it a few more seconds, or key off/on if it stays silent."
  );
}

// ── confirmation ───────────────────────────────────────────────────────────────

async function confirm(): Promise<boolean> {
  if (options.assumeYes) {
    console.log("\n--yes given — restarting both VCU nodes without prompting.");
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "\nRestart BOTH VCU nodes now? This is a key-cycle restart — nothing is erased. [type 'reboot' to confirm] "
    );
    return answer.trim().toLowerCase() === "reboot";
  } finally {
    rl.close();
  }
}

// ── transport ────────────────────────────────────────────────────────────────

/** One request/response exchange to a specific node. Extended-addressed single frame; reply to the tester. */
function transact(
  node: Node,
  payload: number[],
  config: { timeoutMs?: number; quietTimeout?: boolean } = {}
): Promise<Reply> {
  const timeoutMs = config.timeoutMs ?? 600;
  if (payload.length > 6) {
    throw new Error(`reboot-vcu: payload of ${payload.length} bytes does not fit one extended-addressed frame`);
  }
  const frame = Buffer.alloc(8);
  frame[0] = node.address;
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

// ── helpers ──────────────────────────────────────────────────────────────────

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function hexId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

interface Options {
  assumeYes: boolean; // --yes: skip the interactive confirmation (the interlock still applies)
}

function parseArguments(argv: string[]): Options {
  let assumeYes = false;
  for (const flag of argv) {
    if (flag === "--yes" || flag === "-y") {
      assumeYes = true;
    } else {
      throw new Error(`unknown argument ${flag}. See the header for options.`);
    }
  }
  return { assumeYes };
}
