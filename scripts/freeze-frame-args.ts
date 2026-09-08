// What `scripts/read-freeze-frame.ts` was asked to do, parsed.
//
// Its own module for one reason: that script opens a CAN socket at import time, so
// nothing may import it — and the usage text it prints is also the instruction the
// dashboard shows on a Pi that has never taken a reading
// (src/http/lifetime-stats.ts). Two copies of a command line drift, and the copy that
// drifts is the one nobody runs. Here they are one thing, and scripts/check-lifetime-stats.ts
// parses the dashboard's string to prove it.

/** What one run was asked to do. Closed, so an unrecognised flag is refused rather than defaulted. */
export type FreezeFrameJob =
  | { kind: "list" }
  | { kind: "freeze-frame"; component: number }
  | { kind: "lifetime"; save: boolean }
  | { kind: "log"; maxBlocks: number | null };

/** The job these arguments name, or null when they name none. Pure. */
export function parseFreezeFrameArguments(args: string[]): FreezeFrameJob | null {
  if (args.includes("--list")) {
    return { kind: "list" };
  }
  if (args.includes("--lifetime")) {
    return { kind: "lifetime", save: args.includes("--save") };
  }
  const componentIndex = args.indexOf("--component");
  if (componentIndex !== -1) {
    const component = Number(args[componentIndex + 1]);
    if (!Number.isInteger(component)) {
      return null;
    }
    // The range check lives in the encoder and throws there; this only catches a
    // missing argument, so a typo cannot become "component NaN".
    return { kind: "freeze-frame", component };
  }
  if (args.includes("--log")) {
    const maxIndex = args.indexOf("--max");
    if (maxIndex === -1) {
      return { kind: "log", maxBlocks: null };
    }
    const maxBlocks = Number(args[maxIndex + 1]);
    return Number.isInteger(maxBlocks) && maxBlocks > 0 ? { kind: "log", maxBlocks } : null;
  }
  return null;
}
