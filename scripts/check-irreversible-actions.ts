// Historical source-check findings: docs/service-legacy.md.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SERVICE_ACTIONS, confirmationFor } from "../public/lib/service-actions.js";
import { parseWriteRequest, utcMinute } from "../src/http/vcu-write.ts";

const NOW = Date.UTC(2026, 7, 19, 14, 3, 30);
const expected = [
  ["reset-vcu", "Restart bike"],
  ["sync-clock", "Set bike clock"],
  ["set-service-point", "Record service"],
  ["clear-dtcs", "Clear stored faults"],
];
assert.deepEqual(
  SERVICE_ACTIONS.map(entry => [entry.action, entry.title]),
  expected
);
assert.equal(new Set(SERVICE_ACTIONS.map(entry => entry.action)).size, 4);
const source = await readFile(new URL("../src/http/vcu-write.ts", import.meta.url), "utf8");
const start = source.indexOf("switch (action) {");
const end = source.indexOf("\n}", start);
assert.ok(start >= 0 && end > start);
const dispatched = [...source.slice(start, end).matchAll(/^\s*case "([^"]+)":/gm)].map(match => match[1]);
assert.ok(dispatched.length >= 4);
assert.equal(new Set(dispatched).size, dispatched.length);
const refusal = parseWriteRequest(new URLSearchParams({ action: "no-such-action" }), NOW);
assert.ok(!refusal.ok);
assert.deepEqual((refusal.reason.match(/one of (.+?) — not/)?.[1] ?? "").split(", ").sort(), [...dispatched].sort());

const UNCONFIRMED: Record<string, URLSearchParams> = {
  parameter: new URLSearchParams({ action: "parameter", name: "MAX_DC_CHG_CURRENT", value: "80", expected: "75" }),
  bit: new URLSearchParams({
    action: "bit",
    name: "VSM_CONFIG_1",
    bit: "heated-handlebars",
    on: "1",
    expected: "4371",
  }),

  parameters: new URLSearchParams({ action: "parameters", w: "MAX_DC_CHG_CURRENT:80:75" }),
  "read-service-stamp": new URLSearchParams({ action: "read-service-stamp" }),
  "set-service-point": new URLSearchParams({ action: "set-service-point" }),
  "sync-clock": new URLSearchParams({ action: "sync-clock" }),
  "clear-dtcs": new URLSearchParams({ action: "clear-dtcs" }),

  "charge-current": new URLSearchParams({ action: "charge-current", amps: "6" }),

  "charge-stop": new URLSearchParams({ action: "charge-stop" }),

  "charge-soc-limit": new URLSearchParams({ action: "charge-soc-limit", pct: "90" }),

  "charge-soc-limit-read": new URLSearchParams({ action: "charge-soc-limit-read" }),

  "reset-vcu": new URLSearchParams({ action: "reset-vcu" }),
};

assert.deepEqual(Object.keys(UNCONFIRMED).sort(), [...dispatched].sort());
const gated = dispatched.filter(action => !parseWriteRequest(UNCONFIRMED[action], NOW).ok);
const serviceActions: string[] = SERVICE_ACTIONS.map(entry => entry.action);
const chargeActions = new Set(["charge-current", "charge-stop", "charge-soc-limit"]);
assert.deepEqual([...gated].sort(), [...serviceActions, ...chargeActions].sort());
assert.ok(!gated.includes("read-service-stamp"));
for (const action of serviceActions) {
  const query = new URLSearchParams(UNCONFIRMED[action]);
  query.set("confirm", confirmationFor(action, new Date(NOW).toISOString()));
  assert.ok(parseWriteRequest(query, NOW).ok, `${action} accepts the real UI confirmation`);
}
for (const [action, confirmation] of [
  ["charge-current", "charge-current-6"],
  ["charge-stop", "charge-stop"],
  ["charge-soc-limit", "charge-soc-limit-90"],
]) {
  const query = new URLSearchParams(UNCONFIRMED[action]);
  query.set("confirm", confirmation);
  assert.ok(parseWriteRequest(query, NOW).ok, `${action} confirmation`);
}
assert.equal(confirmationFor("sync-clock", new Date(NOW).toISOString()), utcMinute(NOW));
console.log("✓ approved Service actions match server confirmation gates and use accepted tokens");
