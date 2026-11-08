// @ts-check

import van from "../vendor/van-1.6.1.js";
import { WARN } from "../lib/colors.js";
import { chargeType, onChargeSessionEnd, writesEnabled } from "../lib/charge-write.js";

import { valueOf } from "../lib/store.js";
import { request } from "../lib/transport.js";

/** Controller reads and reply ordering: docs/charge-controls.md. */
export function ChargeAutoControl() {
  return div(
    {
      class: "tile layout-card charge-auto-control",
      hidden: () => {
        const visible = chargeType.val === "dc" && writesEnabled();
        if (visible && !loaded.rawVal) {
          void refresh();
        }
        return !visible;
      },
    },
    div(
      { class: "layout-between" },
      div(
        { class: "layout-compact-stack" },
        div({ class: "charge-label" }, "Automatic reduction"),
        div({ class: "charge-sub", "data-auto-status": "", title: controllerSentence }, () =>
          !loaded.val
            ? "Unavailable"
            : mode.val === "off"
              ? "Off for this charge"
              : reasonCode.val === REASON_RIDER
                ? "Paused for this charge"
                : "Active for this charge"
        )
      ),
      ToggleButton()
    ),
    div(
      {
        class: "charge-sub",
        hidden: () => !failure.val,
        role: "status",
        title: () => failure.val,
        style: `color:${WARN}`,
      },
      () => (failure.val ? "Unavailable" : "")
    )
  );
}

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

// Constraints and retained findings: docs/charge-controls.md.
let lastReason = /** @type {number | null} */ (null);
let lastTargetAmps = /** @type {number | null} */ (null);
van.derive(() => {
  const reason = valueOf("charge_auto_reason");
  const targetAmps = valueOf("charge_auto_target_a");
  if (chargeType.val !== "dc" || !writesEnabled()) {
    forgetTheAnswerOnScreen();
    return;
  }
  if (reason === lastReason && targetAmps === lastTargetAmps) {
    return;
  }
  lastReason = reason;
  lastTargetAmps = targetAmps;
  void refresh();
});

// The cable coming out, alongside the two sibling controls — charge-current.js clears its form here
// and charge-stop.js its outcome.
//
// ⚠️ `loaded` is the whole of it, and it is STILL load-bearing after #204 gave the Pi a true
// sentence at the edge: that made the ENDPOINT's answer true, this makes the TILE stop claiming to
// know while it re-reads. The four steps by which the previous session's sentence would otherwise
// paint for one round trip are in docs/charge-auto.md; deleting this line has been proposed twice
// and scripts/check-charge-auto-live.ts §7 is what goes red for the third.
//
// ⚠️ It does NOT belong in forgetTheAnswerOnScreen(). That also runs on a failed read, where
// clearing `loaded` would make the tile's own `!loaded` render re-fetch immediately, unpaced,
// against a Pi that is already not answering.
onChargeSessionEnd(() => {
  loaded.val = false;
});

function ToggleButton() {
  return button(
    {
      class: "control-button",
      "data-charge-action": "automatic",
      "aria-pressed": () => String(loaded.val && mode.val === "automatic" && reasonCode.val !== REASON_RIDER),
      disabled: () => busy.val || !loaded.val,
      onclick: () => void toggle(toggleAction(mode.val, reasonCode.val, floorAmps.val).mode),
    },
    () => (busy.val ? "Waiting…" : mode.val === "off" || reasonCode.val === REASON_RIDER ? "Resume" : "Switch off")
  );
}

/** `CHARGE_AUTO_REASON.RIDER` — stood down because the rider set a current. Mirrors auto-curve.ts. */
export const REASON_RIDER = 4;

/** Constraints and retained findings: docs/charge-controls.md.
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

/** Detailed controller state for the status tooltip and live harness.
 * @returns {string} */
export function controllerSentence() {
  if (!loaded.val) return "";
  const suffix = commandedAmps.val === null ? "" : ` Commanding ${commandedAmps.val} A.`;
  return `${reasonSentence.val}${suffix}`;
}

/**
 * Which read has spoken most recently, so a slow answer cannot overwrite a newer one.
 *
 * ⚠️ ONE controller tick issues TWO reads, tens of milliseconds apart — src/charge/auto.ts records
 * the reason, awaits the command, then records the amps — and the FIRST reply carries the amps from
 * BEFORE the command. Replied out of order, which one retransmit is enough to cause, the stale one
 * lands last and the tile keeps the pre-command number for the rest of a settled charge: issue
 * #200's own symptom, reached through its own fix. Measured to need ~45 ms of skew.
 */
let latestRead = 0;

async function refresh() {
  const read = (latestRead += 1);
  try {
    const response = await request("/charge-auto", { cache: "no-store" });
    const payload = /** @type {ChargeAutoResponse} */ (await response.json());
    if (read !== latestRead) {
      // A newer read was issued while this one was in flight, so its answer is at least as fresh.
      return;
    }
    apply(payload);
  } catch (error) {
    // ⚠️ The pair was taken on the assumption this would land, so a read that ATTEMPTED and did not
    // act must forget it or the wake-up is gone for good — trap #2 in docs/dashboard-decisions.md,
    // on the failing path rather than the gated one. The next heartbeat re-sends both signals, sees
    // a pair we no longer hold, and tries again.
    forgetTheAnswerOnScreen();
    // Loud but not fatal: with no status the control renders its label and nothing else, which is
    // the safe direction — it never claims the controller is on when it does not know.
    console.warn("charge-auto: status fetch failed", error);
  }
}

/**
 * Drops the page's memory of what the tile is showing, so the next opportunity re-reads the Pi.
 *
 * The one place the invariant is expressed, called from the two paths that must not consume a
 * change: the gate being shut, and a read that failed. `null` is not "no reason" — it is "we are no
 * longer claiming to know", which is why a signal genuinely absent (a controller that has not
 * ticked yet) compares equal to it and does NOT fire a read. The tile's own `!loaded` render fetch
 * is what covers that case, and it is the reason that fetch is still there.
 */
function forgetTheAnswerOnScreen() {
  lastReason = null;
  lastTargetAmps = null;
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
    const response = await request(`/charge-auto?mode=${wanted}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "charge-auto" },
    });
    const payload = /** @type {ChargeAutoResponse} */ (await response.json());
    // ⚠️ Takes a read number rather than checking one, so a POST reply is never dropped: it is the
    // Pi's answer to something we just asked for, and it is the only reply carrying `message` — the
    // refusal text when CHARGE_AUTO_ENABLED pins the mode off. Any read already in flight is older
    // than it by construction, and setMode() records the reason immediately, so one usually is.
    latestRead += 1;
    apply(payload);
  } catch (error) {
    failure.val = `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}.`;
    console.warn("charge-auto: toggle failed", error);
  } finally {
    busy.val = false;
  }
}
