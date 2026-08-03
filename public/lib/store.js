// @ts-check

import van from "../vendor/van-1.6.1.js";
import { isPlausible } from "./bounds.js";
import { ringFor } from "./ring.js";

/** @typedef {import("../../src/can/signals.ts").LiveValue} LiveValue */
/** @typedef {import("../../src/ws.ts").DashboardMessage} DashboardMessage */

// The live signal store: one VanJS state per CAN signal, fed by the WebSocket.
//
// One state per signal, rather than one state holding every signal, is the whole
// reason this is cheap. `pack_a` arrives at 20 Hz; if the store were a single
// object, every binding on the page would re-run twenty times a second. Bound
// per-signal, a pack_a frame touches exactly the text nodes that read pack_a.
//
// The wire types above are imported from the server's own source. The dashboard
// has no build step, so this is a JSDoc-only import — the browser never sees it,
// but `npm run typecheck` does, which is what stops `DashboardMessage` and the
// dashboard drifting apart the way CLAUDE.md warns about.

/** Connection states shown in the header. */
export const connection = van.state(/** @type {"connecting" | "live" | "offline"} */ ("connecting"));

/**
 * A slow pulse that charts and other whole-shape redraws bind to instead of
 * binding to the signals themselves. Hero numbers want to update the instant a
 * frame lands; a 200-point SVG polyline redrawing at 20 Hz would just burn phone
 * battery to animate noise.
 */
export const chartTick = van.state(0);

/** Server clock from the last message, so staleness is judged the same way it is logged. */
export const serverTime = van.state(0);

/** @type {Map<string, import("../vendor/van-1.6.1.js").State<LiveValue | null>>} */
const states = new Map();

/** @type {Map<string, import("../vendor/van-1.6.1.js").State<{ ts: number, value: number } | null>>} */
const faults = new Map();

/** Every key seen this session, for the ALL view. */
export const knownKeys = van.state(/** @type {string[]} */ ([]));

/**
 * Group per key. A plain Map rather than a state, deliberately: a signal's group
 * never changes after it is first seen, and reading it from a state inside a
 * binding would subscribe that binding to the signal. The ALL view groups ~230
 * keys in one binding, so doing that there would re-run the whole grid on every
 * patch — the exact cost the per-signal store above exists to avoid.
 * @type {Map<string, string>}
 */
const groups = new Map();

/** Keys the bike has actually sent, as opposed to states a view happens to have created. */
const seenKeys = new Set();

/**
 * The group a signal belongs to, without subscribing to it.
 * @param {string} key
 */
export function groupOf(key) {
  return groups.get(key) ?? "misc";
}

/**
 * The state holding a signal's latest plausible reading, created on first use.
 * Reading `.val` inside a binding subscribes that binding to this signal alone.
 * @param {string} key
 */
export function signalState(key) {
  let state = states.get(key);
  if (!state) {
    state = van.state(/** @type {LiveValue | null} */ (null));
    states.set(key, state);
  }
  return state;
}

/**
 * The state holding a signal's most recent *rejected* reading, if any — the tile
 * shows this as a fault rather than pretending the sensor is fine.
 * @param {string} key
 */
export function faultState(key) {
  let state = faults.get(key);
  if (!state) {
    state = van.state(/** @type {{ ts: number, value: number } | null} */ (null));
    faults.set(key, state);
  }
  return state;
}

/**
 * Latest numeric value of a signal, or null. Convenience for derived values.
 *
 * Reading this inside a binding subscribes that binding to the signal, which is
 * usually what you want — a readout should update when its number does. When it
 * is not what you want, use peek().
 * @param {string} key
 * @returns {number | null}
 */
export function valueOf(key) {
  const reading = signalState(key).val;
  return reading ? reading.value : null;
}

/**
 * The same value, without subscribing to it.
 *
 * VanJS collects dependencies during a binding by intercepting the `val` getter
 * (`curDeps?._getters?.add(this)`, van-1.6.1.js:36); `rawVal` is a plain property
 * and is not intercepted. So this is the read to use for anything a binding needs
 * to *sample* rather than *react to* — a chart that is paced by chartTick, or the
 * timers in app.js. Using valueOf() in those places silently re-subscribes the
 * binding to a 20 Hz signal and cancels whatever throttle it was meant to have.
 * @param {string} key
 * @returns {number | null}
 */
export function peek(key) {
  const reading = signalState(key).rawVal;
  return reading ? reading.value : null;
}

/**
 * True when a signal has not been refreshed within `maxAgeMs`.
 * @param {string} key
 * @param {number} maxAgeMs
 */
export function isStale(key, maxAgeMs) {
  const reading = signalState(key).val;
  if (!reading) {
    return true;
  }
  return serverTime.val - reading.ts > maxAgeMs;
}

/** Opens the WebSocket and keeps it open. Safe to call once at startup. */
export function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}`);

  socket.onopen = () => {
    connection.val = "live";
  };

  socket.onmessage = event => {
    // Setting this on every message is the fix for the old dashboard's stuck
    // "reconnecting" label: its watchdog could latch the disconnected state and
    // only `onopen` ever cleared it, so one throttled interval in a backgrounded
    // tab left the header lying about a link that was streaming fine.
    connection.val = "live";
    lastMessageAt = Date.now();
    try {
      const message = /** @type {DashboardMessage} */ (JSON.parse(event.data));
      apply(message);
    } catch (error) {
      console.error("ws: could not apply message", error);
    }
  };

  socket.onerror = () => socket.close();

  socket.onclose = () => {
    connection.val = "offline";
    setTimeout(connect, RECONNECT_DELAY_MS);
  };
}

const RECONNECT_DELAY_MS = 2000;

/** The server heartbeats every 5 s, so silence well past that means trouble. */
const SILENCE_LIMIT_MS = 12_000;

let lastMessageAt = 0;

/**
 * @param {DashboardMessage} message
 */
function apply(message) {
  serverTime.val = message.ts;
  let added = false;
  for (const [key, reading] of Object.entries(message.signals)) {
    // Tracked here, and NOT via `states`, because `states` is not a record of what
    // the bike has sent: signalState() is also called while a view is being built
    // (every valueOf() does it), so a key can be in `states` before a single
    // message mentions it. Keying off that would file those signals under "misc"
    // forever and list never-seen keys in the ALL view.
    //
    // Recorded before the plausibility gate below, not after. A signal that only
    // ever produces rejected readings — coolant_in stuck at -242 °C for 59 450
    // rows is the real case — must still count as seen exactly once, or `added`
    // latches true and knownKeys is rebuilt on every message, re-running
    // everything bound to it; and the fault-only branch in views/all.js never gets
    // a key to render.
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      groups.set(key, reading.group);
      signalState(key);
      added = true;
    }
    if (!isPlausible(key, reading.value, reading.unit, reading.group)) {
      faultState(key).val = { ts: reading.ts, value: reading.value };
      continue;
    }
    signalState(key).val = reading;
    ringFor(key).push(reading.ts, reading.value);
  }
  if (added) {
    knownKeys.val = [...seenKeys].sort();
  }
}

// Liveness watchdog. Unlike the old one this only ever *downgrades* on real
// silence — recovery is driven by messages arriving, above — so a throttled timer
// in a background tab cannot leave a false label on screen.
setInterval(() => {
  if (lastMessageAt > 0 && Date.now() - lastMessageAt > SILENCE_LIMIT_MS) {
    connection.val = "offline";
  }
}, 3000);

setInterval(() => {
  chartTick.val = chartTick.val + 1;
}, 500);
