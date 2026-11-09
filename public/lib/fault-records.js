// @ts-check
// Code identity and captured-value rules: docs/fault-report.md.
import { infokeyFault } from "./infokey-bounds.js";
import { groupedReading } from "./format.js";

/** @typedef {import("../../src/http/freeze-frames.ts").FreezeFramesResponse} FreezeFramesResponse */
/** @typedef {import("../../src/diagnostics/freeze-frame.ts").FreezeFrame} FreezeFrame */
/** @typedef {import("../../src/diagnostics/freeze-frame.ts").FreezeFrameValue} FreezeFrameValue */
/** @typedef {import("../../src/http/fault-infokeys.ts").FaultInfokeysPayload} FaultInfokeysPayload */

/** @param {string} key @param {FreezeFramesResponse|null} payload @param {boolean} [failed] */
export function resolveFaultRecord(key, payload, failed = false) {
  if (failed) return { kind: /** @type {const} */ ("unavailable"), frame: null };
  const stored = payload?.reading;
  if (!stored) return { kind: /** @type {const} */ ("not-read"), frame: null };
  const [component, symptom] = key.split("/").map(Number);
  const record = stored.records.find(candidate => candidate.component === component);
  if (!record) {
    return {
      kind: stored.components.includes(component)
        ? /** @type {const} */ ("unavailable")
        : /** @type {const} */ ("not-listed"),
      frame: null,
    };
  }
  if (record.failure !== null) return { kind: /** @type {const} */ ("unavailable"), frame: null };
  if (record.response.kind !== "frame") {
    return {
      kind:
        record.response.kind === "unrecognised" && record.response.rawHex.trim().toUpperCase() === "57 00"
          ? /** @type {const} */ ("no-record")
          : /** @type {const} */ ("unavailable"),
      frame: null,
    };
  }
  const frame = record.response.frame;
  if (!frame.shortlistKnown) return { kind: /** @type {const} */ ("unavailable"), frame: null };
  return {
    kind: frame.symptom === symptom ? /** @type {const} */ ("recorded") : /** @type {const} */ ("different-symptom"),
    frame,
  };
}

/** @param {FreezeFrame} frame @param {FaultInfokeysPayload|null} dictionary @param {string} key */
export function recordedFields(frame, dictionary, key) {
  const expected = dictionary?.shortlists[key];
  if (!expected) return frame.values.map(value => ({ name: value.name, value }));
  return [
    ...expected.map(infokey => {
      const value = frame.values.find(candidate => candidate.infokey === infokey) ?? null;
      return { name: value?.name ?? dictionary?.fields[String(infokey)]?.name ?? `Field ${infokey}`, value };
    }),
    ...frame.values.filter(value => !expected.includes(value.infokey)).map(value => ({ name: value.name, value })),
  ];
}

/** @param {FreezeFrameValue|null} value */
export function recordedFieldDisplay(value) {
  if (!value) return { text: "—", kind: "missing", note: "Recorded value unavailable" };
  const fault = infokeyFault(value);
  if (value.value === null) {
    return { text: `${recordedNumber(value.raw)} raw`, kind: "raw", note: value.scalingNote ?? "Scaling not applied" };
  }
  if (fault?.kind === "out-of-range") {
    return {
      text: `fault${value.unit ? ` ${value.unit}` : ""}`,
      kind: "fault",
      note: `Outside ${fault.bounds[0]}…${fault.bounds[1]}`,
    };
  }
  return { text: `${recordedNumber(value.value)}${value.unit ? ` ${value.unit}` : ""}`, kind: "value", note: "" };
}

/** @param {string} name */
export function recordedFieldLabel(name) {
  return FIELD_LABELS[name] ?? name;
}

/** @param {number|null} cycles */
export function recordedCycleAge(cycles) {
  if (cycles === null) return "Cycle age unavailable";
  if (cycles === 0) return "Stored this cycle";
  return `Stored ${cycles} ${cycles === 1 ? "cycle" : "cycles"} ago`;
}

/** @type {Record<string,string>} */
const FIELD_LABELS = {
  VEHICLE_SUBSTATE: "Vehicle state",
  ai_WaterPumpCurrent_In: "Pump current",
  WaterPump_ModuleSts: "Pump status",
  D_IGBTA_T: "IGBT A",
  D_IGBTB_T: "IGBT B",
  D_IGBTC_T: "IGBT C",
  V_AIR_TEMP: "Outside air",
  ai_BeamCurrent_In: "Beam current",
  VehicleLights_ModuleSts: "Lights status",
  P_V12: "12 V supply",
  AN_12V: "12 V input",
};

/** @param {number} value */
function recordedNumber(value) {
  return groupedReading(value)
    .replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")
    .replace(/^-/, "−");
}
