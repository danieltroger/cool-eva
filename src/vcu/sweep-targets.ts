import { a8FirmwareRows } from "./a8-firmware-rows.ts";
import { parameterTable, type VcuMicro } from "./param-table.ts";

// WHAT one parameter sweep asks about, and in which order. Pure: no bus, no state, no
// clock — ./sweep.ts is what reads them.
//
// Split out of ./sweep.ts when the firmware block took that file past the ~400-line mark.
// The seam is a real one rather than a line count: this answers "which identifiers, on
// which micro, in what order", and nothing here needs the session, the socket or the gate.

/** Both micros, A9 first: 233 of the 302 identifiers live there, so the useful half arrives first. */
export const MICROS: VcuMicro[] = ["A9", "A8"];

/** One thing the sweep will ask about. */
export interface SweepTarget {
  micro: VcuMicro;
  index: number;
  /**
   * ⚠️ True where the WIDTH is a claim rather than a measurement — today exactly the 25
   * rows of ./a8-firmware-rows.ts, and that is the set the OBD poller is parked for.
   *
   * Named for the property every consumer branches on rather than for where the row came
   * from: a second unverified source would leave "from the firmware table" false and the
   * park still right. Why this rather than "the record is wide": docs/vcu-parameters.md §9.
   */
  widthUnverified: boolean;
}

/**
 * Which parameters to read, grouped by micro.
 *
 * Grouped rather than interleaved because A8 and A9 hold SEPARATE sessions: hopping
 * between them would let each one idle out while the other was being read, and pay
 * for a re-open on every single parameter.
 *
 * ⚠️ Exported for scripts/check-a8-block.ts, which has to see that the block is on the list
 * and that the 277 are unchanged. Nothing in the service calls it but this module and
 * ../vcu/read-runner.ts's `expected`, which reads it through the sweep's own handle.
 */
export function sweepTargets(): SweepTarget[] {
  const fromTable = parameterTable().map(parameter => ({
    micro: parameter.micro,
    index: parameter.index,
    widthUnverified: false,
  }));
  const fromFirmware = a8FirmwareRows().map(row => ({
    micro: row.micro,
    index: row.index,
    widthUnverified: true,
  }));
  return [...fromTable, ...fromFirmware].sort(
    (left, right) => MICROS.indexOf(left.micro) - MICROS.indexOf(right.micro) || left.index - right.index
  );
}
