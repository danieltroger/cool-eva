// One thing at a time on the bike's bus.
//
// ── Why this is its own module now ───────────────────────────────────────────
// Until 2026-08-16 single-flight lived inside ./read-runner.ts as two nullable
// fields, `sweep` and `probe`, and one `if` per entry point. That worked while both
// entry points were in the same file. Writes are not: they have their own runner,
// their own session and their own file, and a fourth `if` in a fifth place is how
// two of them eventually both think the bus is free.
//
// It matters more here than the usual mutex argument suggests, because of what
// sharing the bus would actually do. The VCU micros answer on ONE CAN id with no
// request/response tag to match on (src/vcu/param-codec.ts), so two requests in
// flight are resolved by whichever frame lands first — not by which one asked. A
// sweep's parameter read could be answered by a write's SecurityAccess seed, and the
// seed's four bytes would be interpreted as a calibration value. Nothing would throw.
//
// ── Deliberately not a queue ─────────────────────────────────────────────────
// A refusal that says who has the bus is the right answer for every caller here: the
// page shows "a parameter read is already running" and the owner decides. A queue
// would mean a write firing minutes later, on a bike the safety gate was happy about
// when the button was pressed and may not be now.

/**
 * The lease in force, or null.
 *
 * An OBJECT rather than the name string, so `release` can compare identity. Two
 * sweeps started a minute apart are both called "a parameter read", and comparing
 * names would let the first one's late release free the second one's lease.
 */
let holder: { name: string } | null = null;

/** A held lease. Releasing twice is safe, which is what a `finally` on a retried path does. */
export interface BusLease {
  release: () => void;
}

/**
 * Takes the bus, or says who has it.
 *
 * `name` is shown to a person, so it is a phrase and not an identifier: "a parameter
 * read", "a probe", "a parameter write".
 */
export function acquireBus(name: string): { ok: true; lease: BusLease } | { ok: false; heldBy: string } {
  if (holder !== null) {
    return { ok: false, heldBy: holder.name };
  }
  const mine = { name };
  holder = mine;
  return {
    ok: true,
    lease: {
      release: () => {
        // Only clears the lease if it is still OURS. Without this, a release arriving
        // late — from a promise that settled after its own `finally` already ran —
        // would free a lease somebody else had since taken, and the next two callers
        // would both be told the bus was idle.
        if (holder === mine) {
          holder = null;
        }
      },
    },
  };
}

/** Who has the bus right now, or null. For showing a reason, not for deciding. */
export function busHeldBy(): string | null {
  return holder?.name ?? null;
}
