import { fanLimits } from "../src/http/fan.ts";
import { CHARGE_AUTO_REASON_TEXT } from "../src/http/charge-auto.ts";
import { CHARGE_AUTO_REASON, MIN_COMMAND_A } from "../src/charge/auto-curve.ts";
import { FAN_REASON, FAN_TEMPERATURE_INPUT } from "../src/fan/curve.ts";
import { FAN_MODE_CODE } from "../src/fan/auto.ts";
import { FUN_GATE } from "../src/fan/fun.ts";
import { HEARTBEAT_MS } from "../src/ws.ts";
import { CHARGE_INLET_BLOCKER } from "../src/vcu/service-gate.ts";
import { CHARGE_EVIDENCE } from "../src/vcu/charge-session.ts";
import { evaluateServiceGate, type ServiceGateReadings } from "../src/vcu/service-gate.ts";
import { decodeFrame } from "../src/can/decode.ts";
import { parseHexBytes } from "./captured-vcu-records.ts";

// The numbers and prose the Pi owns, handed to the design preview's fixtures rather than re-typed
// beside them. Same argument as the DTC tables scripts/build-service-preview.ts already injects:
// a fixture quoting a threshold this Pi does not use is a preview arguing with the bike about what
// the bike does. CHARGE_AUTO_REASON_TEXT's own header calls itself "the ONLY copy of this prose",
// after it was once mirrored by hand into public/views/charge-auto.js.
//
// Its own module because two scripts need the identical object: the builder substitutes it into
// the template, and scripts/check-preview-fixtures.ts type-checks the fixtures against it.

/**
 * The gate's own verdict for a set of real frames, so a scene never hand-writes one.
 *
 * ⚠️ Both scenes that carry a refusal had their blockers typed out by hand, and the riding
 * one was WRONG: a bike at 74 km/h emits seven, the fixture listed four, and the missing
 * `energized` sat between two it kept — a refusal no motorcycle can produce, under a comment
 * claiming it was what evaluateServiceGate builds. Derived here instead, from the same
 * capture bytes scripts/check-service-gate-charging.ts replays.
 */
function gateVerdictFor(frames: [number, string][]) {
  const readings: ServiceGateReadings = {};
  for (const [id, hex] of frames) {
    for (const { key, value } of decodeFrame(id, Buffer.from(parseHexBytes(hex)))) {
      readings[key] = { value, ageMs: 50 };
    }
  }
  return evaluateServiceGate(readings);
}

// capture-20260809-144317-edcdcf23.log at 15:10:00 — the ride out, 74 km/h with the drive
// engaged. capture-20260809-080235-cd40b535.log at 14:37:05 — episode E0, a settled AC state
// with no inlet and no lock. capture-20260803-210802 at 2026-08-04 01:30 — six hours into an
// overnight AC charge, `energized` set and everything else clear.
const RIDING_FRAMES: [number, string][] = [
  [0x102, "00 BE 80 44 94 FF D8 FF"],
  [0x104, "75 B1 02 00 22 05 B2 42"],
];
const REFUSED_FRAMES: [number, string][] = [
  [0x102, "00 02 00 44 94 FF D8 FF"],
  [0x104, "A1 9A 02 00 00 00 00 00"],
  [0x610, "00 00 00 00 F1 05 01 02"],
];

/** One decoded value out of those same frames, so tiles and verdict cannot disagree. */
function gateReading(frames: [number, string][], key: string): number {
  const reading = gateVerdictFor(frames).checks.find(check => check.key === key)?.value;
  if (reading === null || reading === undefined) {
    throw new Error(`preview-server-facts: ${key} does not decode out of the scene's own frames`);
  }
  return reading;
}

/** One evidence rule's sentence for a given reading, or a loud placeholder if the rule moved. */
function chargeEvidenceMeaning(key: string, value: number): string {
  const rule = CHARGE_EVIDENCE.find(candidate => candidate.key === key);
  if (!rule) {
    throw new Error(
      `preview-server-facts: no charge-evidence rule named ${key} — the preview would quote a caption the Pi cannot emit`
    );
  }
  return rule.meaning(value);
}

/** Everything the preview's fixtures take from the service rather than inventing. */
export function serverFacts() {
  return {
    heartbeatMs: HEARTBEAT_MS,
    fanLimits: fanLimits(),
    fanReason: FAN_REASON,
    fanTemperatureInput: FAN_TEMPERATURE_INPUT,
    fanModeCode: FAN_MODE_CODE,
    funGate: FUN_GATE,
    chargeAutoReason: CHARGE_AUTO_REASON,
    chargeAutoReasonText: CHARGE_AUTO_REASON_TEXT,
    chargeAutoFloorAmps: MIN_COMMAND_A,
    // ⚠️ The gate's own sentences. Both were hand-copied into two templates, and one of them
    // was a caption no production code could emit for a fortnight — the fixture-quotes-a-string
    // -the-Pi-cannot-say failure this module exists to stop. `chargingDcEvidence` is built by
    // the rule rather than named, so a reworded meaning() reaches both previews.
    inletBlocker: CHARGE_INLET_BLOCKER,
    chargingDcEvidence: chargeEvidenceMeaning("charge_manager_state", 0x23),
    ridingGate: gateVerdictFor(RIDING_FRAMES),
    // …and the numbers that frame decodes to, so the riding scene's speed and rpm tiles and
    // its gate verdict are one bike. Hand-set tiles beside a derived verdict is the same
    // two-opinions failure one layer down.
    ridingSpeedKmh: gateReading(RIDING_FRAMES, "speed_can_kmh"),
    ridingMotorRpm: gateReading(RIDING_FRAMES, "motor_rpm_can"),
    refusedGate: gateVerdictFor(REFUSED_FRAMES),
  };
}
