// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WARN } from "../lib/colors.js";
import { chargeType } from "../lib/charge-write.js";
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

const status = van.state(/** @type {ChargeAutoResponse | null} */ (null));

const busy = van.state(false);
const failure = van.state("");

// The controller records `charge_auto_reason` every tick, so the page learns it moved over the
// WebSocket for free and re-reads the Pi's own phrasing once. ⚠️ Never a poll: /charge-auto is
// cheap, but the reason a poll would be watching for is already being pushed.
van.derive(() => {
  const reason = valueOf("charge_auto_reason");
  if (reason !== null && chargeType.val === "dc") {
    void refresh();
  }
});

/** Fetched on the session edge and after every toggle — never polled; the reason rides the WebSocket. */
export function ChargeAutoControl() {
  return div(() => {
    if (chargeType.val !== "dc") {
      return div();
    }
    const current = status.val;
    if (current === null) {
      void refresh();
      return div({ class: "tile span2" }, div({ class: "label" }, "Automatic charge current"));
    }
    return div(
      { class: "tile span2" },
      div({ class: "label" }, "Automatic charge current"),
      div({ class: "action-note", style: `color:${current.state.mode === "automatic" ? GOOD : MUTED}` }, () =>
        reasonText(current)
      ),
      ToggleButton(current),
      failure.val ? div({ class: "action-note", style: `color:${WARN}` }, failure.val) : div()
    );
  });
}

/** @param {ChargeAutoResponse} current */
function ToggleButton(current) {
  const wanted = current.state.mode === "automatic" ? "off" : "automatic";
  return div(
    button(
      {
        class: "action",
        disabled: () => busy.val,
        onclick: () => void toggle(wanted),
      },
      () => (busy.val ? "⏳  …" : wanted === "off" ? "Switch off for this charge" : "Let the Pi manage the current")
    ),
    div(
      { class: "action-note", style: `color:${MUTED}` },
      `It only ever lowers the current, never below ${current.floorAmps} A, and moving the dial on the bike ` +
        "stands it down for the rest of the charge."
    )
  );
}

/** @param {ChargeAutoResponse} current */
function reasonText(current) {
  if (current.state.riderOverride) {
    return "You set the current on the bike — stood down for this charge.";
  }
  const commanded = current.state.commandedAmps;
  const suffix = commanded === null ? "" : ` Commanding ${commanded} A.`;
  return `${current.message ?? REASON_TEXT[current.state.reason] ?? "Watching."}${suffix}`;
}

/**
 * The reason codes as words.
 *
 * ⚠️ A hand-kept mirror of CHARGE_AUTO_REASON in src/charge/auto-curve.ts, the same way
 * public/lib/fan-display.js mirrors FAN_REASON — the dashboard has no build step, so it cannot
 * import the enum. scripts/check-charge-auto.ts asserts the two agree code for code.
 * @type {Record<number, string>}
 */
export const REASON_TEXT = {
  0: "Off — the bike charges as it normally would.",
  1: "Waiting for a DC fast charge.",
  2: "No trustworthy pack temperature — not commanding anything.",
  3: "The DC ceiling has not arrived, so there is nothing to command against.",
  4: "You set the current on the bike — stood down for this charge.",
  5: "Watching. Not enough temperature history yet to see a trend.",
  6: "Arrived hot with no trend yet — easing the current down.",
  7: "Close to the limit — holding the current down.",
  8: "Heating towards the limit — reducing the current.",
  9: "Plenty of thermal room — giving current back.",
  10: "Holding — this current keeps the pack where it should be.",
  11: "At the floor — going lower would be slower than not acting at all.",
};

async function refresh() {
  try {
    const response = await fetch("/charge-auto", { cache: "no-store" });
    status.val = /** @type {ChargeAutoResponse} */ (await response.json());
  } catch (error) {
    // Loud but not fatal: with no status the control renders its label and nothing else, which is
    // the safe direction — it never claims the controller is on when it does not know.
    console.warn("charge-auto: status fetch failed", error);
  }
}

/** @param {"automatic" | "off"} mode */
async function toggle(mode) {
  busy.val = true;
  failure.val = "";
  try {
    const response = await fetch(`/charge-auto?mode=${mode}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "charge-auto" },
    });
    const payload = /** @type {ChargeAutoResponse} */ (await response.json());
    status.val = payload;
    if (payload.message) {
      failure.val = payload.message;
    }
  } catch (error) {
    failure.val = `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}.`;
    console.warn("charge-auto: toggle failed", error);
  } finally {
    busy.val = false;
  }
}
