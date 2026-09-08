// @ts-check

import van from "../vendor/van-1.6.1.js";
import { isStale, valueOf } from "./store.js";
import { armed } from "./arming.js";

// The session/status machinery the charge-tab write controls share — charge-current.js sets a
// current, charge-stop.js ends the charge, and both need the SAME answers: is a charge live, is
// it AC or DC, and is writing switched on for this Pi. Kept in one place so the two controls
// cannot disagree about when a command may be offered, and so each stays under the file-size line.
//
// ⚠️ Session presence and the AC/DC label ride on charge_manager_state (0x610 b7), NOT charge_type:
// charge_type flaps 1↔0 within one plug-in as the charger pauses delivery (docs/charge-manager.md),
// which is exactly what once made the charge-current tile vanish mid-session. charge_manager_state
// holds steady for the whole session.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

/**
 * How stale charge_manager_state may be before this treats the session as gone. Matches the Pi's
 * own CHARGE_SESSION_MAX_AGE_MS in src/vcu/write-runner.ts, so the controls and the server agree
 * on when there is a live charge to command into.
 */
export const CHARGE_SESSION_MAX_AGE_MS = 5000;

/** charge_manager_state (0x610 b7) settled values: 0x02 AC, 0x23 DC. */
const CHARGE_MANAGER_STATE_AC = 0x02;
const CHARGE_MANAGER_STATE_DC = 0x23;

/**
 * AC ceiling used when the dash has not broadcast ac_charge_ceiling_a this session — the remote
 * case, where nobody is at the bike to nudge the charge-current dial. Must match the Pi's
 * AC_CEILING_FALLBACK_A in src/vcu/write-runner.ts, which puts this byte in the frame; here it only
 * lets the page offer and range-check the control. See docs/can-0x121-charge-command.md.
 */
const AC_CEILING_FALLBACK_A = 15;

/** The last /vcu-write status fetched — the gate, and whether writing is on at all. Shared. */
export const writeStatus = van.state(/** @type {VcuWriteResponse | null} */ (null));

/**
 * Whether a charge session is live right now, driven off charge_manager_state by the derive below.
 * ⚠️ A van.state — NOT an isStale() call in a render — so a control's visibility binding does not
 * subscribe to serverTime; were it to, it would re-run ~20 Hz and recreate any <input> under it.
 */
export const sessionLive = van.state(false);

/** Callbacks to run when a live session ends, so each control can clear its own form. */
const sessionEndListeners = /** @type {(() => void)[]} */ ([]);

/**
 * Registers a callback fired once when the live charge ends (the cable comes out).
 * @param {() => void} listener
 */
export function onChargeSessionEnd(listener) {
  sessionEndListeners.push(listener);
}

// The status fetch is lazy: nothing polls /vcu-write for a phone that is not charging, so the
// read-only screen stays a pure WebSocket consumer. This one derive (a module singleton — both
// controls import it, it runs once) tracks the live session off charge_manager_state, fetches the
// gate when a charge begins, and clears when it ends.
//
// ⚠️ It DELIBERATELY subscribes to serverTime (via liveChargeType → isStale), because the cable
// coming out is a staleness event with no value change and nothing else would notice it. It is the
// one place allowed to: it feeds the sessionLive STATE, and the controls' renders read that state
// — so no render subscribes to serverTime and no <input> is recreated under it. Cheap per tick (an
// equality check); the fetch fires only on the session edge.
let lastLive = false;
van.derive(() => {
  const live = liveChargeType() !== null;
  sessionLive.val = live;
  if (live === lastLive) {
    return;
  }
  lastLive = live;
  if (live) {
    void fetchChargeWriteStatus();
  } else {
    // A charge that ended tells us nothing about the next one's gate, and a stale "enabled" left
    // on screen would render a control against a session that is over.
    writeStatus.val = null;
    for (const listener of sessionEndListeners) {
      listener();
    }
  }
});

/**
 * The charge source right now, or null when there is no settled session to command into.
 *
 * ⚠️ Reads charge_manager_state, NOT charge_type (see the file header). Staleness-checked the same
 * way the Pi does, so a page open during a charge that has since ended will not command into a
 * gone session.
 * @returns {"ac" | "dc" | null}
 */
export function liveChargeType() {
  if (isStale("charge_manager_state", CHARGE_SESSION_MAX_AGE_MS)) {
    return null;
  }
  const state = valueOf("charge_manager_state");
  return state === CHARGE_MANAGER_STATE_AC ? "ac" : state === CHARGE_MANAGER_STATE_DC ? "dc" : null;
}

/**
 * The ceiling a charge-current command's b4 will carry, from the same live signal the Pi echoes:
 * the dash's own last AC ceiling, or the always-broadcast DC maximum. When AC has no live ceiling
 * (the dial has not been nudged this session) it falls back to AC_CEILING_FALLBACK_A so a remote
 * command still has a range — matching the Pi. DC never falls back (an absent DC ceiling means CAN
 * is not being received, not a value to guess).
 * @param {"ac" | "dc"} type
 * @returns {number | null}
 */
export function liveCeiling(type) {
  const ceiling = valueOf(type === "ac" ? "ac_charge_ceiling_a" : "fast_dc_limit_max_a");
  if (ceiling == null) {
    return type === "ac" ? AC_CEILING_FALLBACK_A : null;
  }
  return ceiling;
}

/**
 * Whether the AC ceiling in force is the fallback rather than a value the dash broadcast — so the
 * control can say it is using a default. Only ever true for AC; DC has no fallback.
 * @param {"ac" | "dc"} type
 */
export function ceilingIsFallback(type) {
  return type === "ac" && valueOf("ac_charge_ceiling_a") == null;
}

/** Whether writing is switched on for this Pi (SERVICE_WRITE_ENABLED). */
export function writesEnabled() {
  return writeStatus.val?.status?.enabled === true;
}

/** GETs the enabled flag (and the rest of the status). Read-only; touches nothing on the bike. */
export async function fetchChargeWriteStatus() {
  try {
    const response = await fetch("/vcu-write", { cache: "no-store" });
    const payload = /** @type {VcuWriteResponse} */ (await response.json());
    // Disarmed before the new status lands: writes switched off across the refresh must not
    // leave a primed button behind.
    armed.val = "";
    writeStatus.val = payload;
  } catch (error) {
    // Loud, but not fatal to the read-only screen: a failed status fetch simply leaves the
    // controls hidden (their render requires enabled === true), which is the safe direction.
    console.warn("charge-write: status fetch failed", error);
  }
}
