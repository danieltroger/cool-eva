// @ts-check

import { ageInWords } from "./format.js";

/** @typedef {import("../../src/http/vcu-params.ts").VcuParamsResponse} VcuParamsResponse */
/** @typedef {import("../../src/http/vcu-params.ts").VcuParameterRow} VcuParameterRow */
/** @typedef {import("../../src/http/vcu-params.ts").VcuParameterSnapshot} VcuParameterSnapshot */
/** @typedef {import("../../src/http/vcu-params.ts").TableTypeReport} TableTypeReport */

// The VCU parameter table, searchable by name. Plain DOM, no VanJS: this is a
// static list you read once in a garage, not a live gauge, so there is nothing to
// bind to and a page that renders once is the whole job.
//
// It is a page of its own rather than a sixth tab. Every tab in the dashboard is
// something you look at while riding or charging; 277 calibration constants are a
// question you ask standing next to the bike with a laptop, and putting them in the
// tab bar would cost a thumb-sized target on a screen read through a visor at
// speed. /params.html is one tap from the same wifi and costs the riding views
// nothing.
//
// The types above come from the server's own source. There is no build step, so
// they are JSDoc-only — the browser never sees them, but `npm run typecheck` does,
// which is what stops this page and src/http/vcu-params.ts drifting apart.

/** @type {VcuParameterRow[]} */
let allRows = [];

const statusLine = required("status");
const search = /** @type {HTMLInputElement} */ (required("search"));
const tableBody = required("rows");
const summary = required("summary");
const tableTypeLine = required("tabletype");

search.addEventListener("input", render);
void load();

async function load() {
  try {
    const response = await fetch("/vcu-params", { cache: "no-store" });
    if (!response.ok) {
      statusLine.textContent = `/vcu-params returned HTTP ${response.status}`;
      return;
    }
    show(/** @type {VcuParamsResponse} */ (await response.json()));
  } catch (err) {
    // Loud rather than an empty table: an empty table looks like a bike with no
    // parameters, which is never the truth.
    statusLine.textContent = `could not reach /vcu-params — ${err instanceof Error ? err.message : String(err)}`;
    console.error("params: fetch failed", err);
  }
}

/** @param {VcuParamsResponse} payload */
function show(payload) {
  if (payload.state === "never-read") {
    statusLine.textContent = `No parameters have been read on this Pi yet (looked in ${payload.directory}).`;
    summary.textContent = payload.hint;
    return;
  }
  if (payload.state === "unreadable") {
    statusLine.textContent = `The snapshot in ${payload.directory} could not be read: ${payload.reason}`;
    return;
  }
  allRows = payload.snapshot.rows;
  statusLine.textContent = describeSnapshot(payload.snapshot);
  showTableType(payload.tableType);
  search.disabled = false;
  render();
}

/**
 * Which of Energica's parameter tables the names in the table below came from.
 *
 * ⚠️ This line is the only way to tell. A wrong table is invisible in every other way —
 * routing and record widths are identical across all 28 of them, so a bike on the wrong
 * one reads and writes perfectly and merely means something else by every name. Not
 * hypothetical: the table embedded here was one revision out for two months, silently
 * wrong about one name in 277, and on somebody else's bike the same silence would be
 * worth 25. See docs/dashboard-decisions.md §"Which parameter table the names came from".
 *
 * The verdict is computed on the Pi (src/vcu/snapshot.ts, `reportTableType`) so there
 * is exactly one copy of "which table are we".
 *
 * @param {TableTypeReport} report
 */
function showTableType(report) {
  tableTypeLine.textContent = report.lines.join("\n");
  // Three states, three appearances. "A micro never answered" must not render
  // identically to "both agree" with only an emoji between them — that is the state
  // this bike is in today, and rendering it as normal is the whole failure this line
  // was added to stop.
  // `split` counts as alarming: two micros naming different tables means some of the
  // names on this page are one table's and some are the other's, which is worse than
  // either being wrong on its own.
  const alarming = report.mismatched || report.split || report.unusable.length > 0;
  tableTypeLine.className = alarming ? "mismatch" : report.confirmed ? "" : "unconfirmed";
  if (alarming) {
    // Also into the console, because this is the one finding on this page worth
    // pasting into a bug report verbatim.
    console.error("params: VCU parameter table not confirmed —", report.lines.join(" "));
  }
}

/**
 * How old the reading is, and whether it is all of it.
 *
 * The age comes from ./format.js's `ageInWords`, which is where the phone-clock
 * reasoning lives now — three pages were computing it inline off the same
 * `readAt`, with thresholds that had already drifted apart: this one said
 * "73 h ago" where the same snapshot on the service sheet said "3 days ago".
 *
 * @param {VcuParameterSnapshot} snapshot
 */
function describeSnapshot(snapshot) {
  const read = snapshot.rows.filter(row => row.status === "read").length;
  const partial = snapshot.complete ? "" : " — SWEEP INCOMPLETE, re-run to finish it";
  return (
    `${read} of ${snapshot.rows.length} parameters read ${ageInWords(snapshot.readAt)} ` +
    `from ${snapshot.micros.join(" + ")}${partial}`
  );
}

function render() {
  const query = search.value.trim().toLowerCase();
  const matches = allRows.filter(row => matchesQuery(row, query));
  summary.textContent = `${matches.length} of ${allRows.length} shown`;
  tableBody.replaceChildren(...matches.map(rowElement));
}

/**
 * @param {VcuParameterRow} row
 * @param {string} query
 */
function matchesQuery(row, query) {
  if (query.length === 0) {
    return true;
  }
  return `${row.index} ${row.name ?? ""} ${row.section ?? ""} ${row.micro}`.toLowerCase().includes(query);
}

/** @param {VcuParameterRow} row */
function rowElement(row) {
  const element = document.createElement("tr");
  // A parameter that did not answer is marked as such and shows its reason instead
  // of a number, because a blank cell in a table of numbers reads as a zero.
  if (row.status !== "read") {
    element.className = "unread";
  }
  append(element, String(row.index));
  append(element, row.name ?? "(not in params.ecf)", row.name ? "name" : "name unnamed");
  append(element, row.section ?? "—", "section");
  append(element, row.micro, "micro");
  append(element, thisBikeValue(row), "value");
  append(element, row.rawHex ?? "—", "raw");
  append(element, otherBikeValue(row), differs(row) ? "other differs" : "other");
  return element;
}

/** @param {VcuParameterRow} row */
function thisBikeValue(row) {
  if (row.status !== "read") {
    return row.note ?? row.status;
  }
  // `value` is null when the name table has no honest opinion — an identifier it
  // does not describe, or a width that contradicts it. The raw reading is still
  // real, so it is shown as what it is rather than as a typed number it is not.
  return row.value === null ? `raw ${row.unsigned}` : String(row.value);
}

/**
 * ⚠️ This column is ANOTHER BIKE'S — the variant file params.ecf came from, not
 * this motorcycle. The header says so and so does this function's name; nothing
 * here may ever present it as a reading. It earns its place because it is the
 * comparison that established the whole mapping, and because 21 of 233 values
 * genuinely differ.
 *
 * @param {VcuParameterRow} row
 */
function otherBikeValue(row) {
  return row.otherBikeValue === null ? "—" : String(row.otherBikeValue);
}

/** @param {VcuParameterRow} row */
function differs(row) {
  return row.status === "read" && row.value !== null && row.otherBikeValue !== null && row.value !== row.otherBikeValue;
}

/**
 * @param {HTMLElement} parent
 * @param {string} text
 * @param {string} [className]
 */
function append(parent, text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) {
    cell.className = className;
  }
  parent.appendChild(cell);
}

/** @param {string} id */
function required(id) {
  const element = document.getElementById(id);
  if (!element) {
    // The page and this module ship together, so a missing element is a broken
    // deploy rather than a condition to handle.
    throw new Error(`params: #${id} is missing from params.html`);
  }
  return element;
}
