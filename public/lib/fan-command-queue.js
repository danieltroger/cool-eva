// @ts-check

// The cooling-fan slider's command transport, lifted out of ../views/fan.js because it is
// a state machine rather than a view: nothing here touches van, the DOM or `fetch`. The
// sender is passed in, so scripts/check-fan-endpoint.ts drives it with a recording one and
// the coalescing is asserted rather than read.
//
// ⚠️ What it exists to prevent: `oninput` fires about twenty times a second under a thumb,
// and a Pi Zero 2 W does not want twenty POSTs and forty `pinctrl` spawns out of one
// gesture. The FEEL is not paced — the thumb, the caption and the local duty move on every
// event — only the wire is. docs/fan-control.md §"The slider".

/** @typedef {import("../../src/fan/auto.ts").FanMode} FanMode */

/** One command. The queue holds ONE of either kind: a later mode tap replaces a drag. */
/** @typedef {{ duty: number } | { mode: FanMode }} FanCommand */

/**
 * The shortest gap between two sends.
 *
 * The first move goes at once — `lastSentAt` starts at 0, so the first wait is 0 — and the
 * rest coalesce to the latest value at this rate. Superseded ones are never sent at all.
 */
export const FAN_COMMAND_INTERVAL_MS = 150;

/**
 * @typedef {object} FanCommandQueueOptions
 * @property {(command: FanCommand, isSuperseded: () => boolean) => Promise<void>} send what
 *   actually goes to the Pi. `isSuperseded()` answers, AFTER the await, whether something
 *   newer is already waiting — which is how the caller knows not to adopt a stale reply.
 * @property {(settling: boolean) => void} [onSettlingChange] raised while anything is
 *   queued or in flight, so the page can stop mirroring the Pi's PREVIOUS answer back over
 *   a thumb that has already moved past it.
 * @property {number} [intervalMs]
 */

/**
 * @typedef {object} FanCommandQueue
 * @property {(command: FanCommand) => void} queue
 * @property {() => boolean} isSettling
 */

/**
 * A queue that holds one command in flight and at most one behind it.
 * @param {FanCommandQueueOptions} options
 * @returns {FanCommandQueue}
 */
export function createFanCommandQueue(options) {
  /** @type {QueueState} */
  const state = {
    send: options.send,
    onSettlingChange: options.onSettlingChange ?? (() => {}),
    intervalMs: options.intervalMs ?? FAN_COMMAND_INTERVAL_MS,
    queued: null,
    flushTimer: null,
    inFlight: false,
    lastSentAt: 0,
  };
  return {
    queue: command => queueCommand(state, command),
    isSettling: () => state.queued !== null || state.inFlight,
  };
}

/**
 * @typedef {object} QueueState
 * @property {(command: FanCommand, isSuperseded: () => boolean) => Promise<void>} send
 * @property {(settling: boolean) => void} onSettlingChange
 * @property {number} intervalMs
 * @property {FanCommand | null} queued the next command, OVERWRITTEN rather than appended
 * @property {ReturnType<typeof setTimeout> | null} flushTimer
 * @property {boolean} inFlight
 * @property {number} lastSentAt ⚠️ performance.now(), never Date.now(): this dashboard has
 *   a button on it that STEPS THE CLOCK, and a wall clock that jumps backwards would hold
 *   every later command for the size of the step. Same rule as ./arming.js and
 *   src/monotonic.ts.
 */

/**
 * @param {QueueState} state
 * @param {FanCommand} command
 */
function queueCommand(state, command) {
  state.queued = command;
  state.onSettlingChange(true);
  scheduleFlush(state);
}

/**
 * ⚠️ Refuses to arm a timer while a send is in flight, so no timer can fire mid-request.
 * What re-arms it afterwards is the `finally` in flush(), with `queued` still set — that
 * pair is why a final value can never be lost.
 * @param {QueueState} state
 */
function scheduleFlush(state) {
  if (state.flushTimer !== null || state.inFlight || state.queued === null) {
    return;
  }
  const wait = Math.max(0, state.intervalMs - (performance.now() - state.lastSentAt));
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flush(state);
  }, wait);
}

/**
 * @param {QueueState} state
 * @returns {Promise<void>}
 */
async function flush(state) {
  const command = state.queued;
  if (state.inFlight || command === null) {
    return;
  }
  state.queued = null;
  state.inFlight = true;
  state.lastSentAt = performance.now();
  try {
    await state.send(command, () => state.queued !== null);
  } catch (error) {
    // Reporting a failed command to the rider is the sender's job — ../views/fan.js puts
    // it on the page — so this is only about not letting it out: flush() is called from a
    // timer with `void`, and an escaped rejection would take the rest of the drag with it.
    console.warn("fan: command send failed", error);
  } finally {
    // ⚠️ `finally`, not the end of the `try`: a sender that throws must still clear the
    // flag and re-arm, or one failed POST wedges the slider for the rest of the session.
    state.inFlight = false;
    state.onSettlingChange(state.queued !== null);
  }
  scheduleFlush(state);
}
