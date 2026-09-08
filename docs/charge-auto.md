# Automatic DC charge current

Holds the pack under the thermal cliff during a DC fast charge by lowering the charge current, and gives it back when there is room. `src/charge/auto-curve.ts` decides (pure), `src/charge/rate.ts` measures the heating (pure), `src/charge/auto.ts` reads the bus and transmits, `scripts/check-charge-auto.ts` replays it.

## The cliff, and what it costs

At a **true 55 °C** the config-15 BMS clamp releases, the VCU finally sees the real pack temperature, and the DC current collapses to **~19.5 A**. Measured 2026-09-07 at two stops: **42 minutes lost**. The pack reached exactly 55.0 and never exceeded it.

⚠️ 55 is a **derivation, not a preference**: it is `LIMP_B_TEMP` and the clamp's release point, and it moves if the BMS config or that parameter moves. (`DC_CURVE_TOP_C = 54` in `src/fan/curve.ts` sits one degree under it. Whether that was the same derivation or a coincidence is [#124]'s question; nothing here reads it.)

## The rule, whole

```
step down  while  time-to-cliff ≤ HORIZON_MIN
step up    while  time-to-cliff >  HORIZON_MIN × RELEASE_FACTOR
hold              in between
```

where `time-to-cliff = (55 − T) / observed heating rate`.

There is **no target temperature, no thermal model and no `TAU`**. The rate _is_ the measurement of the cooling, so sun, wind, fan duty and ambient all arrive already accounted for — which was the objection that killed the first design. And it needs no departure time, because it never aims at one.

⚠️ An earlier version carried a graded control law (`highest current with dT/dt ≤ (54 − T)/TAU`). It was **deleted**: at the horizon this controller uses, entering the loop already implies `R ≥ (55 − T)/HORIZON`, which forces the law to say "down" for every temperature under 55.6 °C and for every `TAU` in the plausible 14–31 range. It was decorative by construction. The time-to-cliff test it was bolted onto does the whole job.

## "Too few readings" is a bound, not an absence

`batt_temp_hi` is **whole degrees**, logged on change. A pack sitting still therefore produces _no samples at all_, and an early design read that as "cannot see" and descended anyway — ratcheting a stable 51 °C charge to the floor **because** it was stable. On the DC2 replay the rate loop never ran once; every one of the 73 ticks was that blind descent.

The estimator returns three things instead of two:

|  | when | the controller does |
| --- | --- | --- |
| `unknown` | less than 5 min of history — early in a session, or after a restart | above 50 °C, descend; below, wait |
| `bounded(R̄)` | enough time, fewer than 3 distinct whole degrees — so T stayed inside a band that many degrees wide, and **cannot** have moved faster | treat `R̄` as the rate |
| `rate(R)` | a least-squares slope over the window | use it |

The span is measured **to now**, not to the newest sample: samples arrive only when the reading changes, so measuring between them would make the stillest pack look like the one we know least about.

## The numbers, and where each comes from

|  | value | why |
| --- | --- | --- |
| `HORIZON_MIN` | 8 min | **Simulated, not chosen.** At 5 min the closed loop peaks at 54.0–54.3 °C — inside one quantisation step of the cliff on a whole-degree sensor read against a two-anchor model, which is not a margin. At 8 it peaks 51.7–52.7 for 3–11 % of mean current. ⚠️ Coupled to `RATE_WINDOW_MS`: it must cover the estimator's own lag (half the window) plus the descent. |
| `HARD_CEILING_C` | 53 °C | Where a merely _bounded_ rate stops being worth trusting. Its job is to stop a bound stepping the current back up next to the cliff, and on the two hot replays it is the branch that fires most. |
| `BLIND_DESCENT_FROM_C` | 50 °C | Only a pack that is already hot justifies acting with no history. A cool one is minutes of climbing away from mattering, so waiting costs nothing. |
| **`MIN_COMMAND_A`** | **35 A** | ⚠️ **The one knob that matters.** Capping below this is worse than not acting: the cliff's saw-tooth averages a measured **35.3 A** duty-weighted (1.30 min/SOC-point), so break-even is `0.53 × 72.6 / 1.30 = 29.6 A`, and a 25 A floor would be **18 % slower than doing nothing**. 35 A is 15 % faster than the saw-tooth and on the dial's own grid. |
| `STEP_A` | 5 A | The dash's dial granularity, so a rider taking over sees the same numbers. |
| `RATE_WINDOW_MS` | 10 min | ≥3 periods of the longest (1–3 min) saw-tooth, so the slope is bulk drift rather than oscillation. Fitting to the saw-tooth over-predicts the real climb by **3.5×**. |
| `UPDATE_PERIOD_S` | 60 | The input changes every 1.5–2.5 min on a steady charge; updating faster than that adds bus frames and dash flicker for nothing. |
| `RELEASE_FACTOR` | 1.5 | The hysteresis. Give current back only when the cliff is comfortably far, or the controller chatters around the threshold. |

## Fail-safe

**Any unknown holds, and a hold commands nothing.** Stale or implausible `batt_temp_hi`, no DC session, a session state older than 5 s, an absent `fast_dc_limit_max_a`, the controller switched off, or the rider having moved the dial: in every one of those the bike charges exactly as it does today.

That is the whole safety posture, and it is what makes the feature bounded: **it can only ever improve on the status quo, never worsen it.** `scripts/check-charge-auto.ts` §1 asserts all nine branches hold and that none of them produces a current.

⚠️ **The rider always wins.** A `dc_charge_limit_selected_a` event stands the controller down for the rest of the session. That event is necessarily the rider and never our own echo: this Pi does not hear its own transmissions (`createRawChannel` does not set `CAN_RAW_RECV_OWN_MSGS`) — proven 2026-09-07, when three Pi sends produced no decoded row while all twelve of the dash's did.

## What it is allowed to do

Commands go through the existing `/vcu-write` `charge-current` action and nothing else, so they inherit `SERVICE_WRITE_ENABLED`, the bus lease, the live-session check, the opcode and ceiling chosen off the live bus, and one audit-journal line each. **One transmit path.** A consequence worth stating: on a Pi that has not opted into writes this controller is inert, and that is correct.

`CHARGE_AUTO_ENABLED=0` is the kill switch a phone toggle cannot reach; the dashboard toggle is in-memory only, like the fan's, because the Pi loses power with the bike.

## What the replay shows, and what it cannot

Three real stops of 2026-09-07 (arrival temperature, ambient and SOC band all measured) × four plants — as fitted, half the cooling, twice the cooling, ambient +10 °C:

- **Never peaks above the do-nothing baseline. 12/12.**
- **Never causes a crossing the baseline did not have. 12/12.**
- Worst time cost **+3.3 min**; best saving **−9.3 min**.
- DC2 finishes **9.3 minutes sooner** and stays under the cliff — and neither a controller stuck at the ceiling nor one stuck at the floor can do that, which is the assertion that keeps the rest honest.

⚠️ **The limit, and it is not small.** The plant is the two-anchor model from one day, and the controller is designed precisely not to depend on it. So this shows the rule behaves across a 4× spread of cooling — the "works for one day's `b`" failure it exists to avoid — and it shows **nothing about the real bike**. Only a live charge does that.

⚠️ Buying "never crosses the cliff" **costs time on the stops that would have got away with it**. DC3 arrived at 42 °C and never reached 55; the controller still throttles it and pays a few minutes. That is the trade, it is bounded, and the check asserts the bound rather than pretending it is zero.

[#124]: https://github.com/danieltroger/cool-eva/issues/124
