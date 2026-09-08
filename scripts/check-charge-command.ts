import {
  CAPTURED_DC_CEILING_A,
  CAPTURED_DC_PAIRS,
  CAPTURED_NON_COMMAND_FRAMES,
  CAPTURED_PAIR_GAP_MS_RANGE,
  CAPTURED_PI_SINGLE_FRAMES,
  fixtureBytes,
} from "./charge-command-fixtures.ts";
import {
  CHARGE_COMMAND_CAN_ID,
  CHARGE_REQUEST_CAN_ID,
  buildChargeCurrentCommand,
  buildChargeStopCommand,
  decodeChargeCurrentCommand,
} from "../src/can/charge-command.ts";
import { decodeChargeSetpointFrame } from "../src/can/charge-setpoint.ts";
import { CURRENT_FRAME_GAP_MS } from "../src/vcu/write-session.ts";
import { toHex } from "../src/vcu/param-codec.ts";

// Holds the charge-current transmitter against the frames the DASH itself put on the bus
// during a real DC fast charge (2026-09-07), on a laptop, with no bike.
//
//   node --experimental-strip-types scripts/check-charge-command.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ WHAT IT DOES AND DOES NOT GUARD. The 2026-09-07 failure was a STALE DEPLOY, so every
// assertion here would have passed all day; reporting the running commit is what catches that
// (src/version.ts). This guards the shape going wrong again in CODE: §1 fails the moment the
// builder emits one frame instead of two.
//
// The fixture is a real candump, byte for byte, so "the frame we send is the frame the dash
// sends" is a claim about the motorcycle rather than about our own arithmetic.
// docs/can-0x121-charge-command.md § "the deploy, not the design".

const failures: string[] = [];

// ── §1 the pair, against the dash's own DC frames ──────────────────────────
//
// The regression that cost 2026-09-07 is a builder that emits ONE frame. Asserted first and
// separately from the byte comparison, because "wrong bytes" and "half the sequence" fail for
// different reasons and the second one is the one that has already happened.
for (const pair of CAPTURED_DC_PAIRS) {
  const frames = buildChargeCurrentCommand("dc", pair.amps, CAPTURED_DC_CEILING_A);
  if (frames.length !== 2) {
    failures.push(`§1 ${pair.amps} A: builder emitted ${frames.length} frame(s), not the dash's pair`);
    continue;
  }
  if (frames[0].id !== CHARGE_REQUEST_CAN_ID || frames[1].id !== CHARGE_COMMAND_CAN_ID) {
    failures.push(
      `§1 ${pair.amps} A: ids are 0x${frames[0].id.toString(16)}/0x${frames[1].id.toString(16)}, ` +
        `not 0x120 then 0x121 — the commit twin must go first, as the dash sends it`
    );
    continue;
  }
  const commit = toHex(frames[0].data);
  const command = toHex(frames[1].data);
  if (commit !== pair.commitHex) {
    failures.push(`§1 ${pair.amps} A at ${pair.atLocal}: 0x120 built "${commit}", dash sent "${pair.commitHex}"`);
  }
  if (command !== pair.commandHex) {
    failures.push(`§1 ${pair.amps} A at ${pair.atLocal}: 0x121 built "${command}", dash sent "${pair.commandHex}"`);
  }
}

// ── §2 the builder never reproduces the pre-twin shape ─────────────────────
//
// The negative fixture. Each of these is what the bike really transmitted on 2026-09-07, and
// none of them may be a thing this builder can produce for the same request.
for (const single of CAPTURED_PI_SINGLE_FRAMES) {
  const frames = buildChargeCurrentCommand("dc", single.amps, CAPTURED_DC_CEILING_A);
  const onlyFrame = frames.length === 1 && toHex(frames[0].data) === single.commandHex;
  if (onlyFrame) {
    failures.push(
      `§2 ${single.amps} A: the builder reproduced the pre-twin single frame "${single.commandHex}" that failed ` +
        `on-bike at ${single.atLocal} — the 0x120 commit twin is missing again`
    );
  }
}

// ── §3 the decoders read the dash's frames back ────────────────────────────
//
// A builder checked only against its own output proves nothing (charge-command.ts says so),
// so both decoders are run over the captured 0x121 commands rather than over built ones.
for (const pair of CAPTURED_DC_PAIRS) {
  const decoded = decodeChargeCurrentCommand(fixtureBytes(pair.commandHex));
  if (!decoded) {
    failures.push(`§3 ${pair.atLocal}: decodeChargeCurrentCommand rejected the dash's own "${pair.commandHex}"`);
    continue;
  }
  if (decoded.mode !== "dc" || decoded.selectedAmps !== pair.amps || decoded.ceilingAmps !== CAPTURED_DC_CEILING_A) {
    failures.push(
      `§3 ${pair.atLocal}: read back ${decoded.mode} ${decoded.selectedAmps} A ceiling ${decoded.ceilingAmps} A, ` +
        `dialled ${pair.amps} A ceiling ${CAPTURED_DC_CEILING_A} A`
    );
  }
  const emitted = decodeChargeSetpointFrame(fixtureBytes(pair.commandHex));
  const selected = emitted.find(value => value.key === "dc_charge_limit_selected_a");
  if (emitted.length !== 1 || !selected || selected.value !== pair.amps) {
    failures.push(
      `§3 ${pair.atLocal}: decodeChargeSetpointFrame emitted ${JSON.stringify(emitted)}, ` +
        `expected dc_charge_limit_selected_a = ${pair.amps}`
    );
  }
}

// ── §4 the opcode gate, against real neighbours ────────────────────────────
//
// charge-setpoint.ts calls its opcode gate load-bearing rather than defensive tidiness. These
// are the OTHER frames that shared the id in the same session — the rider's Mode stop and an
// 0x1B query carrying b2 = 170 — so the gate is exercised against what the bus really sends.
for (const frame of CAPTURED_NON_COMMAND_FRAMES) {
  const emitted = decodeChargeSetpointFrame(fixtureBytes(frame.hex));
  if (emitted.length !== 0) {
    failures.push(
      `§4 ${frame.atLocal} (${frame.what}) "${frame.hex}" decoded as ${JSON.stringify(emitted)} — ` +
        `a non-current-limit frame must emit nothing`
    );
  }
}

// ── §5 the stop command still matches its own captured frame ───────────────
//
// The stop pair was caught in the same capture. buildChargeStopCommand deliberately emits only
// the 0x120 half (isolated on-bike 2026-08-25), so this asserts that half matches and that the
// 0x121 companion the dash also sends is NOT reproduced.
const stopFrames = buildChargeStopCommand();
const capturedStopCommit = CAPTURED_NON_COMMAND_FRAMES.find(frame => frame.id === CHARGE_REQUEST_CAN_ID);
if (stopFrames.length !== 1 || stopFrames[0].id !== CHARGE_REQUEST_CAN_ID) {
  failures.push(`§5 buildChargeStopCommand emitted ${stopFrames.length} frame(s); the commit is the single 0x120`);
} else if (capturedStopCommit && toHex(stopFrames[0].data) !== capturedStopCommit.hex) {
  failures.push(`§5 stop built "${toHex(stopFrames[0].data)}", dash sent "${capturedStopCommit.hex}"`);
}

// ── §6 the transmit spacing is inside what the dash actually does ──────────
//
// CURRENT_FRAME_GAP_MS was chosen against a comment that said "~5 ms". The capture measures the
// real spread; this keeps the constant inside it rather than inside an estimate.
if (CURRENT_FRAME_GAP_MS < CAPTURED_PAIR_GAP_MS_RANGE.min || CURRENT_FRAME_GAP_MS > CAPTURED_PAIR_GAP_MS_RANGE.max) {
  failures.push(
    `§6 CURRENT_FRAME_GAP_MS = ${CURRENT_FRAME_GAP_MS} ms is outside the dash's measured ` +
      `${CAPTURED_PAIR_GAP_MS_RANGE.min}-${CAPTURED_PAIR_GAP_MS_RANGE.max} ms spacing`
  );
}

// ── §7 the ceiling the builder is given is the one the dash carries ────────
//
// Every captured DC command carries b4 = 0x4B. A build that started sending some other DC
// ceiling would be rejected by the VCU the way a wrong AC b4 once was, so the fixture's own
// ceiling is asserted against the frames it came from rather than trusted as a constant.
for (const pair of CAPTURED_DC_PAIRS) {
  const ceilingByte = fixtureBytes(pair.commandHex)[4];
  if (ceilingByte !== CAPTURED_DC_CEILING_A) {
    failures.push(`§7 ${pair.atLocal}: captured b4 is ${ceilingByte}, not the ${CAPTURED_DC_CEILING_A} A DC ceiling`);
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-command failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ buildChargeCurrentCommand reproduces all ${CAPTURED_DC_PAIRS.length} of the dash's own DC pairs byte for byte ` +
    `(0x120 commit twin first, then 0x121, ceiling ${CAPTURED_DC_CEILING_A} A), never reproduces the three ` +
    `pre-twin single frames that failed on-bike on 2026-09-07, both decoders read the captured commands back, ` +
    `the opcode gate emits nothing for the ${CAPTURED_NON_COMMAND_FRAMES.length} real non-command frames that ` +
    `shared the id, the stop command matches its captured 0x120, and CURRENT_FRAME_GAP_MS = ${CURRENT_FRAME_GAP_MS} ms ` +
    `sits inside the dash's measured ${CAPTURED_PAIR_GAP_MS_RANGE.min}-${CAPTURED_PAIR_GAP_MS_RANGE.max} ms spacing`
);
