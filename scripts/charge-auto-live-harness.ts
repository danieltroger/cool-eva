import { CHARGE_AUTO_REASON, MIN_COMMAND_A, type ChargeAutoReason } from "../src/charge/auto-curve.ts";
import { CHARGE_AUTO_REASON_TEXT, type ChargeAutoResponse } from "../src/http/charge-auto.ts";
import type { ChargeAutoMode } from "../src/charge/auto.ts";
import { CHARGE_MANAGER_STATE_AC, CHARGE_MANAGER_STATE_DC } from "../src/vcu/charge-session.ts";
import { SIGNALS } from "../src/can/registry.ts";
import type { LiveValue } from "../src/can/signals.ts";
import { HEARTBEAT_MS, type DashboardMessage } from "../src/ws.ts";

// A Pi and a browser for the charge tab's automatic-current tile, with neither present.
//
// The wiring half of scripts/check-charge-auto-live.ts, lifted out when that file reached the
// ~400-line split line — the same shape as charge-auto-plant.ts and charge-auto-episode.ts beside
// check-charge-auto.ts. This module fakes; the check asserts.
//
// ⚠️ THE IMPORT ORDER IS THE WHOLE REASON THIS IS A MODULE AND NOT A FUNCTION. `fetch` must be
// stood in for BEFORE public/views/charge-auto.js is evaluated, or its own module-level derive and
// public/lib/charge-write.js's would reach for a relative URL that is not a URL outside a browser.
// An importer's body runs after everything it imports, so installing the stub here and re-exporting
// the browser's own functions below makes that ordering structural rather than a comment.
//
// ⚠️ NO DOM. van.tags needs a document, so the tile is never rendered; controllerSentence() is the
// text its binding puts on screen, and asserting that asserts what a rider reads.

/** The controller as the stubbed Pi holds it. A section steps `reason` and `commandedAmps` as `runTick` would. */
export const pi = {
  mode: "automatic" as ChargeAutoMode,
  reason: CHARGE_AUTO_REASON.NO_HISTORY as ChargeAutoReason,
  commandedAmps: null as number | null,
};

// charge_manager_state (0x610 b7). The two settled values are the Pi's own constants rather than a
// fifth hand-typed copy of a reverse-engineered byte; only "nothing plugged in" is local, because
// no rule anywhere keys on it — it is just a value that is neither AC nor DC.
export const DC_SESSION = CHARGE_MANAGER_STATE_DC;
export const AC_SESSION = CHARGE_MANAGER_STATE_AC;
export const NO_SESSION = 0x00;

/** Whether GET /vcu-write reports writes on for this Pi. */
let writesAreOn = true;

/**
 * Held open while a reply is parked, so the next read can overtake it.
 *
 * ⚠️ A promise the check RESOLVES, not a timer it outruns. Ordering two replies by sleeping longer
 * than the other one is a wall-clock bet, and `run-checks.ts` runs on whatever CI box it lands on;
 * this makes "the stale reply arrives last" a fact of the run rather than a race it usually wins.
 */
let parkedReply: Promise<void> | null = null;

/** Makes the NEXT /charge-auto read fail the way a dropped packet does. */
let failNextRead = false;

/** Every path the page has asked for, in order. */
const fetched: string[] = [];

/** The bus as the page has been told it, so a heartbeat can re-send all of it the way ws.ts does. */
const bus: Record<string, number> = {};

/** The server clock the messages carry. Advanced explicitly, so every age in a run is deliberate. */
let serverClockMs = 1_000;

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input), "http://eva.local/").pathname;
  fetched.push(path);
  if (path === "/vcu-write") {
    return new Response(JSON.stringify({ status: { enabled: writesAreOn } }));
  }
  if (path === "/charge-auto") {
    if (failNextRead) {
      failNextRead = false;
      throw new TypeError("Failed to fetch");
    }
    // The body src/http/charge-auto.ts's respond() would build for this state. The sentence comes
    // from the Pi's own table rather than being written again here, which is the whole reason it
    // travels on the wire — see CHARGE_AUTO_REASON_TEXT's header.
    //
    // ⚠️ Serialised BEFORE the hold, not after: the Pi answers from the state it holds when the
    // request arrives. A stub that read `pi` after the delay would make every late reply fresh,
    // which is exactly the property the out-of-order section exists to disprove.
    const body: ChargeAutoResponse = {
      state: { mode: pi.mode, reason: pi.reason, commandedAmps: pi.commandedAmps },
      reasonText: CHARGE_AUTO_REASON_TEXT[pi.reason] ?? "",
      floorAmps: MIN_COMMAND_A,
      message: null,
    };
    const serialised = JSON.stringify(body);
    const parked = parkedReply;
    parkedReply = null;
    if (parked) {
      await parked;
    }
    return new Response(serialised);
  }
  throw new Error(`the charge tab asked for ${path}, which this harness does not stand in for`);
}) as typeof fetch;

const { apply, connection } = await import("../public/lib/store.js");
export const { applyWriteStatus, fetchChargeWriteStatus } = await import("../public/lib/charge-write.js");
export const { controllerSentence } = await import("../public/views/charge-auto.js");

connection.val = "live";

/** Switches this Pi's write gate, the way a phone that never enabled writes sees it. */
export function setWritesOn(on: boolean): void {
  writesAreOn = on;
}

/** Parks the next /charge-auto reply. Returns the function that delivers it. */
export function parkNextReply(): () => void {
  let release = () => {};
  parkedReply = new Promise(resolve => {
    release = resolve;
  });
  return release;
}

/** Fails the next /charge-auto read outright. */
export function failNextChargeAutoRead(): void {
  failNextRead = true;
}

/** How many times the page has fetched a path this run. */
export function countOf(path: string): number {
  return fetched.filter(seen => seen === path).length;
}

/**
 * One WebSocket patch, exactly as src/ws.ts sends a change batch.
 *
 * The unit and group come from the registry rather than being written here, because
 * public/lib/bounds.js gates on all three and a hand-typed group is how a check ends up asserting
 * against a reading the real page would have rejected as a dead sensor.
 */
export function patch(signals: Record<string, number>): void {
  serverClockMs += 100;
  apply(messageOf("patch", signals));
}

/** The 5 s full snapshot — every signal again, unchanged, with the fresh identity that churns. */
export function heartbeat(): void {
  serverClockMs += HEARTBEAT_MS;
  apply(messageOf("snapshot", bus));
}

/**
 * Lets the store's derive, the view's fetch and its `apply()` all run.
 *
 * A macrotask, because the chain is several microtask hops deep: VanJS flushes with
 * queueMicrotask, refresh() awaits the response and awaits its .json(), and only then assigns.
 * Zero milliseconds is enough for every one of them — nothing in this harness sleeps to win a race.
 */
export function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function messageOf(type: "patch" | "snapshot", signals: Record<string, number>): DashboardMessage {
  const readings: Record<string, LiveValue> = {};
  for (const [key, value] of Object.entries(signals)) {
    const definition = SIGNALS.find(signal => signal.key === key);
    if (!definition) {
      throw new Error(`${key} is not in src/can/registry.ts — the bike cannot broadcast it and neither may this`);
    }
    bus[key] = value;
    readings[key] = { value, unit: definition.unit, group: definition.group, ts: serverClockMs };
  }
  return { type, ts: serverClockMs, signals: readings };
}
