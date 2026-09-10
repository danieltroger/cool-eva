import { fanLimits } from "../src/http/fan.ts";
import { CHARGE_AUTO_REASON_TEXT } from "../src/http/charge-auto.ts";
import { CHARGE_AUTO_REASON, MIN_COMMAND_A } from "../src/charge/auto-curve.ts";
import { FAN_REASON, FAN_TEMPERATURE_INPUT } from "../src/fan/curve.ts";
import { FAN_MODE_CODE } from "../src/fan/auto.ts";
import { FUN_GATE } from "../src/fan/fun.ts";
import { HEARTBEAT_MS } from "../src/ws.ts";
import { CHARGE_INLET_BLOCKER } from "../src/vcu/service-gate.ts";
import { CHARGE_EVIDENCE } from "../src/vcu/charge-session.ts";

// The numbers and prose the Pi owns, handed to the design preview's fixtures rather than re-typed
// beside them. Same argument as the DTC tables scripts/build-service-preview.ts already injects:
// a fixture quoting a threshold this Pi does not use is a preview arguing with the bike about what
// the bike does. CHARGE_AUTO_REASON_TEXT's own header calls itself "the ONLY copy of this prose",
// after it was once mirrored by hand into public/views/charge-auto.js.
//
// Its own module because two scripts need the identical object: the builder substitutes it into
// the template, and scripts/check-preview-fixtures.ts type-checks the fixtures against it.

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
  };
}
