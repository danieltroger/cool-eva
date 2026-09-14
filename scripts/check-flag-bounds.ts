import { decodeFrame } from "../src/can/decode.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor, isPlausible } from "../public/lib/bounds.js";

// The signals whose bound is a claim about their DECODER rather than about the bike, and the
// three different arguments that justify one.
//
//     node --experimental-strip-types scripts/check-flag-bounds.ts
//
// scripts/generate-signal-bounds.ts ratchets that every signal reaches SOME rule or says why
// not. What it cannot say is WHICH rule or what the numbers are, and here the numbers are the
// whole argument: fifteen are 1/0 flags where [0, 1] must
// reject a masked byte, and three are state words where the whole byte is legitimate and a
// bound drawn round today's values would draw tomorrow's state as a dead sensor.
//
// The state-word section asserts both that 255 is ACCEPTED — the whole field is legitimate,
// and a state this bike has not reached must not render as a fault — and that 256 is rejected.
// ⚠️ The second is NOT decoration, though an earlier draft of this file said it was on the
// grounds that a byte cannot produce 256. That confuses "the decoder cannot produce this input"
// with "this assertion cannot fail": widen the bound to a u16 and the rejection stops holding,
// which is a mutation the exact-bounds assertion also catches but this one catches behaviourally.

/** `bit()` or `mask ? 1 : 0` in src/can/decode-bms.ts, every one of them. */
const FLAG_KEYS = [
  "bms_state_discharge",
  "bms_state_charge",
  "bms_state_balancing",
  "bms_state_trickle",
  "bms_state_idle",
  "bms_state_charge_complete",
  "bms_state_maintenance",
  "bms_err_cell_overvoltage",
  "bms_err_cell_undervoltage",
  "bms_err_over_temp",
  "bms_err_leak_detected",
  "bms_err_leak_detect_failed",
  "bms_err_contactor",
  "bms_warn_low_soc",
  "bms_warn_balancing_required",
];

/**
 * One byte each, so the whole 0…255 is legitimate.
 *
 * ⚠️ Four joined in #227 on the same sentence this comment already made. `lmu_cell_mux` is
 * a single byte too and is deliberately NOT here — it is the one selector the decoder logs
 * valid or not, and docs/signal-bounds.md says why bounding it would be actively harmful.
 */
const STATE_WORD_KEYS = [
  "vehicle_state",
  "vehicle_substate",
  "charge_state",
  "bms_io_state",
  "clamp_gate",
  "clamp_amount",
  "charger_enabled",
];

// ⚠️ CONSTRUCTED, and check-charge-mode.ts says so where these come from: byte 0 is an
// OBSERVED value in each — a discharging bike, an AC session, the BMS's Idle — while bytes 1-7
// are the error and warning words, all-zero in every capture of this healthy pack. So the byte
// under test is measured and the rest is the quiet background it has always sat in.
const OBSERVED_B0_FRAMES = ["01 00 00 00 00 00 00 00", "02 00 00 00 00 00 00 00", "10 00 00 00 00 00 00 00"];

// ⚠️ SYNTHETIC, and the only frame here that is. The three frames above set one `bms_state_*`
// bit each, so twelve of the fifteen are never seen at 1 without this one: the six `bms_err_*`
// and two `bms_warn_*`, whose words are all-zero in every capture of this healthy pack, plus
// the four `bms_state_*` those three b0 values do not reach. It proves the decoder
// self-consistent and nothing about the bike — the same treatment, and the same reason, as
// check-button-decode.ts's two synthetic frames.
const ALL_BITS_201 = "FF FF FF FF FF FF FF FF";

const failures: string[] = [];
const signalsByKey = new Map(SIGNALS.map(signal => [signal.key, signal]));

function check(what: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${what}`);
    return;
  }
  failures.push(what);
}

function boundsOf(key: string): [number, number] | null {
  const signal = signalsByKey.get(key);
  if (!signal) {
    return null;
  }
  return boundsFor(key, signal.unit, signal.group);
}

function accepts(key: string, value: number): boolean {
  const signal = signalsByKey.get(key);
  return signal !== undefined && isPlausible(key, value, signal.unit, signal.group);
}

function parseFrame(hex: string): Buffer {
  return Buffer.from(hex.split(/\s+/).map(byte => Number.parseInt(byte, 16)));
}

console.log("1. the fifteen BMS flags are gated to 0…1");
for (const key of FLAG_KEYS) {
  check(`${key} is a registered signal`, signalsByKey.has(key));
  check(`${key} is gated to exactly [0, 1]`, JSON.stringify(boundsOf(key)) === "[0,1]");
  check(`…and accepts both real readings`, accepts(key, 0) && accepts(key, 1));
  // The failure this gate exists for: a decoder returning `flags & 0x20` rather than the
  // bit. bounds.js's `buttons` note makes the same argument — 32 is not 1, and a tile that
  // lights on 32 but not on 1 is a quiet wrong answer.
  check(`…and rejects 32, the masked byte a future decoder could return`, !accepts(key, 32));
}

console.log("\n2. replayed 0x201 frames, so the gate is tested against what the bus produces");
for (const hex of [...OBSERVED_B0_FRAMES, ALL_BITS_201]) {
  const decoded = decodeFrame(0x201, parseFrame(hex));
  const flags = decoded.filter(value => FLAG_KEYS.includes(value.key));
  const provenance = hex === ALL_BITS_201 ? " (⚠️ SYNTHETIC)" : "";
  check(`${hex}${provenance} decodes to all fifteen flags`, flags.length === FLAG_KEYS.length);
  check(
    `…and the gate accepts every one of them — a bound that rejected a real frame would be drawn as a dead sensor`,
    flags.every(value => accepts(value.key, value.value))
  );
}

console.log("\n3. the three state words are gated to the FIELD, not to the values seen");
for (const key of STATE_WORD_KEYS) {
  check(`${key} is a registered signal`, signalsByKey.has(key));
  check(`${key} is gated to exactly [0, 255]`, JSON.stringify(boundsOf(key)) === "[0,255]");
  check(`…and accepts the whole byte, 0 and 255 included`, accepts(key, 0) && accepts(key, 255));
  check(`…and rejects 256, so a bound widened past a byte stops holding`, !accepts(key, 256));
}

console.log("\n4. the two remaining-energy twins agree about what counts as a fault");
// ⚠️ A ratchet, not a comment. `bms_remaining_energy_wh` (a u24 off 0x661) and
// `residual_energy_wh` (the VCU's 2 Wh figure off 0x10A) are the SAME quantity by two
// routes, and public/lib/derive.js prefers the first — `??` falls through only on null, so
// the second is never consulted while the first returns a number. Bounding one and not the
// other is how that went unnoticed; asserting they are EQUAL is what stops it recurring.
// docs/signal-bounds.md §"The bounds added by #227".
const TWINS = ["bms_remaining_energy_wh", "residual_energy_wh"];
const twinBands = TWINS.map(key => JSON.stringify(boundsOf(key)));
check(
  `${TWINS.join(" and ")} are both gated`,
  twinBands.every(band => band !== "null")
);
check(
  `…to the same band — they measure one pack and must agree what a fault is (${twinBands[0]})`,
  twinBands[0] === twinBands[1]
);

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) about the declared bounds do not hold:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `\n✓ all ${FLAG_KEYS.length + STATE_WORD_KEYS.length} signals are gated to the band their decoder justifies: the ` +
    `${FLAG_KEYS.length} BMS flags to 0…1, accepting both real readings and rejecting the masked byte a future ` +
    `decoder could return, over four replayed 0x201 frames; the ${STATE_WORD_KEYS.length} single-byte words to the ` +
    `whole byte, so a state this bike has not reached renders as a state rather than as a dead sensor; and the two ` +
    `remaining-energy twins to the same band, which is what stops one of them being gated and the other not`
);
