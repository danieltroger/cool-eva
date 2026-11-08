# Ride power instrument

The approved Ride hero is 224 px high with 64 px GPS speed, 32 px unsigned power, and 20 px SOC. Its 24 px power bar sits inside the padded card, between the numerals and the GPS/wheel footer. The axis stays fixed at 36 kW regen left and 130 kW drive right. Negative `pack_kw` grows right in drive blue; positive riding power grows left in regen green. The unchanged pure state/display helpers retain zero, direction, allowance, freshness and over-limit semantics.

The band is 12 px high at y=6 within the 24 px SVG. Its ends are rounded and clipped independently of the ceiling ticks. A known locked stretch is a 2 px dashed line over the track, using `--sub` ink and a `4 4` pattern. The palette gate measures that actual ink against its track at a 3:1 floor. Unknown limits have no invented ceiling tick and retain a dashed neutral side. Fresh zero is a real limit. Measured excess remains red and the existing one-line status reports it; off-scale readings keep their full number while the finite bar ends at its fixed axis.

Zero has short reference marks above and below the band. Fresh allowance ticks extend from y=3 through y=21. They paint after the band and remain outside its rounded clip. There is no diagonal hatch, full-height zero gap, edge attachment, or visible ceiling legend in the approved instrument.

While charging, Ride keeps speed and GPS/wheel context; power direction, magnitude, bar and SOC are hidden, as in the approved charging-state sketch. The hidden band retains its space. The Charge area owns those readings during that state. Hardware and thermal allocation are described in [ride-thermal.md](ride-thermal.md).

## Earlier instrument findings

The text below records the previous Edge and vertical designs. Their geometry and texture policy are historical, rather than requirements for the approved inset bar. In particular, the old diagonal texture used coverage `(3 × √2) / 8`, with duty-weighted contrast floors of 1.25 against tile and 1.15 against solid track. Those measurements cannot verify the new dashed line; its actual ink/ground pair is checked instead.

The Ride panel has a 176 px envelope with 64 px GPS speed, 34.4 px unsigned power magnitude, GPS/wheel context and SOC. The full-width bottom Edge is 18 CSS pixels plus a 2 px upper tick extension. Negative pack power is drive and grows right; positive riding power is regen and grows left. Direction is explicit: DRIVE or REGEN with confirmed motion, POWER IN for incoming power while parked or motion is unconfirmed, CHARGING for confirmed incoming charge, POWER OUT for outgoing power while parked or charging, and POWER for displayed zero. POWER IN uses the same green as REGEN, including small values. The internal signed reading still drives the unchanged Edge; a charging band stays inactive and neutral.

The fixed axis spans 36 kW regen and 130 kW drive. Zero is width × 36/166 and every kW has the same physical width. POWER_SCALE_KW and limitKw in power-limits.js are the single home of the scale and allowance arithmetic. check-ride-power.ts and the real browser acceptance exercise the instrument; the retired vertical renderer and its check have been deleted.

A fresh allowance is amps × fresh measured pack volts. Missing, stale or rejected inputs remove only that side's capacity claim and ceiling tick; a 2 px dashed neutral centreline replaces the capacity shading. The opposite fresh limit survives. Genuine zero retains its tick and a completely hatched unavailable side. Exact numbers and state remain in the SVG's accessible description; there is no visible ceiling legend.

Measured power stays truthful over a known ceiling: the excess is bad-ink hatching and the status says Over drive/regen limit. Valid off-scale power retains an end arrow. Rejected readings are faults rather than clamped plausible values. Missing/stale/faulted power removes measured fill while retaining fresh limits.

The zero reference is one 2 px tile-coloured gap through the full 18 px band. It has no foreground stroke. The prototype's extra foreground stroke over only the bottom 7 px caused the bright zero sliver and must not return. A genuine zero allowance may intentionally place its full-height ceiling tick there. Paint order is base, capacity pattern, measured fill/excess, zero gap, then all ceiling halos/ticks. A tick is 2 px foreground with a 1 px tile halo on each side, from y=0 through y=20. Patterns use user-space coordinates anchored to the axis.

Only the band layers receive rounded-corner clipping. The ceiling marks overlay that clip: clipping the whole instrument shortened a full-scale end tick, even though its SVG endpoints still said 0 and 20. The browser checks both the layer order and that the outer tick envelope is unrounded.

Fan and other onDemand readings use the registry-derived ON_DEMAND_KEYS export alongside generated bounds. The shared reading-status helper exempts those keys from age tests while retaining presence, faults and link liveness. A future measured fan sensor is age-gated unless the registry marks it onDemand. All's existing age dimming is deliberately deferred to PR 5.

The browser fixture has fully populated readings, all 81 cells and installed probes, held fan timestamps, and synthetic ten-minute probe history. The no-scroll gate pins Ride and Cooling, checks 47/34 PWA and 0/34 native insets, full internal content and ≥12 px clearance. Ride's target is 13 px. Link-down cases pause all preview deliveries, including attempted heartbeats, so a message cannot silently restore live state during an assertion.

## Allowance provenance and historical colour failures

The allowances are BMS pack-side limits (`allowed_discharge_a` and `allowed_regen_a`, 0x202 at 10 Hz), not the inverter's current limits. They derate for heat, cold and low SOC before a voltage floor is reached. Multiplying by measured pack voltage puts both on the same axis as pack_kw. Sag belongs in the displayed ceiling: nominal volts would hide the loss of reachable power under load. These measurements and the fixed 400 A × 325 V / 120 A × 300 V scale rationale are preserved in dashboard-decisions.md's historical power-meter section.

Zero amps is a real limit, including a complete derate. Missing or nonpositive pack voltage cannot establish a ceiling. Riding limits are inactive while charging: the BMS zeroed both limits in 6293 of 6296 archived DC-session samples while pack power reached +24 kW. That is a charging state, not evidence of exceeding a riding allowance. ridePowerState keeps this decision outside the pure limitKw arithmetic.

The following colour rationale was moved from colors.js when the old check was retired. Its vertical-meter wording is historical; the sign convention and fixed-direction colour still apply to the Edge.

Power flow: regen green because energy is coming back, drive its own blue at any load.

⚠️ `pack_kw` is NEGATIVE under discharge and POSITIVE on regen and charge — the convention derive.js asserts by name rather than leaving in a minus sign. The comparison here was `< -0.5` from 2026-08-03 (#33) until 2026-09-08, which is the same test with the bike's sign convention read backwards: it painted a 100 kW pull green and a 20 kW recovery amber. Nothing catches that by looking — both colours are plausible on their own. scripts/check-ride-power.ts asserts the direction.

Drive used to ramp CALM → WATCH → WARN → BAD by magnitude, and that ramp is gone rather than retuned. Two reasons, and the second is the real one:

- Contrast. The meter marks the BMS's ceiling ON TOP of the fill, and over the old BAD red that mark sat at 1.72:1 — the one state where crossing into unreachable power matters most. One flat colour per direction needs no second colour to be legible against, and scripts/check-theme-contrast.ts holds both fills to a floor.
- The ramp answered a worse question. Its thresholds were absolute — 3, 15, 40 kW — while the hatching beside it answers "how close am I to what the pack will actually give me", which moves with heat, cold and SOC and is the number a rider can act on. Two colour languages for load, one of them fixed and wrong most of the time, is worse than one.

## Historical texture contrast rationale

These measurements describe the retired vertical strip. The Edge retains the floors and uses its actual hatch duty for the same weighting. The two texture contrasts answer different questions.

⚠️ The meter has no second colour for a derate: the taken stretch is --track itself, dashed, with the tile showing through the gaps. So there is no dash-ink-against-track ratio to measure — the dash and the track are one colour — and what a rider actually sees over a dashed run is the two averaged by the dash's duty cycle. Both numbers below are that average: against the ground the meter sits on, which is how visible a derate is at all, and against the solid track, which is what says the stretch is gone.

RATCHETS under the shipped worst cases: 1.290 against the ground, which is the LIGHT theme, and 1.177 against the solid track, which is the DARK one — the two worsts are not in the same palette, which is why both floors are measured in both. They are small numbers and that is the honest picture: this design carries the derate as a texture rather than as a step in tone, a trade docs/dashboard-decisions.md §"The power meter" states in full.

⚠️ What they guard is HATCH_DUTY as much as the palette — the duty cycle is imported from the module that draws it, so shortening the dashes or widening the gaps moves both of these numbers and has to clear them here.

The retired bar check’s fill contrast floor of 4:1 against the track and blue/green a*b* separation floor of 90 now live in check-theme-contrast.ts, measuring the actual Edge palette. Its direction assertions live in check-ride-power.ts. No floor was lowered.

## Direction words and magnitude

The rider-facing number is unsigned, using the existing precision. Its heading and accessible description carry the direction. Incoming power is green at every nonzero displayed magnitude, including 0.2 kW; outgoing power is blue. A value rounded to 0.0 is POWER in foreground ink, with no negative zero. Fault placeholders and wording use bad ink; missing/stale values use sub ink. This is local to Ride in PR 2: Charge follows in PR 4 and All remains raw/signed until its explicit raw label in PR 5.

DRIVE requires a fresh positive wheel/OBD speed (GPS fallback). When stationary or motion is unavailable, outgoing power says POWER OUT. Confirmed charging always takes priority over motion for the label, and a negative reading is never labelled CHARGING. Signed readings remain intact in the store and all physical calculations.

## Retired track-token note

The unfilled part of every bar and ring, and the power meter's own grey, was sized by visibility rather than readability. It was the one mark not held to the 6:1 floor, but `MARK_FLOORS` in `scripts/check-theme-contrast.ts` held it to its own visibility floor after 2026-09-08: walking `--track` towards `--tile` had previously passed every check while making the meter invisible. It also set the old derate's legibility because the limited stretch was that same grey dashed against tile. Raising it strengthened the texture and weakened the fill edge. At 1.53:1 against tile, the drive fill still cleared its 4:1 floor at 4.44:1.
