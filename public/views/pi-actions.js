// @ts-check

import van from "../vendor/van-1.6.1.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";

const { button, div } = van.tags;

// The two controls that MAINTAIN THE PI AS A COMPUTER: its CAN interface, and its own
// checkout and systemd unit. Split out of ./sheet.js when they gained the arming gate —
// the sheet is a composition file, and these two are a responsibility of their own.
//
// ⚠️ Not "the controls that act on the Pi": the waypoint and the ride-log download act on
// the Pi too (they write and read its log) and deliberately stayed behind. The line is
// maintenance of the machine, not use of it.
//
// Both are grey-tier `.action`, not amber `.action.writes`: amber on this sheet means
// "this touches the bike", and neither of these does. Why they arm anyway, and why the
// tier did not move with the tap count: docs/dashboard-decisions.md § "The menu sheet".

/** @typedef {import("../../src/http/can-restart.ts").CanRestartReply} CanRestartReply */
/** @typedef {import("../../src/http/update.ts").UpdateReply} UpdateReply */

/**
 * ⚠️ Their own keys, in the `<module>:<control>` spelling views/service-mode.js uses.
 * `armed` is ONE key for the whole dashboard, and every firing site tests its own before
 * it acts — which is only safe while no two controls share one. scripts/check-arming.ts §5.
 */
const CAN_RESTART_KEY = "pi-actions:can-restart";

const UPDATE_KEY = "pi-actions:update";

const canRestartMessage = van.state("");
const canRestartFailed = van.state(false);
const canRestarting = van.state(false);

/**
 * Re-ups can0 when the CAN dot has gone red. POSTs to /can-restart, which runs the two
 * `ip link` commands on the Pi; the result note reports what happened, since the bus
 * coming back is not something this button can see from here — the CAN dot in the header
 * is what confirms it a poll later.
 *
 * Styled from `ok` for the same reason UpdateButton is: /can-restart answers 500 with
 * ok:false, and a failure rendered in the same grey as a success is the bug style.css
 * argues against for .action-note.failure.
 */
export function CanRestartButton() {
  return div(
    button(
      {
        class: "action",
        disabled: canRestarting,
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        onclick: () => {
          if (armed.val !== CAN_RESTART_KEY) {
            arm(CAN_RESTART_KEY);
            return;
          }
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performCanRestart();
        },
      },
      () =>
        armed.val === CAN_RESTART_KEY
          ? "⚠️  Tap again — the link goes down and back up, and any other CAN socket dies with it"
          : "🔄  CAN bus restart"
    ),
    () =>
      canRestartMessage.val
        ? div({ class: `action-note${canRestartFailed.val ? " failure" : ""}` }, canRestartMessage.val)
        : div()
  );
}

const updateMessage = van.state("");
const updateFailed = van.state(false);
const updating = van.state(false);

/**
 * Pulls the latest code on the Pi. POSTs to /update, which runs `git pull` and returns
 * git's own output verbatim — that is the useful thing to show, since "Already up to
 * date." and a summary of what changed are both worth reading. It then restarts the
 * service so the new code takes effect, which drops this WebSocket; the store reconnects
 * on its own once the service is back.
 *
 * The note is styled from `ok`, not just filled from `message`: a failed pull used to
 * render in the same grey as a successful one, which is the bug style.css argues against
 * for .action-note.failure.
 */
export function UpdateButton() {
  return div(
    button(
      {
        class: "action",
        disabled: updating,
        onkeydown: refuseKeyRepeat,
        onclick: () => {
          if (armed.val !== UPDATE_KEY) {
            arm(UPDATE_KEY);
            return;
          }
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performUpdate();
        },
      },
      () => (armed.val === UPDATE_KEY ? "⚠️  Tap again — pulls new code and restarts the service" : "⬆  Update")
    ),
    () =>
      updateMessage.val
        ? div({ class: `action-note output${updateFailed.val ? " failure" : ""}` }, updateMessage.val)
        : div()
  );
}

/**
 * The CAN restart's firing site. Named for the `perform…` convention scripts/check-arming.ts
 * finds a firing site by, and module-level so its inputs are visible at a glance.
 *
 * ⚠️ The header is a CSRF barrier, not authentication: without it this POST is a SIMPLE
 * cross-origin request and any page the phone opens on the hotspot can drop the bus.
 * src/http/can-restart.ts holds the other end; both are literals, because neither file
 * can see the other's constant.
 */
async function performCanRestart() {
  canRestarting.val = true;
  canRestartFailed.val = false;
  canRestartMessage.val = "restarting…";
  try {
    const response = await fetch("/can-restart", { method: "POST", headers: { "X-Cool-Eva": "can-restart" } });
    const reply = /** @type {CanRestartReply} */ (await response.json());
    canRestartMessage.val = reply.message;
    canRestartFailed.val = !reply.ok;
  } catch (error) {
    console.warn("can-restart: request failed", error);
    canRestartMessage.val = "Restart request failed — is the Pi reachable?";
    canRestartFailed.val = true;
  } finally {
    canRestarting.val = false;
  }
}

/** The Update button's firing site. Its header is /update's, never /can-restart's. */
async function performUpdate() {
  updating.val = true;
  updateFailed.val = false;
  updateMessage.val = "updating…";
  try {
    const response = await fetch("/update", { method: "POST", headers: { "X-Cool-Eva": "update" } });
    const reply = /** @type {UpdateReply} */ (await response.json());
    updateMessage.val = reply.message;
    updateFailed.val = !reply.ok;
  } catch (error) {
    console.warn("update: request failed", error);
    updateMessage.val = "Update request failed — is the Pi reachable?";
    updateFailed.val = true;
  } finally {
    updating.val = false;
  }
}
