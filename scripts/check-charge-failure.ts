import assert from "node:assert/strict";
import { chargeFailureText } from "../public/lib/charge-failure.js";

const refused = {
  result: null,
  chargeWriteAttempt: "not-sent",
  message: "Disabled in the simulator: nothing is sent to a bike",
} as const;
assert.equal(chargeFailureText("read", refused), "Read failed: disabled in simulator");
assert.equal(chargeFailureText("write", refused), "Not sent: disabled in simulator");
assert.equal(chargeFailureText("write", null, "Could not reach the Pi"), "Delivery uncertain: connection lost");
assert.equal(
  chargeFailureText("write", { result: null, chargeWriteAttempt: "unknown", message: "Connection lost" }),
  "Delivery uncertain: connection lost"
);
console.log("✓ Charge shows failed reads and known refusals with a visible reason; lost write replies stay uncertain");
