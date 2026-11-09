import assert from "node:assert/strict";
import { SETTINGS_MAP } from "../public/lib/settings-map.js";
import { formatServiceStampDate } from "../public/lib/service-stamp.js";
import { interpretServiceStamp } from "../src/vcu/service-actions.ts";

const seconds = (Date.UTC(2026, 0, 1) - Date.UTC(2000, 0, 1)) / 1000;
const valid = interpretServiceStamp(
  { dateLow: seconds & 0xffff, dateHigh: seconds >>> 16, odometerLow: 12000, odometerHigh: 0 },
  Date.UTC(2026, 0, 2)
);
const empty = interpretServiceStamp({ dateLow: 0, dateHigh: 0, odometerLow: 0, odometerHigh: 0 }, Date.UTC(2026, 0, 2));
assert.equal(formatServiceStampDate(null), "—");
assert.equal(formatServiceStampDate(empty), "fault", "An empty recorded stamp cannot look like a real service date.");
assert.equal(formatServiceStampDate(valid), "1 Jan 2026");
assert.equal(formatServiceStampDate({ ...valid, dateIso: null }), "fault");
assert.equal(formatServiceStampDate({ ...valid, dateIso: "invalid" }), "fault");
assert.equal(SETTINGS_MAP.find(section => section.key === "connections")?.detail, "Wi-Fi · Bluetooth");
assert.deepEqual(
  SETTINGS_MAP.map(section => section.key),
  ["phone", "bike", "charging", "connections", "recording", "software", "advanced"]
);
console.log(
  "✓ Settings cleanup: available connection choices and one-line service dates with honest missing/invalid states"
);
