import assert from "node:assert/strict";
import { chargeConfirmationText } from "../public/lib/charge-command-display.js";
import { chargeEdit } from "../public/lib/charge-edit.js";
import { canonicalHash, ROUTES, tabFromHash } from "../public/lib/router.js";

assert.deepEqual(
  ROUTES.filter(route => route.tab === "charge").map(route => route.name),
  ["charge"]
);
for (const hash of ["#charge/controls", "#charge/pack-cooling", "#CHARGE/CONTROLS"]) {
  assert.deepEqual(canonicalHash(hash), { tab: "charge", view: "charge", rewriteTo: "#charge", named: true });
  assert.equal(tabFromHash(hash), "charge");
}
assert.deepEqual(chargeEdit(null, 90, 0, 100), { text: "90", value: 90, changed: false });
assert.deepEqual(chargeEdit(null, null, 0, 100), { text: "", value: null, changed: false });
assert.deepEqual(chargeEdit("85", 90, 0, 100), { text: "85", value: 85, changed: true });
assert.deepEqual(
  chargeEdit("85", 80, 0, 100),
  { text: "85", value: 85, changed: true },
  "A live report must not replace the rider's draft."
);
assert.equal(chargeEdit("85", 85, 0, 100).changed, false, "A matching confirmed setting disables a redundant Set.");
assert.equal(chargeEdit("090", 90, 0, 100).changed, false);
assert.equal(chargeEdit("0", 90, 0, 100).value, 0, "Removing the saved limit is a deliberate valid setting.");
assert.equal(chargeEdit("100", 90, 0, 100).value, 100);
for (const draft of ["", "-1", "101", "85.5", "1e2", "0x50", "85 A", "NaN", "Infinity"]) {
  assert.equal(chargeEdit(draft, 90, 0, 100).value, null, draft);
  assert.equal(chargeEdit(draft, 90, 0, 100).changed, false, draft);
}
assert.equal(chargeEdit("1", 32, 1, 75).value, 1);
assert.equal(chargeEdit("75", 32, 1, 75).value, 75);
assert.equal(chargeEdit("0", 32, 1, 75).value, null);
assert.equal(chargeEdit("76", 32, 1, 75).value, null);
assert.equal(chargeEdit("5", 13, 6, 16).value, null);
assert.equal(chargeEdit("6", 13, 6, 16).value, 6);
assert.equal(chargeEdit("16", 13, 6, 16).value, 16);
assert.equal(chargeEdit("17", 13, 6, 16).value, null);
assert.equal(chargeEdit("40", 32, 1, null).value, null, "An unknown ceiling cannot enable a command.");
assert.equal(chargeEdit("40", 32, 1, 35).value, null, "A ceiling that falls revalidates the same draft.");

const took32 = {
  verdict: { kind: "took", fromAmps: 50, toAmps: 32, latencyMs: 10 },
  message: "Synthetic acknowledgement",
} as const;
assert.equal(chargeConfirmationText(32, 32, took32), "Bike confirmed 32 A");
assert.equal(
  chargeConfirmationText(40, 32, took32),
  "Waiting for bike…",
  "An earlier request cannot confirm a new draft."
);
assert.equal(
  chargeConfirmationText(40, 40, took32),
  "Waiting for bike…",
  "A stale successful verdict cannot confirm another target."
);
assert.equal(
  chargeConfirmationText(32, null, took32),
  "Waiting for bike…",
  "Stale or faulted request evidence is unavailable."
);
assert.equal(chargeConfirmationText(32, 32, null), "Waiting for bike…");
assert.equal(
  chargeConfirmationText(40, 40, {
    verdict: { kind: "not-acknowledged", heldAmps: 32 },
    message: "Synthetic held request",
  }),
  "40 A · Not confirmed"
);
assert.equal(
  chargeConfirmationText(40, 40, {
    verdict: { kind: "station-limited", askedAmps: 40, gotAmps: 32 },
    message: "Synthetic station limit",
  }),
  "Station limited"
);
assert.equal(
  chargeConfirmationText(40, 40, { verdict: { kind: "no-evidence" }, message: "Synthetic missing evidence" }),
  "Delivery uncertain"
);
assert.deepEqual(
  chargeEdit(null, 13.7, 6, 16),
  { text: "13.7", value: null, changed: false },
  "A fractional reported setting stays truthful while requests remain whole-numbered."
);

console.log(
  "✓ one Charge route, legacy links, live defaults, stable drafts, no-op suppression and bounded whole-number requests"
);
