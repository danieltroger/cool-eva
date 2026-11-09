// @ts-check
// Captured records keep their component/symptom identity: docs/fault-report.md.
import van from "../vendor/van-1.6.1.js";
import { request } from "../lib/transport.js";
import { infokeys } from "../lib/fault-data.js";
import {
  resolveFaultRecord,
  recordedFields,
  recordedFieldDisplay,
  recordedFieldLabel,
  recordedCycleAge,
} from "../lib/fault-records.js";

export async function loadRecordedValues() {
  if (loading.rawVal) return;
  loading.val = true;
  failed.val = false;
  try {
    const response = await request("/freeze-frames", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    reading.val = /** @type {FreezeFramesResponse} */ (await response.json());
  } catch (error) {
    failed.val = true;
    console.warn("faults: could not load recorded values:", error);
  } finally {
    loading.val = false;
  }
}

/** @typedef {import("../../src/http/freeze-frames.ts").FreezeFramesResponse} FreezeFramesResponse */
const { div, span } = van.tags;
const reading = van.state(/** @type {FreezeFramesResponse|null} */ (null));
const loading = van.state(false);
const failed = van.state(false);

/** @param {string} key */
export function RecordedValues(key) {
  return () => {
    if (loading.val) return Note("Reading recorded values…");
    const record = resolveFaultRecord(key, reading.val, failed.val);
    const frame = record.frame;
    if (record.kind !== "recorded" || !frame) {
      return div(
        { class: "layout-compact-stack", "data-record-state": record.kind },
        Note(recordMessage(record)),
        record.kind === "different-symptom" ? FieldList(key) : null
      );
    }
    return div(
      { class: "layout-compact-stack recorded-values", "data-record-state": "recorded" },
      span({ class: "label" }, "Recorded when this code set"),
      ...recordedFields(frame, infokeys.val, key).map(Field),
      !frame.truncated && frame.shortlistKnown && !frame.values.length
        ? Note("No fields recorded for this code.")
        : null,
      frame.truncated ? Note("Some recorded values are unavailable.") : null,
      span(
        {
          class: "fault-tiny",
          "data-cycle-age": "",
          title: "The counter records cycles; whether a key cycle or VCU reset advances it remains unresolved.",
        },
        recordedCycleAge(frame.cyclesSinceStored)
      )
    );
  };
}

/** @param {ReturnType<typeof resolveFaultRecord>} record */
function recordMessage(record) {
  switch (record.kind) {
    case "unavailable":
      return "Could not read this record.";
    case "not-listed":
      return "No record was listed for this fault.";
    case "no-record":
      return "The bike returned no record for this fault.";
    case "different-symptom":
      return `This component’s record belongs to ${record.frame?.obdCode ?? "another fault"}.`;
    default:
      return "Recorded values have not been read yet.";
  }
}

/** @param {{name:string,value:import("../../src/diagnostics/freeze-frame.ts").FreezeFrameValue|null}} field */
function Field(field) {
  const display = recordedFieldDisplay(field.value);
  return div(
    { class: "layout-list-row fault-record-row", "data-record-field": field.name, "data-field-state": display.kind },
    span({ title: field.name }, recordedFieldLabel(field.name)),
    span({ class: `fault-field-value record-${display.kind}`, title: display.note }, display.text)
  );
}

/** @param {string} key */
function FieldList(key) {
  const dictionary = infokeys.val;
  const shortlist = dictionary?.shortlists[key];
  if (!shortlist) return null;
  return div(
    { class: "layout-compact-stack fault-field-list" },
    span({ class: "label" }, "Fields recorded for this code"),
    span(
      { class: "fault-sub" },
      shortlist
        .map(infokey => recordedFieldLabel(dictionary.fields[String(infokey)]?.name ?? `Field ${infokey}`))
        .join(" · ")
    )
  );
}

/** @param {string} text */
function Note(text) {
  return span({ class: "fault-sub" }, text);
}
