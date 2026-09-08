// What `scripts/read-freeze-frame.ts` was asked to do, parsed.
//
// Its own module so the usage text the script prints and the instruction the dashboard
// shows a Pi that has never taken a reading can be ONE command line, parsed by a check
// rather than eyeballed — the first version of that instruction named a flag that had
// never existed. `HOW_TO_READ` lives in src/vcu/lifetime-store.ts, which owns the file
// the command produces.
//
// Extraction is also forced, since read-freeze-frame.ts opens a CAN socket at import
// time and nothing may import it — but that alone a main() guard would have fixed.

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
