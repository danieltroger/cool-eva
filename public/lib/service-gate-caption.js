// @ts-check

// The two service-sheet buttons' shared refusal caption.
//
// ⚠️ ONE string for both, because they sit directly under one another on one screen —
// which is this feature's own premise. Two copies meant a reworded refusal on one and
// not the other, visible in a single glance.

/**
 * Why a service-mode control is unavailable, or null when it is not.
 *
 * @param {{ enabled: boolean; gate: { safe: boolean } } | null} state the sheet's
 *   /vcu-read state, which carries the switch and the gate both controls share.
 */
export function serviceRefusal(state) {
  if (state === null) {
    return null;
  }
  if (!state.enabled) {
    return "🔒  Reads are off on this Pi (SERVICE_MODE_ENABLED=0)";
  }
  if (!state.gate.safe) {
    // Deliberately not repeating the reasons: they are in full above the buttons, and a
    // caption is the wrong place for four of them.
    //
    // ⚠️ And deliberately not NAMING one either. Since a charge session excuses the drive
    // being energized, the blocking set depends on whether the bike is plugged in — an
    // unplugged bike can be refused for the drive alone while a charging one cannot — so no
    // five-word summary is right in both branches. "not parked and out of drive" was wrong
    // for the energized case even before that, which is the refusal #190 opened on.
    return "🚫  The bike is not safe to service";
  }
  return null;
}

/**
 * Whether a control should be disabled outright, which is the same question.
 *
 * @param {{ enabled: boolean; gate: { safe: boolean } } | null} state
 */
export function serviceRefused(state) {
  return serviceRefusal(state) !== null;
}
