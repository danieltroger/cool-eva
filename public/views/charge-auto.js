// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WARN } from "../lib/colors.js";
import { chargeType, writesEnabled } from "../lib/charge-write.js";
import { valueOf } from "../lib/store.js";

const { button, div } = van.tags;

// The switch for the automatic DC charge-current controller, on the charge tab.
//
// ⚠️ NO two-tap arming, deliberately, and this is the same call src/http/fan.ts made for the fan
// slider: the arming gesture belongs in front of things that change the MOTORCYCLE. This changes
// whether a controller is allowed to lower a current the rider can take straight back on the bike's
// own dial — and switching it off does not undo a command already sent. What it toggles is a
// permission, not an action.
//
// It shows only during a DC charge: there is nothing to say about it otherwise, and a control that
// is visible but inert on every other screen is one more thing to read past.

/** @typedef {import("../../src/http/charge-auto.ts").ChargeAutoResponse} ChargeAutoResponse */

// Primitive states, assigned in one place, so an unchanged refresh costs nothing. ⚠️ A single state
// holding the payload would rebuild the whole tile — button included — on every fetch, because
// `response.json()` is a new object each time. That is the churn public/lib/charge-write.js
// documents and removes; a tile that rebuilds under a thumb is how a tap gets lost.
const mode = van.state(/** @type {"automatic" | "off"} */ ("off"));
const reasonCode = van.state(/** @type {number | null} */ (null));
const reasonSentence = van.state("");
const commandedAmps = van.state(/** @type {number | null} */ (null));
const floorAmps = van.state(0);
const busy = van.state(false);
const failure = van.state("");
const loaded = van.state(false);

// The controller records `charge_auto_reason` every tick, so the page learns it moved over the
// WebSocket and re-reads the Pi's phrasing once.
//
// ⚠️ GUARDED on the VALUE, not on the state changing. ws.ts heartbeats a FULL SNAPSHOT every 5 s and
// store.js assigns a freshly parsed object, so this signal's identity changes every heartbeat
// whether or not the number moved — an unguarded derive is then a 0.2 Hz poll of an HTTP endpoint,
// exactly what the comment here used to claim it was not. charge-write.js guards the same way.
let lastReason = /** @type {number | null} */ (null);
van.derive(() => {
  const reason = valueOf("charge_auto_reason");
  if (reason === null || reason === lastReason) {
    return;
  }
  lastReason = reason;
  if (chargeType.val === "dc" && writesEnabled()) {
    void refresh();
  }
});

/** Fetched on the session edge and after every toggle — never polled; the reason rides the WebSocket. */
export function ChargeAutoControl() {
  return div(() => {
    // ⚠️ Gated on writesEnabled() like the two sibling controls: the controller transmits through
    // /vcu-write, so on a phone that never enabled writes it is inert and offering a switch for it
    // would be offering a switch that does nothing. Hidden, not disabled, for the same reason.
    if (chargeType.val !== "dc" || !writesEnabled()) {
      return div();
    }
    if (!loaded.val) {
      void refresh();
      return div({ class: "tile span2" }, div({ class: "label" }, "Automatic charge current"));
    }
    // ⚠️ The tile itself is built ONCE per visibility change; everything that moves is a thunk
    // inside it, so a refresh updates text in place instead of replacing the button under a thumb.
    return div(
      { class: "tile span2" },
      div({ class: "label" }, "Automatic charge current"),
      div({ class: "action-note" }, () =>
        div({ style: `color:${mode.val === "automatic" ? GOOD : MUTED}` }, sentence())
      ),
      ToggleButton(),
      div({ class: "action-note", style: `color:${WARN}` }, () => failure.val)
    );
  });
}

function ToggleButton() {
  return div(
    button(
      {
        class: "action",
        disabled: () => busy.val,
        // Read at click time, not captured: the state moves under the button between renders.
        onclick: () => void toggle(toggleAction(mode.val, reasonCode.val, floorAmps.val).mode),
      },
      () => (busy.val ? "⏳  …" : toggleAction(mode.val, reasonCode.val, floorAmps.val).label)
    ),
    div(
      { class: "action-note", style: `color:${MUTED}` },
      () => toggleAction(mode.val, reasonCode.val, floorAmps.val).note
    )
  );
}

/** `CHARGE_AUTO_REASON.RIDER` — stood down because the rider set a current. Mirrors auto-curve.ts. */
export const REASON_RIDER = 4;

/**
 * What the one button says, what it POSTs, and the sentence under it.
 *
 * ⚠️ THREE states, not two, and the third is the reason this exists. While stood down the effective
 * mode is still `automatic`, so a plain on/off toggle read "Switch off for this charge" — the
 * opposite of what the rider wanted — and taking the controller back meant tapping OFF and then ON,
 * two taps through a label that says the wrong thing. `mode=automatic` already clears the stand-down
 * in src/charge/auto.ts, so this is one tap; only the wording was missing.
 *
 * Pure — the floor arrives as an argument rather than being read off the module state, so the label
 * binding gains no dependency it does not need and the check asserts the sentence a rider actually
 * sees. Exported so scripts/check-charge-auto.ts can drive all three states without a browser.
 * @param {"automatic" | "off"} currentMode
 * @param {number | null} reason
 * @param {number} floor_a
 * @returns {{ label: string, mode: "automatic" | "off", note: string }}
 */
export function toggleAction(currentMode, reason, floor_a) {
  const floor = `It only ever lowers the current, never below ${floor_a} A`;
  if (reason === REASON_RIDER) {
    return {
      label: "↩️  Take the current back",
      mode: "automatic",
      note: `You set the current yourself, so the Pi stopped managing it. ${floor}.`,
    };
  }
  if (currentMode === "automatic") {
    return {
      label: "Switch off for this charge",
      mode: "off",
      note: `${floor}, and setting a different current yourself — on the bike or from here — hands it back to you.`,
    };
  }
  return {
    label: "Let the Pi manage the current",
    mode: "automatic",
    note: `${floor}, and it stops the pack reaching the temperature where the bike halves the current.`,
  };
}

/**
 * What the controller is doing, in words.
 *
 * ⚠️ No special case for the rider override: the controller already reports it as its REASON, and a
 * branch here beat that — with the toggle off and an override latched the tile said "you set the
 * current on the bike" instead of "off".
 */
function sentence() {
  const suffix = commandedAmps.val === null ? "" : ` Commanding ${commandedAmps.val} A.`;
  return `${reasonSentence.val}${suffix}`;
}

async function refresh() {
  try {
    const response = await fetch("/charge-auto", { cache: "no-store" });
    apply(/** @type {ChargeAutoResponse} */ (await response.json()));
  } catch (error) {
    // Loud but not fatal: with no status the control renders its label and nothing else, which is
    // the safe direction — it never claims the controller is on when it does not know.
    console.warn("charge-auto: status fetch failed", error);
  }
}

/**
 * The one place the payload is unpacked, so the primitives cannot drift from each other.
 * @param {ChargeAutoResponse} payload
 */
function apply(payload) {
  mode.val = payload.state.mode;
  reasonCode.val = payload.state.reason;
  reasonSentence.val = payload.reasonText;
  commandedAmps.val = payload.state.commandedAmps;
  floorAmps.val = payload.floorAmps;
  failure.val = payload.message ?? "";
  loaded.val = true;
}

/** @param {"automatic" | "off"} wanted */
async function toggle(wanted) {
  busy.val = true;
  failure.val = "";
  try {
    const response = await fetch(`/charge-auto?mode=${wanted}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "charge-auto" },
    });
    const payload = /** @type {ChargeAutoResponse} */ (await response.json());
    apply(payload);
  } catch (error) {
    failure.val = `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}.`;
    console.warn("charge-auto: toggle failed", error);
  } finally {
    busy.val = false;
  }
}
