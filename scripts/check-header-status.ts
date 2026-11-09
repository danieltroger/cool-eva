import assert from "node:assert/strict";
import { connection, signalState, systemStatus } from "../public/lib/store.js";
import { canDotState } from "../public/views/header.js";

connection.val = "live";
systemStatus.val = { settingsFault: null, can: { state: "down", message: "Synthetic unavailable bus" } };
assert.equal(canDotState(), "down", "A live dashboard connection cannot make an unavailable CAN bus green.");
systemStatus.val = { settingsFault: null, can: { state: "up", message: "Synthetic healthy bus" } };
assert.equal(canDotState(), "up");
connection.val = "connecting";
assert.equal(canDotState(), "unknown", "A retained bus status is unknown while the dashboard reconnects.");
connection.val = "live";
systemStatus.val = null;
signalState("can_link").val = { value: 0, unit: "", group: "diag", ts: 0 };
assert.equal(canDotState(), "down");
signalState("can_link").val = { value: 1, unit: "", group: "diag", ts: 0 };
assert.equal(canDotState(), "unknown", "The older signal alone cannot establish a healthy bus.");
console.log(
  "✓ CAN status stays independent of connection status, with the previous unknown and signal fallback states"
);
