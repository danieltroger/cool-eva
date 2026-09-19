// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WARN, WATCH } from "../lib/colors.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { valueOf } from "../lib/store.js";
import {
  applyWriteStatus,
  ensureWriteStatus,
  fetchChargeWriteStatus,
  onChargeSessionEnd,
  writesEnabled,
} from "../lib/charge-write.js";

const { button, div, input } = van.tags;

// The bike's own "stop charging at N %" setting, from the charge tab — dash command 0x2C on the
// 0x120 command channel (docs/dash-command-0x2c-charge-limit.md). Same gated /vcu-write path and
// two-tap dwell as the controls beside it, and it renders nothing unless the Pi says writes are on.
//
// ⚠️ Unlike set-current and stop, this does NOT need a live charge. The limit is a stored setting
// and the Pi gates it on the ordinary bike-state gate, which passes a parked, unplugged bike —
// which is when you are most likely to be setting it. That is why this control mounts its own
// one-shot status fetch instead of riding the charge-session edge (../lib/charge-write.js).
//
// ⚠️ It is the one write on this dashboard with a REAL read-back: the VCU answers a bit-7-clear
// read with its stored value, so "written" here means the bike holds it, not that a frame left.
// What it still does NOT mean is that the bike stops there — nobody has watched the limit be
// reached — and the note under the button says so rather than implying a guarantee.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

/** What the owner typed, as text so an empty box is distinct from a zero. */
const wanted = van.state("");
const busy = van.state(false);
/** True only while a command's own POST is in flight, so "Sending…" is not shown for a status refresh. */
const sending = van.state(false);
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
 * The READ's own key, so the two buttons cannot fire on each other's first tap.
 *
 * ⚠️ A read takes two taps as well, and that is the repo's convention rather than caution for its
 * own sake: service-mode.js's parameter sweep is read-only and has taken two taps since #130,
 * because read-only or not it puts frames on the bike's bus. A one-tap button beside a two-tap one
 * would also teach the thumb that buttons here act immediately, which is the habit the dwell exists
 * to prevent. A quoted literal rather than a second export — check-arming.ts resolves either.
 */
const READ_ARMED_KEY = "charge-soc-limit-read";

/**
 * The highest percentage the command byte carries.
 *
 * ⚠️ It must equal `MAX_SOC_LIMIT_PCT` in src/can/charge-soc-command.ts, which is the number the
 * Pi's own builder throws outside — a browser file cannot import a .ts module, so the equality is
 * asserted by scripts/check-charge-soc-limit.ts rather than claimed here.
 */
export const MAX_PCT = 100;

/**
 * The control, or an empty node when it must not be offered.
 *
 * ⚠️ Hidden rather than disabled for a phone that never enabled writes, exactly like the two
 * controls beside it: an ordinary phone sees a read-only Charge tab.
 */
export function ChargeSocLimitControl() {
  // Once per mount of the Charge tab, and only when no status is held. The gate is not a
  // WebSocket signal, so without this the control could never appear on an unplugged bike.
  void ensureWriteStatus();
  return div(() => {
    if (!writesEnabled()) {
      return div();
    }
    return div({ class: "tile span2" }, div({ class: "label" }, "Charge limit"), CurrentValue(), SetRow(), Outcome());
  });
}

/** What the bike says its limit is, or that nobody has asked yet. */
function CurrentValue() {
  return div({ class: "action-note" }, () => {
    const limit = valueOf("charge_soc_limit_pct");
    if (limit === null) {
      return div(
        { style: `color:${MUTED}` },
        "Not read this session — nothing broadcasts it, so it is unknown until you read it or change it on the bike."
      );
    }
    return div(
      { style: `color:${limit === 0 ? WATCH : GOOD}` },
      // ⚠️ "Set to stop at", not "Stops at". Everything else in this feature is careful to say the
      // VCU STORES the limit rather than that the bike stops there — nobody has observed the limit
      // being reached — and this is the line a rider reads every time, not just after a command.
      limit === 0 ? "No limit — the bike charges to full." : `Set to stop at ${limit} %.`
    );
  });
}

function SetRow() {
  return div(
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
    button(
      {
        class: "action writes",
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
        if (sending.val) {
          return "⏳  Sending…";
        }
        if (busy.val) {
          return "⏳  Checking…";
        }
        const value = parsedPercent();
        if (value === null) {
          // Disabled, so say what would enable it — the control above does the same. A disabled
          // button whose label is just "Set" leaves the reader guessing what is wrong.
          return `✏️  Type a limit (0…${MAX_PCT})`;
        }
        const what = value === 0 ? "remove the limit" : `set ${value} %`;
        return armed.val === ARMED_KEY
          ? `⚠️  Tap again to ${what}`
          : `✏️  ${value === 0 ? "Remove the limit" : `Set ${value} %`}`;
      }
    ),
    button(
      {
        class: "action",
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val,
        onclick: () => {
          if (armed.val !== READ_ARMED_KEY) {
            arm(READ_ARMED_KEY);
            return;
          }
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performSocLimitRead();
        },
      },
      () => {
        if (busy.val) {
          return "…";
        }
        return armed.val === READ_ARMED_KEY ? "⚠️  Tap again to read" : "🔍  Read";
      }
    ),
    div({ class: "action-note", style: `color:${MUTED}` }, () =>
      parsedPercent() === 0
        ? "⚠️  0 removes the limit entirely — the bike would charge to 100 %."
        : "Stored on the bike, and it survives unplugging — unlike the charge current."
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
  await post(new URLSearchParams({ list: "0", action: "charge-soc-limit", pct: String(value), confirm }));
}

async function performSocLimitRead() {
  await post(new URLSearchParams({ list: "0", action: "charge-soc-limit-read" }));
}

/**
 * POSTs one action and records what came back.
 * @param {URLSearchParams} query
 */
async function post(query) {
  message.val = "";
  sending.val = true;
  busy.val = true;
  let payload = /** @type {VcuWriteResponse | null} */ (null);
  try {
    const response = await fetch(`/vcu-write?${query}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-write" },
    });
    payload = /** @type {VcuWriteResponse} */ (await response.json());
    applyWriteStatus(payload);
    message.val = payload.result?.message ?? payload.message ?? "";
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frame goes out
    // before the response — so this is NOT "nothing happened". Read it back before retrying.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "This does NOT guarantee nothing was sent — read the limit before trying again.";
    console.warn("charge-soc-limit: request failed", error);
  } finally {
    sending.val = false;
    busy.val = false;
  }
  armed.val = "";
  lastResult.val = payload?.result ? payload.result.succeeded : null;
}
