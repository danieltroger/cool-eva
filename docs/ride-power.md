# Ride Edge instrument

The Ride panel has a 176 px envelope with 64 px GPS speed, 34.4 px signed pack power, GPS/wheel context and SOC. The full-width bottom Edge is 18 CSS pixels plus a 2 px upper tick extension. Negative pack power is drive and grows right; positive riding power is regen and grows left. Charging retains its actual signed value with an inactive neutral band.

The fixed axis spans 36 kW regen and 130 kW drive. Zero is width × 36/166 and every kW has the same physical width. The existing POWER_SCALE_KW constant remains the single home of those scales; the legacy vertical-bar arithmetic checks remain as physics/contrast regression checks, while check-ride-power.ts and the real browser acceptance exercise the new Ride path.

A fresh allowance is amps × fresh measured pack volts. Missing, stale or rejected inputs remove only that side's capacity claim and ceiling tick; a 2 px dashed neutral centreline replaces the capacity shading. The opposite fresh limit survives. Genuine zero retains its tick and a completely hatched unavailable side. Exact numbers and state remain in the SVG's accessible description; there is no visible ceiling legend.

Measured power stays truthful over a known ceiling: the excess is bad-ink hatching and the status says Over drive/regen limit. Valid off-scale power retains an end arrow. Rejected readings are faults rather than clamped plausible values. Missing/stale/faulted power removes measured fill while retaining fresh limits.

The zero reference is one 2 px tile-coloured gap through the full 18 px band. It has no foreground stroke. The prototype's extra foreground stroke over only the bottom 7 px caused the bright zero sliver and must not return. A genuine zero allowance may intentionally place its full-height ceiling tick there. Paint order is base, capacity pattern, measured fill/excess, zero gap, then all ceiling halos/ticks. A tick is 2 px foreground with a 1 px tile halo on each side, from y=0 through y=20. Patterns use user-space coordinates anchored to the axis.

Only the band layers receive rounded-corner clipping. The ceiling marks overlay that clip: clipping the whole instrument shortened a full-scale end tick, even though its SVG endpoints still said 0 and 20. The browser checks both the layer order and that the outer tick envelope is unrounded.

Fan and other onDemand readings use the registry-derived ON_DEMAND_KEYS export alongside generated bounds. The shared reading-status helper exempts those keys from age tests while retaining presence, faults and link liveness. A future measured fan sensor is age-gated unless the registry marks it onDemand. All's existing age dimming is deliberately deferred to PR 5.

The browser fixture has fully populated readings, all 81 cells and installed probes, held fan timestamps, and synthetic ten-minute probe history. The no-scroll gate pins Ride and Cooling, checks 47/34 PWA and 0/34 native insets, full internal content and ≥12 px clearance. Ride's target is 13 px. Link-down cases pause all preview deliveries, including attempted heartbeats, so a message cannot silently restore live state during an assertion.
