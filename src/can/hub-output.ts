import { type DecodedValue } from "./frame.ts";
import { decodeHubOutput, isHubOutputFrame } from "../hub/output.ts";

// CAN 0x410 sub-type 3 — the drive triple, off the bus instead of off Bluetooth.
//
// These three were Bluetooth-only until 2026-09-15 and the registry said so. They
// are not: type 3 streams at ~20 Hz while the bike is moving, and it carries one
// field neither transport decoded before — a road speed that is NOT `speed_can_kmh`.
// Keys carry `_can` so the two transports stay comparable rather than merged, the
// way `odometer_can_km` does. Evidence and the speed's provenance: docs/can-0x410.md.

/** Decodes one 0x410 frame's type-3 payload; every other sub-type decodes to nothing. */
export function decodeHubOutputFrame(data: Buffer): DecodedValue[] {
  if (!isHubOutputFrame(data)) {
    return [];
  }
  const output = decodeHubOutput(data);
  return [
    { key: "dash_speed_kmh", value: output.speedKmh },
    { key: "motor_torque_can_nm", value: output.torqueNm },
    { key: "motor_power_can_kw", value: output.powerKw },
  ];
}
