// Captured numeric values; only explicit test variants alter availability or identity.
if (ridingFixture.has("fault-records")) {
  for (const component of [40, 52]) {
    if (!SCENE.storedComponents.some(entry => entry[0] === component)) {
      SCENE.storedComponents.push([component, 0]);
    }
  }
  LIVE.dtc_count[0] = SCENE.storedComponents.length;
  const variant = ridingFixture.get("fault-records");
  const payload = __TABLES["/freeze-frames"];
  if (variant === "not-read") {
    payload.reading = null;
  } else if (variant === "different-symptom") {
    const record = payload.reading.records.find(entry => entry.component === 40);
    record.response.frame.symptom = 1;
    record.response.frame.obdCode = "B1013";
  } else if (["partial", "empty-partial"].includes(variant)) {
    const frame = payload.reading.records.find(entry => entry.component === 44).response.frame;
    frame.values = frame.values.slice(0, variant === "empty-partial" ? 0 : 2);
    frame.truncated = true;
    frame.cyclesSinceStored = null;
  }
}
