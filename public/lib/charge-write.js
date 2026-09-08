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
 * How stale charge_manager_state may be before this treats the session as gone.
 *
 * ⚠️ 12 s, and it MUST stay above ws.ts's HEARTBEAT_MS (5000). It used to be 5000 to "match the
 * Pi", which cannot work: the Pi's `ageMs()` is refreshed by every 0x610 frame (~10 Hz), while the
 * browser learns an age only from a WebSocket message and `record()` patches only on CHANGE —
 * charge_manager_state holds 0x23 all session (8399 frames, zero changes), so the browser's copy is
 * refreshed only by the heartbeat. Same number, different clocks, and the tile unmounted on every
 * late timer. charge-mode.js already learned this; its CONTACTOR_LIVE_MS is 12 s.
 * check-charge-write-visibility.ts §2 asserts this stays above the heartbeat.
 */
export const CHARGE_SESSION_MAX_AGE_MS = 12_000;

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

/**
 * The charge source as a STATE — `"ac"`, `"dc"` or null — written by the same derive.
 *
 * ⚠️ This is what renders must read. Calling `liveChargeType()` inside a binding subscribes it to
 * serverTime, which VanJS then re-runs on every WebSocket message (~10 Hz on a charging bike),
 * and `update()` replaces the binding's DOM node whether or not the content changed. Six bindings
 * in charge-current.js and three in charge-stop.js did exactly that; that is the churn half of the
 * charge-tab layout shift, the unmount half being CHARGE_SESSION_MAX_AGE_MS above.
 */
export const chargeType = van.state(/** @type {"ac" | "dc" | null} */ (null));

/**
 * Whether writing is on, as a plain boolean STATE rather than a reach into `writeStatus`.
 *
 * ⚠️ `writeStatus` gets a NEW object on every fetch, and `armWrite()` refetches before every arm,
 * so a binding reading `writeStatus.val?.status?.enabled` re-ran on identity even when the answer
 * was unchanged — rebuilding the tile, and its <input>, mid-gesture. A boolean assigned the same
 * value is a no-op in VanJS, so this makes an unchanged refresh cost nothing.
 */
const writesOn = van.state(false);

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
  const type = liveChargeType();
  const live = type !== null;
  chargeType.val = type;
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
    writesOn.val = false;
    for (const listener of sessionEndListeners) {
      listener();
    }
  }
});

/**
 * The charge source right now, or null when there is no settled session to command into.
 *
 * ⚠️ NOT FOR RENDERS — use the `chargeType` state. This subscribes whatever calls it to
 * serverTime (through isStale), which is the churn described on that state. It is the derive's
 * own input, and it is exported only so scripts/check-charge-write-visibility.ts can drive the
 * real staleness logic without a browser; §3 of that check asserts no view imports it.
 *
 * ⚠️ Reads charge_manager_state, NOT charge_type (see the file header).
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

/** Whether writing is switched on for this Pi (SERVICE_WRITE_ENABLED). Reads the boolean state. */
export function writesEnabled() {
  return writesOn.val;
}

/**
 * Records a /vcu-write payload the controls got back from their own POST.
 *
 * Here rather than in each control so `writeStatus` and `writesOn` cannot drift — a view that set
 * only the first would leave the tile rendering off a stale boolean.
 * @param {VcuWriteResponse} payload
 */
export function applyWriteStatus(payload) {
  writeStatus.val = payload;
  writesOn.val = payload.status?.enabled === true;
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
    // The boolean last, and separately: assigning an unchanged boolean is a VanJS no-op, so a
    // refresh that answers the same thing costs no re-render. See `writesOn`.
    writesOn.val = payload.status?.enabled === true;
  } catch (error) {
    // Loud, but not fatal to the read-only screen: a failed status fetch simply leaves the
    // controls hidden (their render requires enabled === true), which is the safe direction.
    console.warn("charge-write: status fetch failed", error);
  }
}
