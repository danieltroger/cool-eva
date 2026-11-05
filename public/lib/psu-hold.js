// @ts-check
// Volatile request state, not a power measurement: docs/psu-hold.md.
import van from "../vendor/van-1.6.1.js";
import { systemStatus, chartTick, connection } from "./store.js";
import { monotonicNow, since } from "./clock.js";
import { request } from "./transport.js";
import { armed } from "./arming.js";

/** @typedef {import("../../src/psu/hold.ts").PsuHoldStatus} PsuHoldStatus */
/** @typedef {import("../../src/psu/hold.ts").PsuHoldAction} PsuHoldAction */
/** @typedef {import("../../src/http/psu-hold.ts").PsuHoldReply} PsuHoldReply */
export const psuHoldState = van.state(/** @type {PsuHoldStatus | null} */ (null));
export const psuHoldBusy = van.state(false);
export const psuHoldMessage = van.state("");
const receivedAt = van.state(0);
let readSequence = 0;

van.derive(() => {
  const current = systemStatus.val?.psuHold;
  if (current) {
    acceptState(current);
  }
});

export async function refreshPsuHold() {
  const sequence = ++readSequence;
  try {
    const response = await request("/psu-hold", { cache: "no-store" });
    const reply = /** @type {PsuHoldReply} */ (await response.json());
    if (sequence !== readSequence) return;
    acceptState(reply.state);
  } catch (error) {
    psuHoldMessage.val = "Hold status unavailable. Check the connection before trying again.";
    console.warn("psu-hold: status request failed:", error);
  }
}

/** @param {PsuHoldAction} action */
export async function performPsuHold(action) {
  const state = psuHoldState.rawVal;
  if (!state || psuHoldBusy.rawVal) return;
  psuHoldBusy.val = true;
  psuHoldMessage.val = "Waiting for the Pi…";
  try {
    const query = new URLSearchParams({
      action,
      confirm: `psu-hold-${action}`,
      revision: String(state.revision),
      instance: state.instance,
    });
    const response = await request(`/psu-hold?${query}`, {
      method: "POST",
      headers: { "X-Cool-Eva": "service-write" },
    });
    const reply = /** @type {PsuHoldReply} */ (await response.json());
    acceptState(reply.state);
    psuHoldMessage.val = reply.message;
  } catch (error) {
    psuHoldMessage.val = "Reply unavailable; the hold may have changed. Check the connection and live status.";
    console.warn("psu-hold: action reply unavailable:", error);
  } finally {
    psuHoldBusy.val = false;
  }
}

export function psuRemainingMs() {
  chartTick.val;
  const state = psuHoldState.val;
  if (connection.val !== "live" || !state) return null;
  return state.on ? Math.max(0, state.remainingMs - since(receivedAt.val)) : 0;
}

/** @param {PsuHoldStatus} next */
function acceptState(next) {
  const previous = psuHoldState.rawVal;
  if (previous?.instance === next.instance && previous.revision > next.revision) return;
  const changed = previous && (previous.instance !== next.instance || previous.revision !== next.revision);
  if (changed) {
    psuHoldMessage.val = "";
  }
  if (
    previous &&
    (changed || previous.enabled !== next.enabled || previous.refusal !== next.refusal) &&
    armed.rawVal.startsWith("psu-hold:")
  ) {
    armed.val = "";
  }
  psuHoldState.val = next;
  receivedAt.val = monotonicNow();
}
