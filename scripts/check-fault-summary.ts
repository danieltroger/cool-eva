import assert from "node:assert/strict";
import { headlineState, headlineValue } from "../public/lib/fault-data.js";
import { faultHistory } from "../public/lib/fault-history.js";
import { apply, connection } from "../public/lib/store.js";

connection.val = "live";
apply({
  type: "snapshot",
  ts: 100_000,
  signals: {
    dtc_list_count: { value: 3, ts: 100_000, unit: "", group: "diag" },
    dtc_unrecognised_count: { value: 3, ts: 100_000, unit: "", group: "diag" },
  },
});
assert.deepEqual(
  headlineState(),
  { kind: "active", count: 3 },
  "The whole bike count survives absent individual keys."
);
assert.equal(headlineValue(), "3");
connection.val = "offline";
assert.equal(headlineState().kind, "unknown", "An offline cached active list cannot be asserted as current.");
connection.val = "live";
apply({ type: "patch", ts: 300_001, signals: {} });
assert.equal(headlineState().kind, "unknown", "A silent diagnostic list cannot become clear.");
apply({
  type: "patch",
  ts: 300_002,
  signals: {
    dtc_list_count: { value: 0, ts: 300_002, unit: "", group: "diag" },
  },
});
assert.deepEqual(headlineState(), { kind: "clear", count: 0 });
assert.deepEqual(faultHistory({ times: [0, 10, 20, 30, 40, 50], values: [0, 1, 1, 0, 1, 0] }, 80), {
  firings: 2,
  lastSeenMs: 40,
});
console.log("✓ Complete fault counts, offline/silent unknown, confirmed clear and preserved rising-edge history");
