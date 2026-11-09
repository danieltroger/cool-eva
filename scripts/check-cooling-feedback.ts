import assert from "node:assert/strict";
import { foldFanAnnouncement } from "../public/lib/announce.js";
import { FAN_MODE_CODE } from "../public/lib/fan-display.js";

const baseline = foldFanAnnouncement({ value: null, baselined: false }, FAN_MODE_CODE.AUTOMATIC, 68);
const inline = foldFanAnnouncement(baseline.state, FAN_MODE_CODE.MANUAL, 75, null, true);
assert.equal(inline.banner, null, "Cooling already shows the fan change inline.");
assert.equal(
  foldFanAnnouncement(inline.state, FAN_MODE_CODE.MANUAL, 75).banner,
  null,
  "Leaving Cooling cannot replay a suppressed change."
);
assert.equal(
  foldFanAnnouncement(inline.state, FAN_MODE_CODE.AUTOMATIC, 68).banner,
  "Fan: automatic",
  "Other screens still announce the next fan change."
);
console.log("✓ Cooling keeps fan feedback inline and remembers it without suppressing later news elsewhere");
