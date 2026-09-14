// @ts-check

import van from "../vendor/van-1.6.1.js";
import { MUTED, WARN } from "./colors.js";

// Which codes this bike is expected to have, as the Pi holds them.
//
// ⚠️ A rendering preference, not a filter. An expected code is still read, still counted in
// every total on the tab and still expandable — what changes is that it sorts below the
// unexpected ones in the ACTIVE list, and carries a tag. Nothing is hidden: a list that
// quietly drops codes would be worse than no list, on the one screen whose job is telling
// you what is wrong with the motorcycle.
//
// ⚠️ Keyed on (component, symptom) and never on the OBD code, because the OBD column is not
// unique — `U0182` is both (39,3) and (40,3). It is also the key `views/faults.js` already
// has on a code line and already gates its expand affordance on.

/** @typedef {import("../../src/http/expected-faults.ts").ExpectedFaultsResponse} ExpectedFaultsResponse */

/**
 * `34, 1` → `"34/1"`. The one place this key is spelled on the browser side.
 * @param {number} component
 * @param {number} symptom
 * @returns {string}
 */
export function faultKey(component, symptom) {
  return `${component}/${symptom}`;
}

/** The marked codes as `"component/symptom"` strings. Empty until the fetch lands. */
export const expectedFaults = van.state(/** @type {Set<string>} */ (new Set()));

/**
 * The code whose last write failed, and what went wrong. `key` is `""` when nothing has.
 *
 * ⚠️ KEYED, not a bare message. As one module-level string rendered inside every
 * `ExpectedToggle`, one failed POST printed "the change may have saved anyway" under every
 * toggle on the tab — four of them, three about codes nobody had touched, each telling
 * their owner something may have happened to a change nobody made.
 */
export const expectedFaultsError = van.state({ key: "", message: "" });

/** The code whose write is in flight, or `""`. One at a time; see `setExpectedFault`. */
const writing = van.state("");

let inFlight = false;

/**
 * Fetches the list, once per entry to the Faults tab.
 *
 * ⚠️ Per ENTRY, not once per session, and deliberately: the file is the truth and two
 * phones can be on this tab at once, so coming back should show what the other one did.
 * The in-flight flag is what stops tab-flipping stacking requests — gating on `size`
 * instead would never refetch, because an empty list is the normal state of a Pi nobody
 * has marked anything on.
 *
 * A failure leaves the set empty, which renders every code unmarked — the safe direction,
 * since nothing is then sorted out of the way.
 */
export async function loadExpectedFaults() {
  if (inFlight) {
    return;
  }
  inFlight = true;
  try {
    const response = await fetch("/expected-faults", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    apply(/** @type {ExpectedFaultsResponse} */ (await response.json()));
  } catch (error) {
    // Logged, never swallowed: on a bike you cannot attach a debugger to, a list that
    // silently failed to load looks exactly like a list nobody has filled in.
    console.warn("expected-faults: could not load the list — every code will render unmarked:", error);
  } finally {
    inFlight = false;
  }
}

/**
 * Marks one code expected, or unmarks it, and keeps whatever the Pi says afterwards.
 *
 * ⚠️ The server's answer replaces the local set rather than the local set being patched
 * optimistically. Two phones can be on this tab at once, and the file is the truth.
 * @param {number} component
 * @param {number} symptom
 * @param {boolean} expected
 */
export async function setExpectedFault(component, symptom, expected) {
  const key = faultKey(component, symptom);
  // ⚠️ ONE WRITE AT A TIME, because the Pi's side is a read-modify-write: load the list,
  // filter, replace the file. Two quick taps on different codes both read the same list and
  // the second write wins, and since this applies the SERVER's answer rather than patching
  // locally, the first tick simply vanishes with nothing said. Refusing the second tap is
  // the honest version — the button is disabled while one is in flight, so this is the
  // backstop rather than the mechanism.
  if (writing.val !== "") {
    return;
  }
  writing.val = key;
  expectedFaultsError.val = { key: "", message: "" };
  try {
    const response = await fetch(
      `/expected-faults?component=${component}&symptom=${symptom}&expected=${expected ? 1 : 0}`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "X-Cool-Eva": "expected-faults" },
      }
    );
    const payload = /** @type {ExpectedFaultsResponse} */ (await response.json());
    apply(payload);
    if (!response.ok) {
      expectedFaultsError.val = { key, message: payload.message ?? `HTTP ${response.status}` };
    }
  } catch (error) {
    // ⚠️ Says the change may not have landed rather than implying it did not: the request
    // reaches the Pi before the response comes back, so a dropped garage-wifi reply is not
    // evidence the file is unchanged.
    console.warn("expected-faults: could not save the change", error);
    expectedFaultsError.val = {
      key,
      message: `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. The change may have saved anyway.`,
    };
  } finally {
    writing.val = "";
  }
}

/** @param {ExpectedFaultsResponse} payload */
function apply(payload) {
  expectedFaults.val = new Set(payload.expected.entries.map(entry => faultKey(entry.component, entry.symptom)));
}

const { button, div } = van.tags;

/**
 * Whether this code is on the owner's expected list.
 *
 * ⚠️ Reads `expectedFaults.val` rather than peeking, so a tag, a count and the active
 * list's order all re-render when a toggle lands. This is a thing to REACT to, not to
 * sample — `peek()` here would leave the screen showing the state before the tap.
 * @param {string | null} key
 */
export function isExpected(key) {
  return key !== null && expectedFaults.val.has(key);
}

/**
 * `" · 5 expected"` for a list of code rows, or `""` when none is marked.
 *
 * ⚠️ The caller labels which POPULATION it counted. The Faults tab carries two lists that
 * always disagree — the hub's ACTIVE one and OBD mode 03's STORED history, 0 or 1 against
 * 41 on this bike — and a bare "5 expected" would be read as belonging to whichever the
 * reader was looking at.
 * @param {{ component: number | null, symptom: number | null }[]} rows
 */
export function expectedNote(rows) {
  const count = rows.filter(
    row => row.component !== null && row.symptom !== null && isExpected(faultKey(row.component, row.symptom))
  ).length;
  return count === 0 ? "" : ` · ${count} expected`;
}

/**
 * The mark-as-expected control.
 *
 * ⚠️ On a stored code line it renders INSIDE the opened code, never on the line itself:
 * `.code-line` is a `div` with `role="button"` and its own key handler, and a real
 * `<button>` nested in that is a control inside a control — two tap targets in one row on
 * a phone, and a screen reader announcing a button within a button. Expanding a code and
 * then marking it is also the order the decision is made in: you look at what it recorded,
 * then say whether you expected it.
 * @param {string} key `"component/symptom"`
 */
export function ExpectedToggle(key) {
  const [component, symptom] = key.split("/").map(Number);
  return div(
    button(
      {
        class: "code-toggle",
        // Disabled while any write is in flight, not just this one: the Pi serialises them,
        // and a second tap during the first would be read-modify-written over.
        disabled: () => writing.val !== "",
        onclick: () => void setExpectedFault(component, symptom, !expectedFaults.val.has(key)),
      },
      () => {
        if (writing.val === key) {
          return "⏳  saving…";
        }
        return expectedFaults.val.has(key) ? "◉  expected — tap to unmark" : "○  mark as expected";
      }
    ),
    () =>
      expectedFaultsError.val.key === key
        ? div({ class: "code-fields", style: `color:${WARN}` }, expectedFaultsError.val.message)
        : div({ style: `color:${MUTED}` })
  );
}
