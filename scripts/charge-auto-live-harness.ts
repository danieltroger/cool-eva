import { CHARGE_AUTO_REASON, MIN_COMMAND_A, type ChargeAutoReason } from "../src/charge/auto-curve.ts";
import { CHARGE_AUTO_REASON_TEXT, type ChargeAutoResponse } from "../src/http/charge-auto.ts";
import type { ChargeAutoMode } from "../src/charge/auto.ts";
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

/** The controller as the stubbed Pi holds it. Mutated by a section to step it the way `runTick` does. */
export const pi = {
  mode: "automatic" as ChargeAutoMode,
  reason: CHARGE_AUTO_REASON.NO_HISTORY as ChargeAutoReason,
  commandedAmps: null as number | null,
};

/** charge_manager_state (0x610 b7): 0x23 a settled DC session, 0x02 AC, 0x00 nothing plugged in. */
export const DC_SESSION = 0x23;
export const AC_SESSION = 0x02;
export const NO_SESSION = 0x00;

/**
 * The two round trips of one controller tick, in wall-clock milliseconds.
 *
 * ⚠️ Real durations, not `monotonicNow()` arithmetic — nothing here MEASURES an elapsed time, it
 * only asks the stub to wait, which is what lands two replies in the order the out-of-order section
 * is about. `COMMAND_MS` is the 3-10 ms the bike takes to answer a `0x120`, rounded up; the hold is
 * comfortably over the ~45 ms of skew the race needs, so the run is not a coin toss on a busy laptop.
 */
export const COMMAND_MS = 30;
export const SLOW_REPLY_MS = 150;

/** Whether GET /vcu-write reports writes on for this Pi. */
let writesAreOn = true;

/** Milliseconds to hold the NEXT /charge-auto reply for, so two can be landed out of order. */
let holdNextReplyMs = 0;

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
    const hold = holdNextReplyMs;
    holdNextReplyMs = 0;
    if (hold > 0) {
      await pause(hold);
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

/** Holds the next /charge-auto reply, so a later read can overtake it. */
export function holdNextReply(ms: number): void {
  holdNextReplyMs = ms;
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
 */
export function settle(ms = 0): Promise<void> {
  return pause(ms);
}

/** A plain timer. Named so `settle()` reads as intent and the stub's holds read as duration. */
export function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
