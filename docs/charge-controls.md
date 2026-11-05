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

## AC ceilings and operation results

An AC command ceiling is a command-encoding constraint, not the observed DC temperature allowance. The AC landing shows the committed AC setpoint and the battery's granted charger-output current and voltage. Controls names those scopes separately. Unknown, stale or rejected values remain explicit.

The earlier control's warning sentences remain relevant: “DC ceiling has not arrived — this means CAN is not being received.” For AC without an observed ceiling, “using the default ceiling; the bike may ignore the command and settle near 10 A — check charge_limit_a.” The current AC control labels that fallback “(default — may be ignored)”; Bike replied now provides the vehicle-side confirmation instead of asking the rider to infer it from delivered pack current. The fallback does not establish that a command worked.

A refused attempt names its requested amperage and says it was NOT sent; the draft stays available for retry. Any older success acknowledgement is suppressed beneath refused or uncertain attempts. The retained last request and vehicle reply share a freshness boundary, so a link dropout marks both stale and suppresses the old acknowledgement together. Session-end clearing remains in the shared charge-write machinery.

The original ceiling/default warnings, preserved with their substitutions and conditions:

```js
function Situation() {
  return div({ class: "action-note" }, () => {
    const type = chargeType.val;
    if (type === null) {
      // charge_manager_state briefly out of a settled AC/DC value (a pause or handshake step) —
      // the tile stays; the button waits for it. A real unplug clears sessionLive and hides this.
      return div({ style: `color:${MUTED}` }, "Charge state changing — hold on.");
    }
    const ceiling = liveCeiling(type);
    if (ceiling === null) {
      // Only DC reaches here now — AC falls back to a default ceiling (see liveCeiling).
      return div(
        { style: `color:${WARN}` },
        "⚠️ DC ceiling (fast_dc_limit_max_a) has not arrived — this means CAN is not being received."
      );
    }
    if (ceilingIsFallback(type)) {
      return div(
        { style: `color:${WATCH}` },
        `Live AC charge · using the default ceiling ${ceiling} A (the dial has not been nudged this session, so the dash has broadcast no ceiling). Whole amps, 1…${ceiling}. `,
        "If this charger's rating differs from " +
          `${ceiling} A the bike may ignore the command and settle near 10 A — check charge_limit_a on the dash after sending.`
      );
    }
    return div(
      { style: `color:${MUTED}` },
      `Live ${type.toUpperCase()} charge · ceiling ${ceiling} A. Whole amps, 1…${ceiling}. `,
      "The Pi picks AC/DC and the ceiling from the live bus — this echoes them."
    );
  });
}
```

## Refused versus uncertain transmission

A null /vcu-write result alone cannot prove that no frame left: sendChargeCommand can fail after its first frame, and the runner returns that failure through the same HTTP null-result shape. The charge-current POST therefore adds an optional chargeCurrentAttempt field: not-sent only for pre-send refusals, unknown after a sender failure or an exception during the action. A missing field from an older service also stays uncertain. This changes outcome metadata only; frame bytes, sequencing, gates and confirmation rules are unchanged. The frontend never derives a NOT sent claim from prose or null alone.
