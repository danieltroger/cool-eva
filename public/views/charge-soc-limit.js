// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WARN, WATCH } from "../lib/colors.js";
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

/**
 * The control, or an empty node when it must not be offered.
 *
 * ⚠️ Hidden rather than disabled for a phone that never enabled writes, exactly like the two
 * controls beside it: an ordinary phone sees a read-only Charge tab.
 */
export function ChargeSocLimitControl() {
  // Standalone control mounts share permission; only the route constructor starts a CAN read.
  void ensureWriteStatus();
  return div(() => {
    // ⚠️ The VALUE is a read-only signal, arriving over the WebSocket whenever the rider sets the
    // limit on the bike's own menu, so it shows on any phone. Only the BUTTONS are behind the
    // writes gate. Gating the whole tile meant an ordinary phone could receive the limit and not
    // display it — the one read-only thing this feature adds, invisible by default.
    const known = socKnown.val;
    if (!known && !writesEnabled()) {
      return div();
    }
    return div(
      { class: "tile charge-soc-control" },
      div({ class: "label" }, "Bike’s saved charge limit"),
      CurrentValue(),
      () => (writesEnabled() ? SetRow() : div()),
      div({ class: "sub" }, () =>
        parsedPercent() === 0
          ? "0 removes the limit; the bike can charge to full."
          : "Retained after unplugging. A saved limit is not a promise of where this charge will stop."
      ),
      Outcome()
    );
  });
}

const { button, div, input, span } = van.tags;

// Stored SOC limit: confirmed Set, automatic opening read, and real read-back.
// Current policy and superseded stationary/read-arming rationale: docs/dash-command-0x2c-charge-limit.md.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

/** What the owner typed, as text so an empty box is distinct from a zero. */
const wanted = van.state("");
const socKnown = van.derive(() => valueOf("charge_soc_limit_pct") !== null);
const busy = van.state(false);
/** Keeps opening-read progress separate from Set's send/verification state.
 * @type {import("../vendor/van-1.6.1.js").State<"" | "write" | "read">} */
const sending = van.state("");
const message = van.state("");
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
  if (peekView() !== "charge-controls" || destination.rawVal !== "") return;
  const entryNumber = ++openingEntryNumber;
  const answered = await ensureWriteStatus();
  if (entryNumber !== openingEntryNumber || peekView() !== "charge-controls" || destination.rawVal !== "") return;
  if (!answered || !writesEnabled() || busy.rawVal || armed.rawVal !== "") return;
  await performSocLimitRead();
}

/** What the bike says its limit is, or that nobody has asked yet. */
function CurrentValue() {
  return div({ class: "value", "data-saved-charge-limit": "" }, () => {
    if (sending.val === "read") return "Reading…";
    const limit = freshValue("charge_soc_limit_pct");
    return limit === null
      ? statusWord(readingStatus("charge_soc_limit_pct"), "Unknown")
      : limit === 0
        ? "No limit"
        : `${limit} %`;
  });
}

function SetRow() {
  return div(
    { class: "compact-action-row" },
    input({
      // The class the controls beside this one use. ⚠️ There is no `action-input` rule in
      // style.css, so the box rendered 30 px wide — caught by the screenshot gate, which is the
      // only thing that could have caught it.
      class: "probe-input",
      type: "text",
      inputmode: "numeric",
      // A name rather than an id: the design sheet mounts this module more than once per document.
      // `autocomplete="off"` because an autofilled percentage on the control that decides when the
      // pack stops charging is a number nobody typed — charge-current.js argues the same for amps.
      name: "charge-soc-limit-pct",
      autocomplete: "off",
      placeholder: `0…${MAX_PCT}`,
      disabled: () => busy.val,
      value: wanted,
      oninput: event => {
        wanted.val = /** @type {HTMLInputElement} */ (event.target).value;
        // A changed number is a different command from the one that was primed.
        armed.val = "";
      },
    }),
    span("%"),
    button(
      {
        class: "action writes",
        "data-charge-action": "limit-set",
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || parsedPercent() === null,
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
      () => {
        if (sending.val === "write") {
          return "⏳  Sending…";
        }
        if (busy.val) {
          return "⏳  Checking…";
        }
        const value = parsedPercent();
        if (value === null) {
          // Disabled, so say what would enable it — the control above does the same. A disabled
          // button whose label is just "Set" leaves the reader guessing what is wrong.
          return `Set limit (0…${MAX_PCT})`;
        }
        const what = value === 0 ? "remove the limit" : `set ${value} %`;
        return armed.val === ARMED_KEY
          ? `Confirm ${value === 0 ? "remove limit" : `${value}%`}`
          : `${value === 0 ? "Remove limit" : `Set ${value}%`}`;
      }
    )
  );
}

function Outcome() {
  return div({ class: "action-note" }, () => {
    const result = lastResult.val;
    return div(
      message.val ? div({ style: `color:${result ? GOOD : WARN}` }, message.val) : div(),
      result
        ? div(
            { style: `color:${WATCH}` },
            "🔍  Read back from the VCU's own store. That it holds the limit is not proof it stops there — check the next full charge."
          )
        : div()
    );
  });
}

/** The typed percentage, or null when the box does not hold a whole 0…100. */
function parsedPercent() {
  const raw = wanted.val.trim();
  if (raw === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PCT) {
    return null;
  }
  return value;
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
        ? "Reopen Controls to try reading it again."
        : "This does NOT guarantee nothing was sent — reopen Controls to read it again before retrying.");
    console.warn("charge-soc-limit: request failed", error);
  } finally {
    sending.val = "";
    busy.val = false;
  }
  armed.val = "";
  lastResult.val = kind === "write" && payload?.result ? payload.result.succeeded : null;
}
