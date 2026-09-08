import { fanLimits } from "../src/http/fan.ts";
import { CHARGE_AUTO_REASON_TEXT } from "../src/http/charge-auto.ts";
import { CHARGE_AUTO_REASON, MIN_COMMAND_A } from "../src/charge/auto-curve.ts";
import { FAN_REASON, FAN_TEMPERATURE_INPUT } from "../src/fan/curve.ts";
import { FAN_MODE_CODE } from "../src/fan/auto.ts";
import { FUN_GATE } from "../src/fan/fun.ts";
import { HEARTBEAT_MS } from "../src/ws.ts";

// The numbers and prose the Pi owns, handed to the design preview's fixtures rather than re-typed
// beside them. Same argument as the DTC tables scripts/build-service-preview.ts already injects:
// a fixture quoting a threshold this Pi does not use is a preview arguing with the bike about what
// the bike does. CHARGE_AUTO_REASON_TEXT's own header calls itself "the ONLY copy of this prose",
// after it was once mirrored by hand into public/views/charge-auto.js.
//
// Its own module because two scripts need the identical object: the builder substitutes it into
// the template, and scripts/check-preview-fixtures.ts type-checks the fixtures against it.

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
  };
}
