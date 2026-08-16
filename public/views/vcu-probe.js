// @ts-check

import van from "../vendor/van-1.6.1.js";
import { MUTED } from "../lib/colors.js";

const { button, div, input, option, select, span } = van.tags;

// "Probe index N" — read ONE identifier off ONE ECU, from the phone.
//
// This is the replacement for `scripts/read-vcu-params.ts --index N`, which went
// away when the sweep moved into the service. It reaches further than that flag did:
//
//  • **Any bank.** The identifier is `(bank << 12) | index`. The sweep reads bank 1,
//    the calibration EEPROM. **Bank 2 is live data** — the running values rather
//    than the stored settings — and nothing in this project had ever read one.
//
// ⚠️ It offered a CHARGE MANAGER target for part of 2026-08-16 and no longer does.
// The id pair it was given, 0x7C3/0x7E3, is not the charge manager's: **0x7E3 is the
// dashboard's request id**, so that option could have questioned the dashboard while
// this page said otherwise. The real charge manager is 29-bit ISO-TP and needs
// transport work this form cannot fake. See src/vcu/param-codec.ts above `VcuTarget`.
//
// ── Why it is a form and not a link ─────────────────────────────────────────
// Because you do not know what you want until you are standing there. The whole use
// is "the manual mentions an address, what does this bike say about it", and that is
// three fields and a button — not a route, not a saved list, and not something to
// design a schema for before anyone has read a single bank-2 value.
//
// ── Why the result shows two numbers ────────────────────────────────────────
// Outside bank 1 nothing here knows a record's width or whether it is signed. So the
// raw bytes lead, and BOTH the unsigned and the signed reading are shown, neither
// called "the value". Picking one would be inventing the half of the answer that was
// not read off the bus. Where the name table does have an opinion — a bank-1 index
// it describes — the typed value is shown as well, with its name.

/** @typedef {import("../../src/http/vcu-probe.ts").VcuProbeResponse} VcuProbeResponse */

const target = van.state("A9");
const bank = van.state("1");
const index = van.state("");
const busy = van.state(false);
const result = van.state(/** @type {VcuProbeResponse | null} */ (null));

/**
 * The probe form and its last answer.
 *
 * `enabled` comes from the service-mode section rather than being fetched again:
 * both controls are governed by the same gate and the same switch, and two sections
 * polling the Pi to reach the same conclusion would only let them disagree.
 *
 * @param {() => boolean} canReach whether the bike is currently reachable and safe to service
 */
export function VcuProbe(canReach) {
  return div(
    div(
      { class: "probe-row" },
      Field("ECU", () =>
        select(
          {
            class: "probe-input",
            value: target,
            onchange: (/** @type {Event} */ event) => {
              target.val = /** @type {HTMLSelectElement} */ (event.target).value;
            },
          },
          // The two VCU micros the parameter table describes, and nothing else — see
          // the header for the charge-manager option that used to be here.
          option({ value: "A9" }, "A9 — VCU"),
          option({ value: "A8" }, "A8 — VCU")
        )
      ),
      Field("Bank", () =>
        select(
          {
            class: "probe-input",
            value: bank,
            onchange: (/** @type {Event} */ event) => {
              bank.val = /** @type {HTMLSelectElement} */ (event.target).value;
            },
          },
          option({ value: "1" }, "1 — stored"),
          option({ value: "2" }, "2 — live"),
          option({ value: "0" }, "0"),
          option({ value: "3" }, "3")
        )
      ),
      Field("Index", () =>
        input({
          class: "probe-input",
          type: "text",
          inputmode: "numeric",
          placeholder: "e.g. 258 or 0x102",
          value: index,
          oninput: (/** @type {Event} */ event) => {
            index.val = /** @type {HTMLInputElement} */ (event.target).value;
          },
        })
      )
    ),
    button(
      {
        class: "action",
        disabled: () => busy.val || index.val.trim().length === 0 || !canReach(),
        onclick: () => void probe(),
      },
      () => (busy.val ? "⏳  Reading…" : "🔎  Probe this identifier")
    ),
    ProbeResult()
  );
}

/** @param {string} label @param {() => Element} control */
function Field(label, control) {
  return div({ class: "probe-field" }, div({ class: "probe-label" }, label), control());
}

function ProbeResult() {
  return div({ class: "action-note" }, () => {
    const current = result.val;
    if (!current) {
      return div(
        { style: `color:${MUTED}` },
        "Reads one identifier and shows you the bytes. Bank 1 is what the sweep already covers; bank 2 is live data — the running values rather than the stored settings — and nothing here has ever read one."
      );
    }
    if (!current.reading) {
      return div(current.message ?? "no answer and no reason given, which should not happen");
    }
    const reading = current.reading;
    const identifier = `0x${reading.identifier.toString(16).toUpperCase().padStart(4, "0")}`;
    const asked = `${reading.target} · bank ${reading.bank} · index ${reading.index} · CID ${identifier}`;
    if (reading.status !== "read") {
      // The status leads, not a generic failure: "refused" means the ECU is there
      // and will not serve this identifier, "no-session" means nothing answered at
      // that address at all, and those send you to different places next.
      return div(
        div(`${reading.status.toUpperCase()} — ${asked}`),
        div({ style: `color:${MUTED}` }, reading.note ?? "")
      );
    }
    return div(
      div(span({ style: "font-weight:600" }, reading.rawHex ?? ""), ` — ${asked}`),
      div(
        `unsigned ${reading.unsigned} · signed ${reading.signed}` +
          (reading.value === null ? "" : ` · ${reading.name ?? "typed"} = ${reading.value}`)
      ),
      reading.note ? div({ style: `color:${MUTED}` }, reading.note) : div()
    );
  });
}

async function probe() {
  busy.val = true;
  try {
    const query = new URLSearchParams({ target: target.val, bank: bank.val, index: index.val.trim() });
    const response = await fetch(`/vcu-probe?${query}`, {
      method: "POST",
      cache: "no-store",
      // Same reasoning as /vcu-read's start: a header a CORS-simple request cannot
      // set is what stops another page on the bike's hotspot opening a diagnostic
      // session. See the header of src/http/vcu-probe.ts.
      headers: { "X-Cool-Eva": "service-mode" },
    });
    // The body carries a reading or a reason on every status this endpoint returns,
    // so it is read before the status is judged.
    result.val = /** @type {VcuProbeResponse} */ (await response.json());
  } catch (error) {
    // Loud. The usual cause is the phone having dropped off the bike's hotspot, and
    // a button that silently does nothing is the worst version of that.
    result.val = {
      reading: null,
      message: `could not reach the Pi — ${error instanceof Error ? error.message : String(error)}`,
      gate: { safe: false, blockers: [], checks: [], chargingEvidence: null },
      targets: [],
    };
    console.warn("vcu-probe: request failed", error);
  } finally {
    busy.val = false;
  }
}
