# Charge control constraints

Presentation changes keep the shared arming, dwell, request paths, endpoint results and session permissions. Current request/reply precede the draft. The overview has one compact Stop action and a short explicit outcome; its complete unchanged result is on Controls. Long operation results wrap on that parked subview rather than clipping the riding overview.

## Preserved implementation findings

### charge-current.js

```text
// Command the charge current live, from the charge tab. The one control on the dashboard
// that changes the bike outside the service-mode sheet — so it carries most of the sheet's
// safety model with it: it POSTs through the gated /vcu-write endpoint (SERVICE_WRITE_ENABLED,
// the audit journal), it needs two taps separated by the shared dwell, and it renders NOTHING
// unless the Pi says writing is on AND a charge is live. A phone that has not been told writes
// are enabled sees an ordinary read-only charge screen.
//
// ⚠️ It does NOT use the stationary service gate (moving / energized / in-drive). A charging
// bike is energized and tethered by definition, so that gate misfits a charging operation and
// would flap with the trickle; the appropriate precondition is "a charge is live", which is what
// gates this. The Pi exempts charge-current from that gate for the same reason (write-runner.ts).
//
// ⚠️ Nothing here decides the opcode or the ceiling — the Pi reads charge_manager_state live and
// echoes the dash's own ceiling (docs/can-0x121-charge-command.md). The AC/DC label and the
// ceiling shown here are read off the SAME live signals so the button says what the Pi will
// do, but where they and the server disagree the server wins and its reason is shown.

```

### charge-auto.js

```text
// ONE invariant: the pair below is the answer currently ON SCREEN, and whenever this cannot act it
// forgets it. So the Pi's phrasing is re-read when the reason moves, when the commanded current
// moves, and when the gate reopens over a pair we deliberately forgot. The controller records
// `charge_auto_reason` every tick and `charge_auto_target_a` on every command that lands.
//
// ⚠️ GUARDED on the VALUES, not on the states changing. ws.ts heartbeats a FULL SNAPSHOT every 5 s
// and store.js assigns a freshly parsed object, so these signals' identity changes every heartbeat
// whether or not the numbers moved — an unguarded derive is then a 0.2 Hz poll of an HTTP endpoint,
// exactly what the comment here used to claim it was not. charge-write.js guards the same way.
//
// ⚠️ Both signals are read BEFORE the gate returns, and the pair is never CONSUMED on a run that
// did not refresh — forgotten instead. Both traps, and the bug each one produces:
// docs/dashboard-decisions.md § "A guarded derive, and the three ways to lose the change". (The
// gate's own `||` short-circuits, so a run with no DC session never reads `writesEnabled()`. That
// is trap #1's letter, and it is harmless only because the half that short-circuits also hides the
// tile: either way there is nothing to refresh for.)

```

### charge-auto.js

```text
/**
 * What the one button says, what it POSTs, and the sentence under it.
 *
 * ⚠️ THREE states, not two, and the third is the reason this exists. While stood down the effective
 * mode is still `automatic`, so a plain on/off toggle read "Switch off for this charge" — the
 * opposite of what the rider wanted — and taking the controller back meant tapping OFF and then ON,
 * two taps through a label that says the wrong thing. `mode=automatic` already clears the stand-down
 * in src/charge/auto.ts, so this is one tap; only the wording was missing.
 *
 * Pure — the floor arrives as an argument rather than being read off the module state, so the label
 * binding gains no dependency it does not need and the check asserts the sentence a rider actually
 * sees. Exported so scripts/check-charge-auto.ts can drive all three states without a browser.
 * @param {"automatic" | "off"} currentMode
 * @param {number | null} reason
 * @param {number} floor_a
 * @returns {{ label: string, mode: "automatic" | "off", note: string }}
 */
```
