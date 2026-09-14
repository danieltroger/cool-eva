import { onChange } from "../can/signals.ts";
import { monotonicNow } from "../monotonic.ts";
import { flushEncryptedLog } from "./encrypted-log.ts";

// Seal the ride log when the bike parks, because parking is the only warning this bus gives.
//
// docs/power-cuts.md §4.1 names the largest remaining loss: up to 30 s of readings still in
// the segment buffer when the power goes. `sync(1)` cannot reach them — those bytes were
// never written, and sync flushes writes, not intentions. Sealing is what converts them.
//
// Measured over the 80 boot-terminal captures in the archive: entering state 60 precedes the
// last frame of the boot by 10.03-442.11 s (16 observed entries, median 64.39), and never by
// less than 10 s, against a seal that costs milliseconds. Why key_on is NOT the trigger, and
// what this does NOT cover, are in docs/power-cuts.md §7.

/** `V_VEHICLE_STATE` = parked, on 0x101 b1. docs/can-0x101.md. */
const PARKED_STATE = 60;

/**
 * How often a park may seal. A ride enters and leaves parked a few times an hour, and a seal
 * is cheap, so this is not a budget — it is a stop on a signal that chatters if the decode is
 * ever wrong about what 60 means. Monotonic, because this process steps its own wall clock.
 */
export const MIN_MS_BETWEEN_PARK_SEALS = 5_000;

/**
 * Starts sealing the ride log whenever the bike enters the parked state. Returns a function
 * that stops it.
 *
 * `readMonotonic` is a parameter for the same reason `clockTrust` is one on the log itself:
 * it lets scripts/check-ride-log-clock.ts drive the rate limit without sitting out five real
 * seconds per case, which is the difference between the constant having coverage and having
 * none. It is never anything but monotonicNow() in the service.
 */
export function startSealOnPark(readMonotonic: () => number = monotonicNow): () => void {
  let lastState: number | undefined;
  let lastSealAt: number | undefined;
  return onChange(changed => {
    const state = changed.vehicle_state_can?.value;
    if (state === undefined) {
      return;
    }
    const previous = lastState;
    lastState = state;
    // An OBSERVED transition, never the first sample: liveState starts empty, so the first
    // 0x101 frame after a boot reports whatever the bike is already doing. Treating that as
    // an entry would seal an empty buffer at every start — and it is the same contamination
    // that put 12 already-parked captures into the measurement behind this file.
    if (previous === undefined || previous === PARKED_STATE || state !== PARKED_STATE) {
      return;
    }
    if (lastSealAt !== undefined && readMonotonic() - lastSealAt < MIN_MS_BETWEEN_PARK_SEALS) {
      return;
    }
    lastSealAt = readMonotonic();
    // ⚠️ `void` with its own catch, not an async listener. notifyChange's try/catch in
    // ../can/signals.ts is synchronous-only — it runs inside queueMicrotask, and its own
    // comment says an escaped throw there is an uncaughtException that ends the process,
    // taking the CAN logging and the WebSocket with it. A rejected promise walks straight
    // past that guard.
    void flushEncryptedLog().catch(error => {
      console.warn("ride-log: the park seal failed; the 30 s timer still has the buffer —", error);
    });
  });
}
