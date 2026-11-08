# Charge page

The approved Charge tab is one scrolling page with no top switch or Controls/Pack subviews. Its DC reading stack contains delivery/SOC, time to the saved limit, the temperature ceiling plot and Stop. Saved SOC limit, current request and automatic reduction follow on the same page. Idle keeps the saved-limit card. Current/Stop retain live-session/write permission and arm/confirm gates; automatic reduction keeps its existing permission toggle. Both retired Charge URLs canonicalise to `#charge`.

Cards use the shared page/stack/row/card primitives and approved tokens: 12 px page/card padding, 12 px stack gaps, 8 px card gaps, 32 px values, 16 px units/inputs, 14 px labels/status and 12 px chart labels. Delivery is at least 112 px and ETA at least 80 px. A chart's viewBox is 342×132; it scales inside the shared card padding. Controls stay on the page below the fold, with the bottom navigation fixed throughout.

Delivery uses fresh accepted signed power before formatting its magnitude. Negative power says Power out, measured zero says Power, and unavailable/fault readings never retain a charging number. Electrical context is pack current/voltage, explicitly labelled Battery during AC. SOC keeps its own quality gate.

Time to saved limit uses the existing smoothed-power/energy model and SOC freshness budget, rendered as a duration rather than a wall-clock arrival. A saved positive target is required; an unread/removed target, rejected or stale inputs, no incoming power, very low power or a reached target shows Unavailable. A 100% target remains a lower bound, qualified as not before. The estimator is unchanged; [charge-eta.md](charge-eta.md) retains its qualifications.

The DC curve keeps the exact seven observed points and 75 A cap intersections. The approved window uses outside-minus-10 through reported-high-plus-10, includes the nearest knee and at least 25 degrees, within −30…65°C. Missing inputs use the reference 20…65°C frame, extended left when an available valid cold marker would otherwise be cropped. Off-curve reports never become a clamped allowance. Physical battery readings do not gate the separate reported-temperature model. Both reported extremes retain circle/diamond markers and degree labels; coincident extremes use the same coordinate with a larger circle and one both label. Unknown reports draw a reference curve, with no invented ceiling. Numeric fault/stale states remain explicit. Chart bindings sample inputs with `peek()`/sampled status through the chart pulse.

## AC quantities

The approved AC card shows the committed AC setpoint (`charge_limit_a`) and observed dash ceiling (`ac_charge_ceiling_a`) in mains amperes, then the BMS charger-output grant (`charger_max_dc_a`) in pack amperes. The earlier assertion below that all AC values were charger-output values is superseded. `src/can/decode.ts` decodes CHG.PWR.REF as the AC dial setpoint; `src/can/charge-manager.ts` and [charge-manager.md](charge-manager.md#b1-cm_ac_max_curr--the-ac-ceiling) record that it is bounded by the supply-side AC limit. `src/can/charge-setpoint.ts` decodes the dash's AC command-ceiling byte. `src/can/decode-bms.ts` decodes the separate BMS charger-output current/voltage grant. These source blocks were opened for this change; no decoder or wire format changed.

An absent dash ceiling stays unavailable/stale in the reading. The write path retains its existing server-matched 15 A fallback; that fallback is not displayed as a measured ceiling. The AC input follows the sketch's 6 A minimum, and DC keeps 1 A, each bounded by the existing live command ceiling. AC has no automatic-reduction card or DC temperature allowance.

## Superseded layout and preserved findings

The text below describes the retired three-view composition. Its allocation, geometry, five-degree rounding/30-degree framing and AC output-side claim are historical. Protocol, model and negative findings remain preserved for investigation.

The Charge overview uses 648 px at the approved real safe areas. Pack & cooling and Controls are URL subviews outside the handlebar cycle. The graph uses only fresh accepted reported temperatures for allowance, physical temperatures for framing, the exact seven observed points, exact 75 A cap intersections and a fixed 0–75 A axis. The model caveat appears once. Configuration cannot invent a reported temperature.

Power direction is decided before magnitude formatting. POWER OUT requires an accepted negative reading; CHARGING requires both accepted positive power and charge evidence. Zero is neutral POWER. Missing, stale and rejected power cannot retain a charging number.

Controls retain the existing request/arming/permission machinery. The last request and actual bike verdict are distinct from the editable draft. Stop remains on the overview; complete operation results remain accessible through Controls.

The saved SOC limit is event data: its own protocol document records that it arrives only on read/change, with no periodic rebroadcast. Its registry onDemand flag now expresses that existing behavior, and generated frontend metadata applies the same presence/fault/live-link policy as other held events. The charge group still has periodic signals; no command or decoder changes. Physical SIGNAL_BOUNDS remain unchanged. Both commanded amps and the retained SOC setting use 60-second-old last-change timestamps in the complete Charge fixture.

## AC limits

An established AC session replaces the DC graph with an equally sized AC limits card. It names the committed AC setpoint (charge_limit_a), battery-granted charger current (charger_max_dc_a) and battery-granted charger voltage (charger_max_dc_v), all on the charger-output/battery side. Missing values say unavailable; stale or rejected values retain their status. These are not mains-current readings and do not promise delivery. Controls uses the same scopes and never presents the observed DC curve as an AC allowance.

## Preserved findings from the previous Charge composition

These source comments record constraints and observations from the retired layout. The thermal-knee description is superseded by the exact observed curve and reported-temperature markers above; its old clamp-boundary claim must not be reused. Historical prose is preserved verbatim here for investigation.

```text
// The charging screen.
//
// ⚠️ There IS a time-to-target estimate now (./charge-eta.js), and the objection this comment
// used to raise still stands where it applies: a straight-line extrapolation of the pack's taper
// is worthless at the top. That is why the tile gives a point estimate only up to target 99 and a
// LOWER BOUND at 100, which is the one place the taper measurably bites. docs/charge-eta.md.
//
// Verified against a real 48-minute AC session captured 2026-08-02 18:55→19:43
// (`0x201` byte 0 held `02` = Charge for 18 400 frames, with `0x305`/`0x306`
// arriving throughout).
```

```text
// Which tiles even exist depends on where the charge is coming from. On DC the
    // charger frames are silent, so the AC-sourced tiles below would sit there
    // showing the last values of a session that ended — which is what made this
    // screen useless at a fast charger. See lib/charge-mode.js.
    //
    // "charging" takes the pack-side set for the same reason DC does, and not because
    // it is thought to be DC: the AC tiles are made entirely of charger frames, so
    // when those are not arriving there is nothing honest to put in them.
```

**Historical policy before Daniel’s 2026-11-06 ruling:** the preserved block below describes the former SOC stationary gate. Controls now reads automatically on entry; SOC read/Set are allowed in drive, while Set requires an answered pre-read and retains permission, header/JSON, lease and confirmation. See [the current protocol policy](dash-command-0x2c-charge-limit.md#gating).

```text
// Render nothing unless this Pi has writes enabled — on an ordinary phone these are invisible
    // and Charge stays read-only. The first three also need a LIVE charge; the SOC limit does not
    // (a stored setting, gated on the bike-state gate) and shows its value on any phone.
    // The three write controls share the session/status machinery in ../lib/charge-write.js; the ETA
    // tile is read-only and shares none of it.
```

```text
/**
 * The one answer this whole screen is built on, held as a state so the DOM binding
 * above only fires when it actually flips.
 *
 * isStale() reads serverTime, which apply() writes on EVERY message including 20 Hz
 * pack_a patches — so binding the subgrid straight to chargeMode() would tear down
 * and rebuild four tiles at frame rate, sparklines included, defeating the chartTick
 * pacing they exist to have. Assigning an unchanged value to a VanJS state is a
 * no-op, so this derive absorbs the churn: it still re-runs per message, but that is
 * a handful of Map lookups rather than four tiles and an SVG.
 */
```

```text
/**
 * Charge is a tab, so this screen is reachable mid-ride. Without this the DC branch
 * would render "Charging at 41 kW" from pack_kw with its discharge sign stripped by
 * Math.abs() — confidently wrong, and not caught by staleness because pack_kw is
 * perfectly live while riding. The old AC-only tiles failed safe only by accident,
 * their signals being silent off the charger.
 */
```

```text
/**
 * AC: the charger tells you what it is doing, so show it.
 */
```

```text
/**
 * Nothing on the charger side is talking, but the pack is — and what the pack is
 * taking is the charge, measured closer to the thing you care about than the
 * charger's own claim would be anyway.
 *
 * Named for where the numbers come from rather than for DC, because it serves the
 * unidentified case too: a charge the BMS reports while no charger frames arrive is
 * not necessarily a fast charge, and only the caption is entitled to guess.
 */
```

```text
/** State of charge as a ring, with the power going in written through it. */
```

```text
// Direction, not just magnitude. Math.abs() alone said "0.1 kW in" on a parked
        // bike whose pack was feeding the housekeeping loads — the same wrong-way-round
        // reading as the label below it, from the same missing sign. Exactly zero gets
        // no direction rather than a made-up one.
```

```text
/**
 * Where the charge is coming from, plus whichever phase of it the BMS says it is in.
 * The state bits matter here: trickle and maintenance both look like "charging" but
 * mean the interesting part is over.
 */
```

```text
// deliveryMode itself, not a second derivation of the same question. This line used
  // to work out AC-vs-DC on its own and never asked whether anything was charging at
  // all, so a parked bike read "DC charging" — "not AC" being the only test it made —
  // directly above the card below correctly reporting the pack as DELIVERING 0.1 kW.
  // Reading the state the tiles switch on makes that disagreement unrepresentable.
```

```text
// A source is named only when the bus has shown it: "DC" needs the contactor bit,
  // "AC" needs the charger's own frames. Otherwise the word is simply left out —
  // guessing which one it must be is the whole mistake being corrected here, and it
  // is no more excusable in this direction than it was in the other.
```

```text
/**
 * Which phase of a charge the BMS is reporting, or null for an ordinary one.
 *
 * Charge-complete is not among them and has no branch anywhere on this screen: it
 * would need `0x201` byte 0 to hold 0x20, and across ~24 M frames that byte has taken
 * exactly three values — 0x01, 0x02 and 0x10. The label it used to have ("AC ·
 * complete") could therefore never render, and a dead branch that looks like it
 * distinguishes a finished charge from one that never started is worse than not
 * drawing the distinction: it reads as though the case were covered.
 * @returns {string | null}
 */
```

```text
/** What the BMS is granting the charger, against what the charger is doing. */
```

```text
/**
 * Balancing is only visible while charging, and it is the one time the pack's
 * worst problem is being actively fixed — so the spread trend belongs here more
 * than anywhere else.
 */
```

```text
// The spread is max − min, so the two voltages it is made of belong on the
      // same tile rather than in one of their own: while charging, how full the
      // cells actually are matters as much as how far apart they are.
```

```text
/**
 * How close the pack is to the temperature where DC charging is throttled — the number
 * that decides how long you stand at the charger.
 *
 * The knee is exact rather than fitted: the pack reports a flat 35 °C to the VCU and
 * only starts telling the truth at 55 °C, at which point the VCU throttles. ⚠️ Which is
 * why the tile counts down against the TRUE temperature (batt_temp_hi, off 0x660) and
 * not the clamped one, which would show no approach at all.
 * See docs/dashboard-decisions.md §"The derate knee".
 */
```

```text
/** Bottom of the bar. Below this the pack is nowhere near derating. */
```

```text
/**
 * Hand-built tiles get no staleness for free, which is the fault this PR calls out
 * in BMS grants — so these two do not get to repeat it. A tile whose inputs have all
 * gone quiet is dimmed rather than left presenting the last number at full
 * brightness, and keys that have never arrived do not count as stale.
 * @param {string[]} keys
 */
```

```text
// Degrees remaining below the knee — a temperature difference, so tempDelta.
```

```text
/**
 * Heat going into the pack against heat the loop is taking out.
 *
 * The two halves are not equally solid and the caption says so. Heat in is I²R, with
 * R measured live where the current is varying enough to fit one and modelled off pack
 * temperature otherwise — the tile says which. Heat out is ṁ·cp·ΔT with ṁ assumed from
 * the pump's rating — the ΔT is measured, the flow is not. Together they still answer the question the loop was
 * built to answer, which no single number does: is it keeping up.
 */
```

```text
// Both halves have their own inputs; the tile is only old when nothing feeding
      // either of them is current.
```

```text
/**
 * The pack, module by module.
 *
 * Temperature first: during a fast charge heat is what limits the charge, so the
 * question is which module is running hot, and the 81-cell voltage strip cannot
 * answer it. Voltage is a tap away for when balance is the question instead.
 */
```

```text
/**
 * Rows are modules, columns are that module's battery and two board sensors.
 *
 * The count is `of 31` rather than a bare tally because two of the 33 positions are not
 * sensors: modules 6 and 8 have BattTemp1Enabled=False and never report one. The
 * caption names them, and the grid marks them, so a gap by design cannot be read as a
 * probe worth going and wiggling.
 */
```

```text
// peek, not valueOf: this redraw is paced by chartTick above.
```

```text
/** Rows are modules, columns are the cells in them; colour is millivolts below the best. */
```

```text
// Indexed by cell number, not appended: a missing cell has to leave a hole rather
  // than shift every later cell in its module one column left, or the grid stops
  // meaning what the position says — which is the whole reason for drawing a grid.
  // Not hypothetical here: 0x663/0x664 have been observed never sampling modules 1
  // and 2, and a 0xFFFF rejected by bounds.js does the same thing, which is exactly
  // when you want to see the gap.
```

```text
// Absolute millivolts below the best cell, matching the strip on the
      // hypermiling screen — a relative scale paints a healthy pack red.
```

```text
/**
 * Isolation resistance. Only ever interesting while plugged in, and then very:
 * a collapsing value with the bike connected to mains is the one fault on this
 * screen worth stopping for.
 */
```
