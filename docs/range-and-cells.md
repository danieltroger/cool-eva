# Range, Cells and Battery & cooling

Range keeps its existing #hypermile URL. Its 648 px fixed layout includes a 44 px selector, 140 px weakest-cell card, 96 px estimated timer, 112 px allowance pair, 108 px rolling-consumption card, 92 px energy/spread pair and 56 px gaps/padding. Amp readings remain 34.4 px, their configured-ceiling/share captions 16 px and bars 8 px. The weakest-cell value remains 64 px.

Missing, stale and rejected inputs retain their cards and explicit states. Zero current allowance is a real empty allowance; unknown allowance gets a dashed outline without a capacity fill. Derivations require fresh accepted inputs. Fault memory is shared with Ride, Cooling and ordinary tiles. The cut-off timer never says clear when its inputs are unavailable.

Cells is #hypermile/cells, a scrolling URL subview outside the six-stop cycle. Its next gesture selects Charge. The strip and list retain all 81 physical positions in module order; missing or rejected readings cannot shift later cells or retain a plausible coloured bar. Full readings follow the strip and weakest/strongest identities. Battery & cooling is a menu page, reached from Bike information, with the same gesture/automatic exclusions as other menu pages. Browser history retains actual origin for Cells and falls back to Range on a direct entry.

## Preserved findings from the previous Hypermile view

The layout references below describe the retired scrolling Hypermile composition. Its physical distinctions, qualifications and historical failures remain relevant.

The range-maximising screen, built from the BMS's own configuration rather than from SOC. See HYPERMILING.md for the reasoning behind every number here.

The organising fact: the BMS cuts discharge on the _minimum cell voltage_, not on pack voltage and not on SOC. One cell out of 81 ends the ride, and SOC — which comes from coulomb counting against an OCV table never re-characterised for these cells — is the wrong thing to lead with anywhere near empty.

The BMS's configured discharge ceiling, for scaling the limit bar.

Configured regen ceiling: full 120 A between 10 °C and 45 °C.

Millivolts the weakest cell has left above the cut-off — instantaneous, with the sag-compensated figure beneath it.

Both are shown deliberately. The instantaneous number is what the BMS trips on, so it is the authority. The compensated one — measured voltage plus the sag the current draw is causing — is what you actually have left, and is the one that doesn't collapse every time you open the throttle. Neither alone is honest.

A pack resistance is now always available, so the only way here is no current reading at all — say that rather than blaming the resistance.

How much of the BMS's 60-second under-voltage timer has been used.

Without this, a display of raw headroom cries wolf: the weakest cell dips under the floor on any hard pull, and nothing happens unless it _stays_ there for a full minute. Showing the timer turns a frightening flicker into "you have 45 seconds of this left", which is something a rider can act on.

Allowed discharge current against the configured ceiling — "am I being throttled". This falls before the voltage floor is reached, and also for cold, heat and low SOC, which makes it the earlier warning of the two.

Wh/km over the last few km, with the horizon stated so it can't be over-read.

A descent puts energy back in; a dash is what "no reading" looks like, and this is a reading.

Share of the pack's output being burned in its own internal resistance. Rises with the square of current, so it is the most direct feedback there is on riding style — and it is exactly the heat the coolant loop then has to remove.

Everything read inside this binding becomes a dependency of it, so the resistance is sampled with peek() and the colour is computed from peeked values — reading pack_a or pack_kw through valueOf() here would subscribe the redraw to a signal with no deadband and pace it at frame rate, which is exactly what the tick is meant to prevent.

Cell spread — range already paid for that the weakest cell will not let you use.

All 81 cells as one shape. Reading 81 numbers is impossible; spotting the short bar is instant. Only rendered once the per-cell frames are actually arriving.

peek(), not valueOf(): this binding is paced by the tick above, and subscribing it to 81 signals at ~2 Hz each would rebuild the strip continuously.

A cell whose reading was rejected keeps its last good bar, so the strip would otherwise look complete while one of its 81 values is frozen. Say so — the whole premise of this screen is that one cell out of 81 ends the ride.

Scale to the spread rather than to zero, or 81 near-identical cells all draw as full-height bars and the weak one is invisible.

The _scale_ is relative — that is what makes a short bar visible — but the _colour_ is absolute, in millivolts below the strongest cell. Colouring by position within the pack's own spread means a well-balanced pack (a few mV end to end) paints itself orange and red, and a pack whose cells all read identically after the 5 mV deadband paints entirely red. colors.spread() already encodes what a gap worth worrying about actually is.

Regen headroom. It derates at high SOC and at temperature extremes, so a full battery at the top of a mountain means the brakes are doing all the work — worth knowing before the descent rather than during it.
