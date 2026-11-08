# Ride thermal readings

The approved allocation is battery low/high on Ride, followed by coolant ΔT and resistance heat / loop removal. Motor/OBD, individual coolant probes and outside air have one home on Cooling. Ride's battery row is 72 px, ΔT card 160 px and heat card 112 px. Normal captions are the sketch's short labels; derivations and qualifications live here.

`public/lib/ride-thermal.js` keeps independent validity for both estimates. Outlet minus inlet is available only with enabled probes and two fresh, accepted readings. I²R uses accepted pack current and the existing resistance estimate. Probe failure does not blank independent resistance heat. Missing, stale and fault states remain explicit and never acquire numeric units.

The ΔT trace still joins probes by time over ten minutes. Its 48 px plot always includes a visible labelled zero line, including for negative and flat traces. Axis scaling includes zero and preserves the trace's sign. Timed chart bindings use `peek()` and sampled status/resistance/settings, rather than subscribing to sensor frame rates. Temperature differences convert to Fahrenheit by scale only.

The 8 px heat meter shows resistance heat divided by loop removal, capped only at the finite meter's end. Numeric readings retain their actual values. If positive heat meets zero or negative removal the meter is full; if neither estimate can establish a comparison the fill is absent. Removal lower than heat uses fault ink. Loop removal is ΔT times the existing rated-flow constant; it is an estimate, not a measured flow rate. Resistance remains the existing measured/modelled estimate. Hardware disabled in active Settings hides the corresponding card and leaves loop removal unavailable.

## Previous allocation and preserved findings

The following records describe the earlier UI and retain its measured provenance. The allocation and card geometry below are historical; the current allocation is above.

Ride keeps measured outlet-minus-inlet ΔT, its time-aligned ten-minute trace, and the resistance-heat / loop-removal estimates. Rejected, missing or stale probe inputs suppress the derived value and trace, while valid independent heat inputs remain visible. Resistance provenance and rated pump flow qualify the estimates.

The individual probe values and ambient reading live on Cooling. Battery min/max and motor/OBD remain on Ride. The approved card heights are 144, 132 and 104 px for the lower pair.

## Preserved findings from the previous Ride view

The following records explain the existing sensor distinctions, sign convention, trace alignment and estimate qualifications. Their previous layout descriptions are historical; the current allocation is in the #183 inset budget.

The screen you actually ride with. Ordered by what you would want to know if you could only glance once: how fast, how hard you are pushing, how hot the pack is getting, how much is left. Speed comes from GPS rather than the bike, per the request — the wheel-derived figure is kept underneath it, because the gap between them is your speedometer error.

The motor's own sensor beside the bike's OBD temperature — separate sensors, not one at two resolutions: docs/can-decode-findings.md §"0x020 / 0x022" has the 2026-08-02 lap putting PID 05 up 27 → 30 °C in step with the inverter gate channel while 0x022 moved 27.9 → 28.5. This tile showed PID 05 alone under the OTHER one's name. ⚠️ Captioned "OBD", not "coolant": coolant is PID 05's OBD-II label, what the capture establishes is that it tracks the gate, and the Coolant tile two rows up is the MAX31865 probes. PID 05 is keys[1] because PairTile colours and charts from the upper key and it is the more responsive of the two. The inverter IGBT channels are hotter still and are NOT here — they are inverter readings, and that doc marks their min/inst/max ordering unverified.

Speed, power and the meter as one instrument. The meter is a strip down the left edge rather than a band under a card of its own: it runs beside a numeral already that tall, so it costs no row, and this screen is short of rows rather than of width. Wheel speed sits in the sub-line because it reads high by a few percent like every vehicle speedometer, and charge at the end of that line — small, because it moves slowly, and here because it must never need a scroll. The dashed stretches are the BMS's own ceilings (lib/power-limits.js), and they MOVE: the discharge ceiling averages 91 kW over moving time against the bike's 126 kW peak. docs/dashboard-decisions.md §"The power meter" has the rest.

0x104 at 0.5 km/h beats the OBD PID's whole km/h, and arrives whether or not the poller is running.

The error is a difference of two speeds, so it converts by the same factor as a speed — no offset — and speed() applied to the difference gives exactly that.

The number this whole project exists to answer: how much heat the loop is actually pulling out of the pack. With flow roughly constant, ΔT is proportional to watts removed — so putting it next to the I²R watts going in shows, live, whether the cooling is keeping up.

A big ΔT is the loop working, not a problem — it only means trouble alongside a pack that is also climbing, which the tile above shows.

No coolant probes attached (or none reporting yet) means no ΔT to show — and this is the tallest tile on the screen to leave sitting empty.

The same two numbers as the Charge tab's HEAT IN / OUT, in the same order and units, on a row that was 94 px of ink in 348. Named for the two MECHANISMS and not for two directions: the Coolant tile two rows down is already captioned "in / out", for the inlet and the outlet, and a second in/out pair on one screen means neither. I²R earns the riding screen on its own account — docs/dashboard-decisions.md §"Resistive loss".

Both traces would need a shared scale to be comparable, and the difference is the point — so chart the difference itself, at the outlet's sample times with the inlet held from whatever it last read. Pairing the two by array index instead would silently plot the rate mismatch between the probes.

peek(), not the deltaColor() above: that reads through valueOf() and would subscribe this redraw to both probes instead of leaving it on the tick.

The Power card carried this sentence's other half — the same watts as a share of output — and the card is gone. Both belong here anyway: these are the watts the loop above has to carry away, which is what the ΔT beside them measures.

Both halves of the aside above are qualified, not just the one. `out` is the shakier of the two — COOLANT_FLOW_LPH is specified rather than measured, and an upper bound — and it arrives on this screen with the Charge tab's full sentence about the pump left behind, so the assumption has to travel with the number. ⚠️ The R note is dropped when there are no watts to qualify. With no pack_a the aside reads `I²R ? / loop 4428 W`, and "modelled R" beside it would be a provenance for a number that is not on screen.
