// @ts-check

import van from "../vendor/van-1.6.1.js";
import { MUTED, WARN } from "../lib/colors.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";

import { readingStatus, statusWord, freshValue } from "../lib/reading-status.js";
import { valueOf } from "../lib/store.js";
import { peekView } from "../lib/router.js";
import { destination } from "../lib/destination.js";
import {
  applyWriteStatus,
  ensureWriteStatus,
  fetchChargeWriteStatus,
  onChargeSessionEnd,
  writesEnabled,
} from "../lib/charge-write.js";
import { request } from "../lib/transport.js";
import { chargeEdit } from "../lib/charge-edit.js";
import { chargeFailureText } from "../lib/charge-failure.js";

/**
 * The control, or an empty node when it must not be offered.
 *
 * ⚠️ Hidden rather than disabled for a phone that never enabled writes, exactly like the two
 * controls beside it: an ordinary phone sees a read-only Charge tab.
 */
export function ChargeSocLimitControl() {
  void ensureWriteStatus();
  return div(
    { class: "tile layout-card charge-soc-control", hidden: () => !socKnown.val && !writesEnabled() },
    div({ class: "charge-label" }, "Bike’s charge limit"),
    SetRow(),
    Outcome()
  );
}

const { button, div, input, span } = van.tags;

// Stored SOC limit: confirmed Set, automatic opening read, and real read-back.
// Current policy and superseded stationary/read-arming rationale: docs/dash-command-0x2c-charge-limit.md.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

/** What the owner typed, as text so an empty box is distinct from a zero. */
const wanted = van.state(/** @type {string|null} */ (null));
const attemptedPercent = van.state(/** @type {number|null} */ (null));
const socKnown = van.derive(() => valueOf("charge_soc_limit_pct") !== null);
const busy = van.state(false);
/** Keeps opening-read progress separate from Set's send/verification state.
 * @type {import("../vendor/van-1.6.1.js").State<"" | "write" | "read">} */
const sending = van.state("");
const message = van.state("");
const failure = van.state("");
/** Whether the last command was accepted AND read back. Null when nothing has been tried. */
const lastResult = van.state(/** @type {boolean | null} */ (null));

// ⚠️ A charge ENDING hides this control, which is the opposite of what it is for. The session
// derive calls applyWriteStatus(null) on the live→dead edge (../lib/charge-write.js), and this
// control's visibility reads that state — so pressing "Stop the DC charge" on this very tab, or
// pulling the cable, made the card vanish until the tab was switched away and back. The other
// three controls use this hook to CLEAR themselves; this one uses it to come back.
onChargeSessionEnd(() => {
  // The verdict belonged to the charge that just ended. The typed value does not — this control
  // is not session-scoped, so a cable coming out is no reason to wipe what someone was typing.
  message.val = "";
  lastResult.val = null;
  attemptedPercent.val = null;
  void ensureWriteStatus();
});

export const ARMED_KEY = "charge-soc-limit";

/**
 * The highest percentage the command byte carries.
 *
 * ⚠️ It must equal `MAX_SOC_LIMIT_PCT` in src/can/charge-soc-command.ts, which is the number the
 * Pi's own builder throws outside — a browser file cannot import a .ts module, so the equality is
 * asserted by scripts/check-charge-soc-limit.ts rather than claimed here.
 */
export const MAX_PCT = 100;

let openingEntryNumber = 0;

/** Called only by the route constructor; raw reads before await avoid subscribing that binding. */
export async function readChargeSocLimitOnEntry() {
  if (peekView() !== "charge" || destination.rawVal !== "") return;
  const entryNumber = ++openingEntryNumber;
  const answered = await ensureWriteStatus();
  if (entryNumber !== openingEntryNumber || peekView() !== "charge" || destination.rawVal !== "") return;
  if (!answered || !writesEnabled() || busy.rawVal || armed.rawVal !== "") return;
  await performSocLimitRead();
}

function SetRow() {
  return div(
    { class: "charge-control-row" },
    div(
      { class: "layout-row charge-entry" },
      input({
        // The class the controls beside this one use. ⚠️ There is no `action-input` rule in
        // style.css, so the box rendered 30 px wide — caught by the screenshot gate, which is the
        // only thing that could have caught it.
        class: "probe-input charge-input",
        type: "number",
        min: 0,
        max: MAX_PCT,
        step: 1,
        "aria-label": "Charge limit percentage",
        inputmode: "numeric",
        // A name rather than an id: the design sheet mounts this module more than once per document.
        // `autocomplete="off"` because an autofilled percentage on the control that decides when the
        // pack stops charging is a number nobody typed — charge-current.js argues the same for amps.
        name: "charge-soc-limit-pct",
        autocomplete: "off",
        placeholder: "—",
        "aria-invalid": () => String(wanted.val !== null && edit().value === null),
        disabled: () => busy.val || sending.val === "read" || !writesEnabled(),
        value: () =>
          wanted.val ?? (freshValue("charge_soc_limit_pct") === null ? "" : String(freshValue("charge_soc_limit_pct"))),
        oninput: event => {
          wanted.val = /** @type {HTMLInputElement} */ (event.target).value;
          message.val = "";
          lastResult.val = null;
          attemptedPercent.val = null;
          // A changed number is a different command from the one that was primed.
          armed.val = "";
        },
      }),
      span({ class: "unit" }, "%")
    ),
    button(
      {
        class: "control-button writes",
        "data-charge-action": "limit-set",
        hidden: () => !writesEnabled(),
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || !writesEnabled() || parsedPercent() === null || !edit().changed,
        onclick: () => {
          if (armed.val !== ARMED_KEY) {
            void armSocLimit();
            return;
          }
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performSocLimit();
        },
      },
      () =>
        sending.val === "write" || busy.val
          ? "Waiting…"
          : armed.val === ARMED_KEY
            ? parsedPercent() === 0
              ? "Confirm remove limit"
              : `Confirm ${parsedPercent()} %`
            : "Set"
    )
  );
}

function Outcome() {
  return div(
    {
      class: "charge-sub charge-control-status",
      "data-limit-status": "",
      role: "status",
      title: () => message.val,
      style: () => `color:${message.val && lastResult.val !== true ? WARN : MUTED}`,
    },
    () => {
      if (sending.val === "read") return "Reading from bike…";
      if (sending.val === "write" || busy.val) return "Waiting for bike…";
      if (lastResult.val === true) {
        const actual = freshValue("charge_soc_limit_pct");
        if (actual === null || actual !== attemptedPercent.val) return "Waiting for bike…";
        return actual === 0 ? "Bike confirmed no limit" : `Bike confirmed ${actual} %`;
      }
      if (message.val) return failure.val;
      if (wanted.val !== null) {
        if (edit().value === null) return `Use 0–${MAX_PCT} %`;
        if (edit().changed) return "Not sent";
      }
      const value = freshValue("charge_soc_limit_pct");
      return value === null
        ? statusWord(readingStatus("charge_soc_limit_pct"), "Unavailable")
        : value === 0
          ? "No limit"
          : "Read from bike";
    }
  );
}
function edit() {
  return chargeEdit(wanted.val, freshValue("charge_soc_limit_pct"), 0, MAX_PCT);
}
function parsedPercent() {
  return edit().value;
}

async function armSocLimit() {
  busy.val = true;
  try {
    await fetchChargeWriteStatus();
  } finally {
    busy.val = false;
  }
  if (writesEnabled() && parsedPercent() !== null) {
    arm(ARMED_KEY);
  }
}

async function performSocLimit() {
  const value = parsedPercent();
  if (value === null) {
    return;
  }
  // The confirm carries the value, so a page showing one percentage cannot POST another — and 0
  // has its own word, because it removes the battery protection rather than moving it.
  attemptedPercent.val = value;
  const confirm = value === 0 ? "charge-soc-limit-off" : `charge-soc-limit-${value}`;
  await post(new URLSearchParams({ list: "0", action: "charge-soc-limit", pct: String(value), confirm }), "write");
}

async function performSocLimitRead() {
  await post(new URLSearchParams({ list: "0", action: "charge-soc-limit-read" }), "read");
}

/**
 * POSTs one action and records what came back.
 * @param {URLSearchParams} query
 * @param {"write" | "read"} kind keeps read progress separate from Set verification
 */
async function post(query, kind) {
  message.val = "";
  sending.val = kind;
  busy.val = true;
  let payload = /** @type {VcuWriteResponse | null} */ (null);
  try {
    const response = await request(`/vcu-write?${query}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-write" },
    });
    payload = /** @type {VcuWriteResponse} */ (await response.json());
    applyWriteStatus(payload);
    message.val =
      kind === "read" && payload.result?.succeeded ? "" : (payload.result?.message ?? payload.message ?? "");
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frame goes out
    // before the response — so this is NOT "nothing happened". Read it back before retrying.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      (kind === "read"
        ? "Reopen Charge to try reading it again."
        : "This does NOT guarantee nothing was sent — reopen Charge to read it again before retrying.");
    console.warn("charge-soc-limit: request failed", error);
  } finally {
    sending.val = "";
    busy.val = false;
  }
  armed.val = "";
  lastResult.val = kind === "write" && payload?.result ? payload.result.succeeded : null;
  failure.val = payload?.result?.succeeded ? "" : chargeFailureText(kind, payload, message.val);
}

van.derive(() => {
  if (lastResult.val === true && wanted.val !== null && edit().value === freshValue("charge_soc_limit_pct")) {
    wanted.val = null;
  }
});
