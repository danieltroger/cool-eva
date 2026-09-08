# Automatic DC charge current

Holds the pack under the thermal cliff during a DC fast charge by lowering the charge current, and gives it back when there is room. `src/charge/auto-curve.ts` decides (pure), `src/charge/rate.ts` measures the heating (pure), `src/charge/auto.ts` reads the bus and transmits, `scripts/check-charge-auto.ts` replays it.

## The cliff, and what it costs

At a **true 55 °C** the config-15 BMS clamp releases, the VCU finally sees the real pack temperature, and the DC current collapses to **~19.5 A**. Measured 2026-09-07 at two stops: **42 minutes lost**. The pack reached exactly 55.0 and never exceeded it.

⚠️ 55 is a **derivation, not a preference**: it is `LIMP_B_TEMP` and the clamp's release point, and it moves if the BMS config or that parameter moves.

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

⚠️ **And the window is anchored.** The same mistake has a second timescale: a pack holding one whole degree emits nothing at all, so after ten minutes the window simply _empties_ and the answer flips back to `unknown` — firing exactly when the controller **succeeds**, because a current low enough to hold the temperature steady is a current that stops the reading ticking. Measured on the shipped modules before the fix: 74 A → 35 A in eight minutes on a pack whose own history proves it is not heating. So the estimator keeps the newest sample from _before_ the window as an anchor, and `src/charge/auto.ts` keeps one such sample in the ring rather than trimming it away.

⚠️ **`STEP_DOWN_FROM_C` is evaluated on temperature alone, and first.** It sat after the `unknown` branch, so whether it applied depended on whether a rate happened to be measurable — the same "gated behind an estimate" bug caught in the plan review, structurally back, and masked only by `BLIND_DESCENT_FROM_C` happening to sit below it. `scripts/check-charge-auto.ts` §6 now asserts that ordering rather than leaving it to luck.

## The numbers, and where each comes from

|  | value | why |
| --- | --- | --- |
| `HORIZON_MIN` | 8 min | **Simulated, not chosen.** At 5 min the closed loop peaks at 54.0–54.3 °C — inside one quantisation step of the cliff on a whole-degree sensor read against a two-anchor model, which is not a margin. At 8 it peaks 51.7–52.7 for 3–11 % of mean current. ⚠️ Coupled to `RATE_WINDOW_MS`: it must cover the estimator's own lag (half the window) plus the descent. |
| `NO_RAISE_FROM_C` | 53 °C | Stop **raising** the current. A reading of 53 can be a true 53.99, so adding current there can push the pack into the next tier's band before the next tick shows it. ⚠️ This half used to step **down** unconditionally, ratcheting a pack that was sitting perfectly still all the way to the floor. |
| `STEP_DOWN_FROM_C` | 54 °C | Step down on temperature **alone**, whatever the rate says — the reading cannot resolve the last degree. See the margin argument below. |
| `BLIND_DESCENT_FROM_C` | 50 °C | Only a pack that is already hot justifies acting with no history. A cool one is minutes of climbing away from mattering, so waiting costs nothing. |
| **`MIN_COMMAND_A`** | **35 A** | ⚠️ **The one knob that matters.** Capping below this is worse than not acting: the cliff's saw-tooth averages a measured **35.3 A** duty-weighted (1.30 min/SOC-point), so break-even is `0.53 × 72.6 / 1.30 = 29.6 A`, and a 25 A floor would be **18 % slower than doing nothing**. 35 A is 15 % faster than the saw-tooth and on the dial's own grid. |
| `STEP_A` | 5 A | The dash's dial granularity, so a rider taking over sees the same numbers. |
| `RATE_WINDOW_MS` | 10 min | ≥3 periods of the longest (1–3 min) saw-tooth, so the slope is bulk drift rather than oscillation. Fitting to the saw-tooth over-predicts the real climb by **3.5×**. |
| `AUTO_TICK_MS` | 60 s | The input changes every 1.5–2.5 min on a steady charge; updating faster than that adds bus frames and dash flicker for nothing. |
| `RELEASE_FACTOR` | 1.5 | The hysteresis. Give current back only when the cliff is comfortably far, or the controller chatters around the threshold. |

## Two tiers, and why they are 53 and 54

⚠️ **The time-to-cliff rule cannot see the last degree.** `batt_temp_hi` is whole degrees, so a reading of 54 means the pack is anywhere in **[54, 55)** — and the rule measures from the _reading_, so it over-states the time left by up to a whole degree's worth, `1/R` minutes:

| observed rate | rule says | worst true time left | reduced? |
| ------------- | --------- | -------------------- | -------- |
| 0.050 K/min   | 20.0 min  | 0.20 min             | **no**   |
| 0.100 K/min   | 10.0 min  | 0.10 min             | **no**   |
| 0.125 K/min   | 8.0 min   | 0.08 min             | yes      |

A pack reading 54 and rising slower than 0.125 K/min is invisible to it, yet can be a hundredth of a degree from the cliff. **Nothing on this bus resolves that**: every pack-temperature signal is integral — `batt_temp_hi`, `batt_temp_lo`, `pack_temp_avg`, both `_vcu` variants and all twelve per-module readings. The only fractional thermal signals are the motor, the inverter and the coolant probes. So `STEP_DOWN_FROM_C` is the correction for a quantisation the time-to-cliff test computes as if it were resolved, and 53/54 is the **maximum safe pair** — holding a reading of 54 would mean accepting a true 54.99.

⚠️ **The same correction applies one degree lower, and leaving it out is a safety regression.** From `NO_RAISE_FROM_C` the time-to-cliff test targets **54**, not 55. Without that, a pack reading 53 holds for any rate below 0.25 K/min while possibly being at 53.99 — and over a frozen 150-plant grid the two tiers then cross the cliff in **six places the previous single-ceiling rule did not**. With it: none, and the worst margin is unchanged. `scripts/check-charge-auto.ts` §11 pins that as a golden count, because it is the one property no other assertion can see — every other section compares against the do-nothing baseline, which cannot notice a rule that got less safe without getting wrong.

**Considered and rejected:** applying the same correction _everywhere_ (targeting `reading + 1` at all temperatures). It is safer on every axis, but it makes the equilibrium **colder** — 52.47 °C against 53.01 — which is the opposite of what this change is for. Gating it at 53 keeps the correction where the margin is thin and leaves the rest of the range alone.

⚠️ **What this does NOT show up in.** The simulated plant cannot produce the state these tiers exist for: its packs are always either rising or pinned at the floor, never sitting with a fitted slope near zero at a reading of 53. The real pack gets there by oscillating across the boundary — a limitation of the model's _shape_, not its constants. The evidence is therefore a **real logged episode** (`scripts/charge-auto-episode.ts`, 2026-08-08): across the logged series there are 71 ticks at a reading of 53, and on **20** of them the old rule steps the current down where this one holds, with none the other way round. The clearest is 13:51, where the pack read 53 while _falling_ to 50 and the old rule throttled it four ticks running.

## Fail-safe

**Any unknown holds, and a hold commands nothing.** Stale or implausible `batt_temp_hi`, no DC session, a session state older than 5 s, an absent `fast_dc_limit_max_a`, the controller switched off, or the rider having moved the dial: in every one of those the bike charges exactly as it does today.

That is the whole safety posture, and it is what makes the feature bounded: **it can only ever improve on the status quo, never worsen it.** `scripts/check-charge-auto.ts` §1 asserts all nine branches hold and that none of them produces a current.

### Taking it back

⚠️ A stand-down lasts the **charge**, not the session's memory of it, and clearing it is **one tap**. While stood down the effective mode is still `automatic`, so a plain on/off toggle would read "switch off" — the opposite of what the rider wants — and taking the controller back would mean tapping off and then on, through a label that says the wrong thing. The charge tab's button therefore has three states, and when the reason is `RIDER` it reads _"take the current back"_ and sends `mode=automatic`, which is what clears the flag.

⚠️ **The reason moves with the flag, in both directions.** Standing down and being taken back each refresh it immediately rather than waiting for the next 60 s tick — otherwise the button spends up to a minute offering the wrong action in exactly the window this is about.

⚠️ **The rider always wins**, from either direction. A `dc_charge_limit_selected_a` event — the dial on the bike — stands the controller down for the rest of the session, and so does a charge current set by hand from the phone: both are the rider saying what they want, and a controller that overrode either three seconds later is the thing that gets a Pi ripped out. Switching the toggle back to automatic is an explicit "you take it again" and clears the stand-down. That event is necessarily the rider and never our own echo: this Pi does not hear its own transmissions (`createRawChannel` does not set `CAN_RAW_RECV_OWN_MSGS`) — proven 2026-09-07, when three Pi sends produced no decoded row while all twelve of the dash's did.

## What it is allowed to do

Commands go through the existing `/vcu-write` `charge-current` action and nothing else, so they inherit `SERVICE_WRITE_ENABLED`, the bus lease, the live-session check, the opcode and ceiling chosen off the live bus, and one audit-journal line each. **One transmit path.** A consequence worth stating: on a Pi that has not opted into writes this controller is inert, and that is correct.

`CHARGE_AUTO_ENABLED=0` is the kill switch a phone toggle cannot reach; the dashboard toggle is in-memory only, like the fan's, because the Pi loses power with the bike.

## What the replay shows, and what it cannot

Three real stops of 2026-09-07 (arrival temperature, ambient and SOC band all measured) × four plants — as fitted, half the cooling, twice the cooling, ambient +10 °C:

- **Never peaks above the do-nothing baseline. 12/12.**
- **Never causes a crossing the baseline did not have. 12/12.**
- Worst time cost **+4.0 min**; best saving **−8.0 min**.
- DC2 finishes **8.0 minutes sooner** and stays under the cliff — and neither a controller stuck at the ceiling nor one stuck at the floor can do that, which is the assertion that keeps the rest honest.

⚠️ **The limit, and it is not small.** The plant is the two-anchor model from one day, and the controller is designed precisely not to depend on it. So this shows the rule behaves across a 4× spread of cooling — the "works for one day's `b`" failure it exists to avoid — and it shows **nothing about the real bike**. Only a live charge does that.

⚠️ **The replays alone could not see over-throttling at all.** Under the fitted constants, equilibrium at full current is `ambient + 83.7 K`, so every stop in the 2026-09-07 set is doomed to cross 55 °C whatever the controller does — which makes "throttled a charge it should have left alone" _unrepresentable_. Six mutations survived the check until two **cold plants** were added, on which full current never approaches the cliff and the right answer is to do nothing: the check now asserts zero cap events and no time cost on those. A third plant arrives hot on a cold day and cools, which is the only thing that exercises giving the current back.

⚠️ Buying "never crosses the cliff" **costs time on the stops that would have got away with it**. DC3 arrived at 42 °C and never reached 55; the controller still throttles it and pays a few minutes. That is the trade, it is bounded, and the check asserts the bound rather than pretending it is zero.
