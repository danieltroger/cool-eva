// @ts-check

import van from "../vendor/van-1.6.1.js";
import { isPlausible } from "./bounds.js";
import { ringFor } from "./ring.js";
import { monotonicNow } from "./clock.js";
import { POLL_MS, createConnection } from "./connection.js";

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
//
// WHEN there is a socket at all is not decided here: ./connection.js owns that, and
// connect() below is the wiring it acts through. The two meet again at isStale(),
// which will not call any reading current while that module says the link is not.

/**
 * Connection states shown in the header, and — through isStale() below — the licence
 * every reading on the page has to be shown as current. ./connection.js is what moves
 * it; nothing else may.
 */
export const connection = van.state(/** @type {import("./connection.js").LinkStatus} */ ("connecting"));

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
 * The server's clock from the last message, without subscribing to it. apply()
 * writes serverTime on every message, so reading `.val` inside a binding paces that
 * binding at the WebSocket's full rate.
 * @returns {number}
 */
export function peekServerTime() {
  return serverTime.rawVal;
}

/**
 * True when a signal has not been refreshed within `maxAgeMs`. A signal that has
 * never arrived counts as stale, which is what makes freshness usable as evidence
 * about the bike — see chargeMode() in charge-mode.js.
 * @param {string} key
 * @param {number} maxAgeMs
 */
export function isStale(key, maxAgeMs) {
  return isStaleWith(signalState(key).val, serverTime.val, maxAgeMs, connection.val === "live");
}

/**
 * The same, sampled rather than subscribed. See peek() and peekServerTime(): the
 * tick-paced work in app.js must not subscribe to serverTime, which apply() writes
 * on every message including 20 Hz pack_a patches.
 * @param {string} key
 * @param {number} maxAgeMs
 */
export function isStaleSampled(key, maxAgeMs) {
  return isStaleWith(signalState(key).rawVal, peekServerTime(), maxAgeMs, connection.rawVal === "live");
}

/**
 * Parameterised on how it read, so the subscribing and sampling variants above
 * cannot drift apart — the same reason headroomMvWith() in derive.js exists.
 *
 * ⚠️ `linkIsLive` is part of freshness, not a shortcut: `now` is the server clock from
 * the LAST MESSAGE and it stops when the messages do, so the age comparison alone
 * freezes when the link goes away and leaves every tile at full brightness over values
 * from before the dropout. While the link is not live nothing on the page is current,
 * and the status is also what PACES the bindings — docs/dashboard-decisions.md
 * §"The link, staleness and charge mode".
 * @param {{ ts: number } | null} reading
 * @param {number} now server clock, so both sides of the comparison are the Pi's
 * @param {number} maxAgeMs
 * @param {boolean} linkIsLive whether messages are arriving at all
 */
function isStaleWith(reading, now, maxAgeMs, linkIsLive) {
  if (!reading) {
    return true;
  }
  if (!linkIsLive) {
    return true;
  }
  return now - reading.ts > maxAgeMs;
}

/**
 * Starts the dashboard: the WebSocket, and the two timers the page runs on. Call once,
 * at startup.
 *
 * The browser end of ./connection.js — when a socket should exist is decided there, and
 * everything here is the wiring that carries out the decision. The timers live in here
 * rather than at module scope so importing this file has no side effects, which is what
 * lets scripts/check-connection.ts hold the real isStale() up against the real
 * connection policy without a browser and without leaving intervals running.
 */
export function connect() {
  const link = createConnection({
    hidden: () => document.hidden,
    now: monotonicNow,
    report: status => {
      connection.val = status;
    },
    open: handlers => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}`);
      socket.onopen = () => handlers.opened(socket);
      socket.onmessage = event => {
        if (!handlers.received(socket)) {
          // From a socket we have already given up on. Dropped rather than applied:
          // these are the messages that queued up while the page was suspended, and
          // applying them is precisely the fast-forward we are here to stop.
          return;
        }
        try {
          const message = /** @type {DashboardMessage} */ (JSON.parse(event.data));
          apply(message);
        } catch (error) {
          console.error("ws: could not apply message", error);
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => handlers.closed(socket);
      return socket;
    },
  });

  // The hook the whole fix hangs on. iOS runs this before it suspends the page, and it
  // is the last chance to close the socket the Pi would otherwise spend the next few
  // minutes queueing patches into.
  document.addEventListener("visibilitychange", () => link.visibilityChanged());
  // And its second, for the case where that one does not arrive. `pagehide` fires on
  // the way into the back/forward cache and on the way out of the document altogether —
  // both of which stop this page reading its socket — and it fires in cases where
  // `document.hidden` is still false, which is why it is its own entry point rather
  // than another call to visibilityChanged(). A hash change does not unload the
  // document, so the tab bar cannot trigger it.
  window.addEventListener("pagehide", () => link.pageHidden());
  setInterval(() => link.tick(), POLL_MS);
  link.start();

  setInterval(() => {
    chartTick.val = chartTick.val + 1;
  }, CHART_TICK_MS);
}

/** How often charts and other whole-shape redraws are allowed to repaint. */
const CHART_TICK_MS = 500;

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
    // Monotonic base, placed at the moment the reading was TAKEN rather than at the
    // moment it arrived. `message.ts - reading.ts` is server-vs-server arithmetic, so
    // no cross-clock comparison is involved.
    //
    // This also restores a dedupe that stamping on arrival silently lost, because ws.ts
    // heartbeats a FULL snapshot every 5 s: a repeated reading gets the same sample time
    // every heartbeat, so MIN_INTERVAL_MS drops it and a signal that has stopped
    // arriving ends its trace instead of drawing a flat line forever. The clamp at 0 is
    // only for a backwards clock step. See docs/dashboard-decisions.md §`seenKeys`.
    const serverAgeMs = Math.max(0, message.ts - reading.ts);
    ringFor(key).push(monotonicNow() - serverAgeMs, reading.value);
  }
  if (added) {
    knownKeys.val = [...seenKeys].sort();
  }
}

// The liveness watchdog that used to live here now lives in ./connection.js, because
// noticing that nothing has arrived for twelve seconds and doing nothing about the
// socket was only ever half the job: it relabelled the header and left a link nobody
// believed in open. It now tears that socket down and opens the next one, and the
// label is a consequence rather than the whole response.
