import assert from "node:assert/strict";
import { apply, connection, faultState, signalState } from "../public/lib/store.js";
import type { LiveValue } from "../src/can/signals.ts";
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({ status: { enabled: false, chargeAck: null }, result: null, message: null })
  )) as typeof fetch;
const { chargePowerDisplay, chargeValue, currentChargeMode } = await import("../public/lib/charge-display.js");
let timestamp = 1_000_000;
for (const [value, mode, label, magnitude, color] of [
  [11.456, "dc", "CHARGING", "11", "good"],
  [-11.456, "dc", "POWER OUT", "11", "flow"],
  [-0.2, "dc", "POWER OUT", "0.2", "flow"],
  [0.2, "dc", "CHARGING", "0.2", "good"],
  [0, "dc", "POWER", "0.0", "fg"],
  [-0.01, "dc", "POWER", "0.0", "fg"],
  [0.2, "none", "POWER IN", "0.2", "good"],
  [-48.3, "none", "POWER OUT", "48", "flow"],
] as const) {
  send(value, mode);
  const shown = chargePowerDisplay();
  assert.equal(shown.label, label, "Fresh signed power decides the direction word.");
  assert.equal(shown.magnitude, magnitude);
  assert.equal(shown.color, `var(--${color})`);
  assert.equal(shown.unit, "kW");
  assert.equal(shown.magnitude.startsWith("-"), false);
}
send(11.456, "dc", true);
assert.equal(chargePowerDisplay().magnitude, "stale", "Stale power cannot remain a live charging number.");
assert.equal(chargePowerDisplay().unit, "");
assert.equal(chargePowerDisplay().label, "POWER");
send(65535, "dc");
assert.equal(chargePowerDisplay().magnitude, "fault");
assert.equal(chargePowerDisplay().unit, "");
assert.equal(chargePowerDisplay().label, "POWER");
send(11.456, "dc");
signalState("pack_kw").val = null;
assert.equal(chargePowerDisplay().magnitude, "fault", "A missing reading cannot conceal the newest rejection.");
faultState("pack_kw").val = null;
assert.equal(chargePowerDisplay().magnitude, "—");
assert.equal(chargePowerDisplay().label, "POWER");
send(11.456, "dc");
assert.equal(chargeValue("charge_cmd_a"), 32);
assert.equal(
  chargeValue("charge_soc_limit_pct", true),
  90,
  "Held onDemand values keep their real last-change timestamps."
);
connection.val = "offline";
assert.equal(chargePowerDisplay().label, "POWER");
assert.equal(chargeValue("charge_cmd_a"), null);
assert.equal(currentChargeMode(), "none");
console.log(
  "✓ Fresh accepted signed Charge power, direction colours, small readings, neutral zero, fault/stale/missing/link loss and held onDemand readings"
);
function send(value: number, mode: "dc" | "none", stale = false) {
  timestamp += 70_000;
  connection.val = "live";
  const signals: Record<string, LiveValue> = {
    pack_kw: reading(value, "kW", "battery", stale ? timestamp - 30_000 : timestamp),
    fast_dc_contactor: reading(mode === "dc" ? 1 : 0, "", "charge"),
    charge_manager_state: reading(mode === "dc" ? 35 : 0, "", "charge"),
    bms_state_charge: reading(0, "", "battery"),
    charge_cmd_a: reading(32, "A", "charge", timestamp - 60_000),
    charge_soc_limit_pct: reading(90, "%", "charge", timestamp - 60_000),
  };
  apply({ type: "snapshot", ts: timestamp, signals });
}

function reading(value: number, unit: string, group: string, ts = timestamp): LiveValue {
  return { value, unit, group, ts };
}
