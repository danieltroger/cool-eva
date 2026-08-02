import { latestValue, record } from "./signals.ts";
import type { DecodedValue } from "./decode.ts";

// Signals computed from values that arrive in *different* frames. They can't live in
// decode.ts, where a decoder sees one frame's bytes and nothing else — that purity is
// what makes the decoders testable by replaying captured frames.
//
// Fed whatever a frame just decoded (after those values have been recorded), so each
// derived signal is recomputed only when one of its own inputs actually moved.

export function recordDerivedSignals(decoded: DecodedValue[]): void {
  const cutoffInputChanged = decoded.some(({ key }) => key === "cell_min_mv" || key === "cell_cutoff_mv");
  if (cutoffInputChanged) {
    recordCellCutoffHeadroom();
  }
}

// How many mV the weakest cell still has above the discharge cut-off the BMS is
// actually configured with — 0x203 b4-5 against 0x665 b0-1 — so "how close am I to
// cutting out" reads the threshold off the bike instead of hardcoding 2900 mV.
//
// Not a cliff edge: DischargeModeUnderVoltageCutOffTimer is 60 s, so the minimum cell
// has to stay under the threshold for a full minute before the BMS opens the
// contactors. And allowed_discharge_a (0x202) starts falling before the voltage limit
// is reached at all, which makes it the earlier warning of the two.
function recordCellCutoffHeadroom(): void {
  const cellMinMv = latestValue("cell_min_mv");
  const cutoffMv = latestValue("cell_cutoff_mv");
  // 0x665 only exists once the extended BMS config is flashed. Until it shows up
  // there is no threshold to measure against, so the signal simply never appears —
  // guessing a cut-off would be worse than having no tile.
  if (cellMinMv === undefined || cutoffMv === undefined) return;
  record("cell_cutoff_headroom_mv", cellMinMv - cutoffMv);
}
