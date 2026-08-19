// @ts-check

// When the dashboard should have a WebSocket open, and what to do when it should not.
//
// Its own module with no imports, like ./charge-mode.js and for the same two reasons:
// there can only be one answer to "should we be connected right now", and the answer
// has to be checkable without a browser — scripts/check-connection.ts drives every case
// below against a stand-in socket and a fake clock. The `connection` state the header's
// dot binds to lives in ./store.js; this file is what moves it.
//
// ## The behaviour this exists for
//
// The dashboard is handlebar-mounted, so the phone spends much of a ride with the
// screen off or with another app in front of it. iOS suspends this page's JavaScript
// for all of that. What was actually observed on this bike is that the socket SURVIVES
// the suspension — nothing closes — and the messages the Pi sent meanwhile are
// delivered in a burst when the page comes back. The rider unlocks the phone and
// watches roughly thirty seconds of the last few minutes replayed at speed, on tiles
// that look exactly like live telemetry.
//
// The bike's own ride log says why it takes that long. Across its 6.2 M readings a
// patch is 152 bytes and riding produces 120–170 of them per second (p90–p99), so
// 19–27 kB/s; five minutes in a pocket is ~45 000 messages and ~6.8 MB. Each one
// arrives as its own event and re-renders whatever it touches, so the catch-up is
// paced by rendering rather than by how long 6.8 MB takes over wifi — which is what
// makes it tens of seconds rather than one.
//
// So the rule is: **do not hold a socket while the page is hidden.** Closed on the way
// out, opened again on the way back in, and the Pi answers a new connection with one
// full snapshot of current values (ws.ts). The rider gets now, in one round trip,
// instead of a recording of the last five minutes.
//
// ## Why `close` is treated as news rather than as the trigger
//
// Nothing here waits for a close event to decide anything. Two independent things drive
// reconnection — the page becoming visible, and silence past SILENCE_LIMIT_MS — and
// either alone is enough. That is deliberate: a socket can stop carrying data without
// ever firing `close` (a hotspot dropping out mid-ride is the case to have in mind, and
// iOS Safari is documented as reaching the same state with `readyState` still reading
// OPEN), and a reconnect path that only runs from `onclose` would sit there for ever.
// `closed()` below is still honoured — it just makes recovery faster, never possible.
//
// The same rule is applied to `visibilitychange` itself, in both directions, because a
// trigger with no second is a trigger that can be missed:
//
//   hidden   `pagehide` as well, and tick() drops any socket it finds on a hidden page.
//            This is the direction that matters most: a socket nobody told us about is
//            not silent, it is filling up, so the silence watchdog is no help and the
//            header goes on saying "live" over a page that is not reading anything.
//   visible  tick() opens one when it finds a visible page with no socket and no retry
//            queued.
//
// Both are one branch each and the poll they ride on is running anyway.

/** How long to wait after a socket dies before opening the next one. */
export const RECONNECT_DELAY_MS = 2000;

/**
 * A socket that has produced nothing for this long is dead, whatever `readyState` says.
 *
 * ws.ts pushes a full snapshot every 5 s whether or not the bus has anything to say, so
 * this measures the LINK and never a quiet bike: 12 s is two missed heartbeats plus
 * margin, which is why it cannot churn sockets while the bike sits parked and silent.
 * It is also the number charge-mode.js's CONTACTOR_LIVE_MS is pinned to — that comment
 * reads "past this the dashboard has already decided the whole link is down", and it
 * has to keep being true — so moving one moves both.
 */
export const SILENCE_LIMIT_MS = 12_000;

/**
 * How often tick() must be called for the two deadlines above to mean anything.
 *
 * A poll rather than a timer per deadline, so there is exactly one way a reconnect can
 * be scheduled and no way to end up with two of them racing. 1 s costs nothing next to
 * the 2 Hz chart tick the page already runs, and it is the granularity of both
 * deadlines: a retry lands 2.0–3.0 s after a close, and silence is noticed within a
 * second of 12 s. Waking from hidden does not wait for it — see visibilityChanged().
 */
export const POLL_MS = 1000;

/**
 * The sliver of `WebSocket` this module uses. Narrow on purpose: the whole policy is
 * driven by a stand-in in scripts/check-connection.ts, and a wider type would drag the
 * DOM in with it.
 * @typedef {{ close: () => void }} LinkSocket
 */

/**
 * What the header's dot shows.
 * @typedef {"connecting" | "live" | "offline"} LinkStatus
 */

/**
 * What a freshly opened socket reports back. All three take the socket they belong to,
 * because a socket this module has given up on can still deliver events afterwards.
 * @typedef {object} SocketHandlers
 * @property {(socket: LinkSocket) => void} opened the handshake finished
 * @property {(socket: LinkSocket) => void} closed the socket ended
 * @property {(socket: LinkSocket) => boolean} received a message arrived; see socketReceived()
 */

/**
 * Everything this policy does to the world outside it, injected so the whole of it can
 * be replayed with no browser.
 * @typedef {object} ConnectionEffects
 * @property {(handlers: SocketHandlers) => LinkSocket} open opens a socket, handlers attached
 * @property {() => boolean} hidden `document.hidden`
 * @property {() => number} now monotonic milliseconds — durations only, see lib/clock.js
 * @property {(status: LinkStatus) => void} report where the header's dot gets its colour
 */

/**
 * @typedef {object} ConnectionState
 * @property {ConnectionEffects} effects
 * @property {LinkSocket | null} socket the one we are on, if any
 * @property {number | null} lastTrafficAt monotonic mark of the last proof of life
 * @property {number | null} retryAt monotonic deadline for the next attempt
 */

/**
 * @typedef {object} Connection
 * @property {() => void} start first connection, at page load
 * @property {() => void} visibilityChanged `document.hidden` flipped either way
 * @property {() => void} pageHidden the page is going away — `pagehide`
 * @property {() => void} tick call every POLL_MS
 */

/**
 * The connection policy, wired to a set of effects.
 *
 * State is a plain object passed to module-level helpers rather than closed over, per
 * CLAUDE.md — it is also what lets the check inspect a step at a time.
 * @param {ConnectionEffects} effects
 * @returns {Connection}
 */
export function createConnection(effects) {
  /** @type {ConnectionState} */
  const state = { effects, socket: null, lastTrafficAt: null, retryAt: null };
  return {
    start: () => openNow(state),
    visibilityChanged: () => visibilityChanged(state),
    pageHidden: () => abandon(state),
    tick: () => tick(state),
  };
}

/**
 * Hidden means drop it; visible means pick it straight back up.
 * @param {ConnectionState} state
 */
function visibilityChanged(state) {
  if (state.effects.hidden()) {
    // The last thing this page gets to run before iOS suspends it. Closing here is
    // what stops the Pi from having anywhere to queue the next few minutes of patches,
    // and therefore what stops the fast-forward on the way back.
    abandon(state);
    return;
  }
  // No RECONNECT_DELAY_MS in front of this one: the rider is looking at the screen
  // right now, and the socket was not lost to a failure worth backing off from — we
  // closed it ourselves, on purpose.
  openNow(state);
}

/**
 * Opens a socket, if one should be open and none is.
 * @param {ConnectionState} state
 */
function openNow(state) {
  state.retryAt = null;
  if (state.effects.hidden()) {
    // Nothing opened now could be read, and it would spend the whole of the hidden
    // period accumulating exactly the backlog this module exists to avoid.
    // visibilityChanged() reconnects at the moment there is somebody to reconnect for.
    state.effects.report("offline");
    return;
  }
  if (state.socket) {
    // Already connecting or connected, so this is a no-op. It is also the whole of the
    // anti-stampede guard: unlock, lock, unlock in quick succession comes straight
    // through here, and every wake has to cost at most one socket.
    return;
  }
  let socket;
  try {
    socket = state.effects.open(handlersFor(state));
  } catch (error) {
    // The `WebSocket` constructor refusing the URL outright — mixed content, or a
    // SecurityError on a page not allowed to open it. Loud, because this is a thing
    // that "cannot happen" and therefore has to shout when it does, and then back onto
    // the backoff: left to escape, this would be one uncaught error per POLL_MS for
    // ever, retrying ten times faster than every other failure path.
    console.error("connection: could not open a socket", error);
    state.effects.report("offline");
    scheduleRetry(state);
    return;
  }
  state.socket = socket;
  // The attempt itself starts the silence budget. Without a mark here, a server that
  // accepts the connection and then says nothing would never trip tick()'s watchdog,
  // because there would be nothing to measure from.
  state.lastTrafficAt = state.effects.now();
  state.effects.report("connecting");
}

/**
 * Gives up on the current socket: closes it, says so, and lines up the next attempt.
 * @param {ConnectionState} state
 */
function abandon(state) {
  const dying = state.socket;
  state.socket = null;
  state.lastTrafficAt = null;
  state.retryAt = null;
  state.effects.report("offline");
  if (dying) {
    // This may or may not produce a close event — a socket the OS tore down under a
    // suspended page is exactly the case where it does not. Which is why the retry is
    // scheduled here and not from closed().
    dying.close();
  }
  scheduleRetry(state);
}

/**
 * @param {ConnectionState} state
 */
function scheduleRetry(state) {
  if (state.effects.hidden()) {
    // Nobody is looking, and on iOS no timer would run to do it anyway. Becoming
    // visible is the wakeup.
    state.retryAt = null;
    return;
  }
  state.retryAt = state.effects.now() + RECONNECT_DELAY_MS;
}

/**
 * Drives both deadlines. Call every POLL_MS.
 * @param {ConnectionState} state
 */
function tick(state) {
  const now = state.effects.now();
  if (state.effects.hidden()) {
    // Hidden, with a socket still open: a `visibilitychange` that never announced the
    // page going away. This is the more important of the two recoveries and the one
    // with no other net under it — the silence watchdog below cannot help, because a
    // socket in this state is not silent, it is busily filling up with the backlog
    // that the page will replay the moment it comes back. Nothing else would notice:
    // messages keep arriving, so the header goes on reading "live" over values nobody
    // is looking at.
    if (state.socket !== null) {
      abandon(state);
    }
    // And whether or not there was one to drop, nothing may be queued to open another
    // while nobody is looking — the invariant that `retryAt` is only ever set on a
    // visible page.
    state.retryAt = null;
    return;
  }
  if (state.retryAt !== null && now >= state.retryAt) {
    openNow(state);
    return;
  }
  if (state.socket === null && state.retryAt === null) {
    // Visible, nothing open, and nothing queued to open one. The only way to arrive
    // here is a visibilitychange that never came — and closing the socket on hide is
    // what made this page eligible for Safari's back/forward cache, which is exactly
    // where a visibility transition is least dependable.
    //
    // The same argument the header makes about `close` applies to `visibilitychange`:
    // a recovery path with one trigger is a recovery path that can be missed. That is
    // why both directions of it have a second one — this branch and the one above.
    openNow(state);
    return;
  }
  if (state.socket !== null && state.lastTrafficAt !== null && now - state.lastTrafficAt > SILENCE_LIMIT_MS) {
    // OPEN, and carrying nothing. The heartbeat in ws.ts means this cannot be a quiet
    // bus, so the socket is dead however healthy it claims to be — a hotspot dropping
    // out reaches this state with no visibility change to announce it.
    abandon(state);
  }
}

/**
 * @param {ConnectionState} state
 * @returns {SocketHandlers}
 */
function handlersFor(state) {
  return {
    opened: socket => socketOpened(state, socket),
    closed: socket => socketClosed(state, socket),
    received: socket => socketReceived(state, socket),
  };
}

/**
 * @param {ConnectionState} state
 * @param {LinkSocket} socket
 */
function socketOpened(state, socket) {
  if (socket !== state.socket) {
    // One we had already given up on, finishing its handshake afterwards. iOS delivers
    // a suspended page's queued events when it resumes, so events out of order with
    // the decisions taken about them is the normal case here, not a theoretical one.
    socket.close();
    return;
  }
  // Still "connecting". The handshake only proves the Pi accepted the socket; ws.ts
  // sends the snapshot the instant it does, and "live" is claimed when that ARRIVES —
  // see socketReceived(). The gap is a round trip on wifi and rather more over a
  // hotspot in a garage, and for all of it every value on screen is from before the
  // gap. isStale() in store.js greys them for exactly as long as this says the link is
  // not live, so the claim has to wait for data rather than for a handshake.
  state.lastTrafficAt = state.effects.now();
}

/**
 * @param {ConnectionState} state
 * @param {LinkSocket} socket
 */
function socketClosed(state, socket) {
  if (socket !== state.socket) {
    // A socket we had already abandoned, reporting in. Acting on it would take down
    // the healthy replacement and schedule a second reconnect on top of the running
    // one — which is how a wake-lock-lock-wake sequence ends up with several sockets.
    return;
  }
  abandon(state);
}

/**
 * A message arrived. Answers whether it is still wanted.
 *
 * `false` means it came from a socket we have given up on, and the caller must DROP it
 * rather than apply it. That is not bookkeeping: those are precisely the queued
 * messages that produce the fast-forward — closing a socket does not guarantee the
 * frames already in flight are never delivered — so applying them would replay the very
 * backlog abandoning the socket was meant to discard.
 *
 * @param {ConnectionState} state
 * @param {LinkSocket} socket
 */
function socketReceived(state, socket) {
  if (socket !== state.socket) {
    return false;
  }
  state.lastTrafficAt = state.effects.now();
  // Reported on every message, not only on the first. This is the fix for the old
  // dashboard's stuck "reconnecting" label: its watchdog could latch the disconnected
  // state and only the equivalent of `onopen` ever cleared it, so one throttled
  // interval in a backgrounded tab left the header lying about a link that was
  // streaming fine.
  state.effects.report("live");
  return true;
}
