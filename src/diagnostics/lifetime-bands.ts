// The physical ranges the lifetime statistics are gated against — this path's
// equivalent of public/lib/bounds.js, and separate from ./lifetime-stats.ts for the
// same reason bounds.js is separate from the tiles it gates: deciding what a real
// reading can be is a different job from deciding how to show one.
//
// ⚠️ IT EXISTS BECAUSE A FREEZE FRAME CARRIES SENTINELS TOO. bounds.js gates the
// broadcast signals and never sees these bytes; component 53's captured reply is
// `FF FF FF FF`, and a cell spread computed from a 0xFFFF is a plausible-looking
// number made of a dead reading.

/** Physical ranges, so a sentinel is shown as a fault rather than clamped into something plausible. */
export const BANDS: Record<string, readonly [number, number]> = {
  // The band public/lib/bounds.js gates the live cell voltages with, quoted rather
  // than re-invented: a freeze frame carries 0xFFFF too — component 53's reply is
  // FF FF FF FF — and this path does not go through bounds.js.
  cell_avg_mv: [1500, 4500],
  cell_min_mv: [1500, 4500],
  cell_max_mv: [1500, 4500],
  cell_min_id: [0, 200],
  cell_max_id: [0, 200],
  state_of_health: [0, 100],
  state_of_charge: [0, 100],
  odometer_km: [0, 999_999],
  average_battery_temp_c: [-40, 80],
};

/** Whether a scaled value sits inside its physical band. True when there is no band for the key. */
export function withinBand(key: string, value: number | null): boolean {
  const band = BANDS[key];
  if (!band) {
    return true;
  }
  return value !== null && value >= band[0] && value <= band[1];
}
