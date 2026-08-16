// Complains when a transport's GPS decoder keeps having to withhold positions.
//
// ./decode.ts is pure and cannot log for itself, so this is where the counters it keeps
// turn into words. Both transports need it — CAN 0x410 in ../can/gps.ts and BLE in
// ../ble/protocol.ts each own a GpsMessageDecoder — so it lives here rather than in
// either of them, and each gets its own watcher because each has its own counts.
//
// What it is watching for: the hub sending time sub-frames while one of the two
// coordinate sub-frames has stopped. Since 2026-08-16 the decoder refuses to build a
// fix out of one fresh axis and one stale one, which is right, but on its own it turns
// a talkative failure into a silent one — the position simply stops appearing. That is
// the condition worth a line in the journal.

import type { GpsMessageDecoder } from "./decode.ts";

/**
 * How much of a stream may be withheld before it is worth mentioning. A ratio rather
 * than a count, because a count cannot tell "a hub sending half a position" from "a
 * long healthy ride that had a few start-up cycles": a hub emitting two time sub-frames
 * per coordinate cycle shows up here as 50 % immediately and stays there, while
 * start-up transients are a handful against thousands.
 */
const SUPPRESSED_FRACTION_TO_COMPLAIN = 0.2;

/** Don't judge a stream on its first few cycles, which are legitimately half-assembled. */
const MINIMUM_SAMPLE = 40;

/**
 * Watches one decoder. Call `check()` after each decode; it says nothing almost always.
 *
 * Backs off geometrically — 1st, 2nd, 4th, 8th … complaint — because this condition is
 * a property of the hardware, not an event: once it is true it stays true for the rest
 * of the ride, and a fixed interval would be a warning every few seconds for an hour.
 * The first two land immediately so it is never merely inferred from silence.
 */
export class SuppressedFixWatcher {
  // Plain fields assigned in the body, NOT constructor parameter properties. Node runs
  // this repo's TypeScript under --experimental-strip-types, which only erases
  // annotations and cannot synthesise the assignment a parameter property implies; it
  // refuses the file outright with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. `tsc --noEmit`
  // accepts them, so the type checker will not catch this for you — `npm test` will.
  #decoder: GpsMessageDecoder;
  #transport: string;
  #complaints = 0;
  #nextComplaintAt = 1;

  constructor(decoder: GpsMessageDecoder, transport: string) {
    this.#decoder = decoder;
    this.#transport = transport;
  }

  check(): void {
    const total = this.#decoder.suppressedFixes + this.#decoder.emittedFixes;
    if (total < MINIMUM_SAMPLE) {
      return;
    }
    const fraction = this.#decoder.suppressedFixes / total;
    if (fraction < SUPPRESSED_FRACTION_TO_COMPLAIN) {
      return;
    }
    this.#complaints += 1;
    if (this.#complaints < this.#nextComplaintAt) {
      return;
    }
    this.#nextComplaintAt *= 2;
    console.warn(
      `gps(${this.#transport}): ${(fraction * 100).toFixed(0)} % of fixes withheld ` +
        `(${this.#decoder.suppressedFixes} of ${total}) — the hub is sending time but not both coordinate ` +
        "sub-frames, so position is being withheld rather than blended from a stale half"
    );
  }
}
