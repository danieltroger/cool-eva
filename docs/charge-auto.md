# Automatic DC charge current

Holds the pack under the thermal cliff during a DC fast charge by lowering the charge current, and gives it back when there is room. `src/charge/auto-curve.ts` decides (pure), `src/charge/rate.ts` measures the heating (pure), `src/charge/auto.ts` reads the bus and transmits, `scripts/check-charge-auto.ts` replays it.

## The cliff, and what it costs

At a **true 55 °C** the config-15 BMS clamp releases, the VCU finally sees the real pack temperature, and the DC current collapses to **~19.5 A**. Measured 2026-09-07 at two stops: **42 minutes lost**. The pack reached exactly 55.0 and never exceeded it.

⚠️ 55 is a **derivation, not a preference**: it is `LIMP_B_TEMP` and the clamp's release point, and it moves if the BMS config or that parameter moves.

## The rule, whole

```
headroomKelvin = (54 − T) − observed heating rate × REACTION_MIN

           T ≥ 55                    give up MAX_STEP_A                (the clamp has already released)
           no usable rate, T ≥ 54    give up the silence's own deficit
           no usable rate, T < 54    hold — change nothing
           T ≥ 54                    headroom is capped at 0, so it can only lower or hold
           |headroom| < 0.5 K        hold                              (below 54 only)
           otherwise                 step by AMPS_PER_KELVIN × |headroom|, bounded to [1, 15] A
```

**The setpoint is 54 °C and the controller holds it from both directions.** Below it with room, the current goes up; at it and still warming, down; at it and not warming, hold; past 55, down hard.

⚠️ **`headroomKelvin < 0` is algebraically the old time-to-cliff test aimed one degree lower.** `(54 − T)/rate < REACTION_MIN` is the same inequality, so the steep-heating guard needs no branch of its own — it _is_ this line — and `REACTION_MIN` inherits `HORIZON_MIN`'s sizing rather than replacing it. There is still no thermal model: the rate is the measurement of the cooling, so sun, wind, fan duty and ambient arrive already accounted for.

### Why the horizon was the primary rule, and why it is not any more

The rule this replaces had **no target temperature at all**: it commanded the ceiling while the cliff was more than a horizon away and stepped down when it was not. That was right about the thing it was designed for — it needs no thermal model and no departure time — and wrong about two things Daniel found on 2026-09-09:

- **It has no opinion about being too cold.** A pack at 51 °C with a low rate is "far from the cliff", so the rule is equally happy at 45 A and at 75 A. It never climbs back with any urgency, and the hotter the pack the larger the coolant-to-pack ΔT and the more heat the loop extracts — so charging at 51 leaves range on the table.
- **The two tiers at 53 and 54 (#181) then pinned it there.** `NO_RAISE_FROM_C` could not raise from a reading of 53 whatever the rate, which is exactly the "52-53 °C and declining to raise" he watched.

Both tiers are gone, replaced by the single setpoint. What they were _for_ — a whole-degree sensor cannot resolve the last degree, so a reading of 54 may be a true 54.99 — survives as the `min(headroom, 0)` clamp: **nothing may raise at or above the setpoint**, and the 0.5 K deadband is not applied there either.

## The silence is a bound too — and ignoring it cost 45 A at 51 °C

⚠️ **This is the defect behind #186's third complaint, and it is in the estimator rather than the rule.** A least-squares slope is fitted to the _samples_, and a whole-degree sensor emits one only when the degree changes — so a pack that climbs fast and then flattens leaves the window holding a cluster of early points and **keeps reporting the steep slope for as long as it stays still.**

Measured on 2026-09-09, replayed from the ride log:

| tick     | reading | fitted rate     | minutes since the reading moved | what the silence alone bounds it at |
| -------- | ------- | --------------- | ------------------------------- | ----------------------------------- |
| 15:55:57 | 50      | 0.877 K/min     | 0.5                             | —                                   |
| 16:02:57 | 50      | **0.706 K/min** | **7.5**                         | **0.133 K/min**                     |
| 16:03:57 | 50      | 0.706 K/min     | 8.5                             | 0.118 K/min                         |

The pack actually went 50 → 51 between 15:55:27 and 16:05:08: **1 K in 9.7 min = 0.103 K/min.** The estimate was **6.8× the truth**, `(55 − 50)/0.706 = 7.1 min` put the cliff inside the horizon, and `CLOSING` fired six ticks running — 70 → 40 A while the pack read 50-51. That is the "51 °C and 45 A already" in the issue.

The fix is the same argument the section below makes about _too few_ readings, pointed at the newest one instead of the oldest: **a reading that has not moved for `t` minutes proves the pack moved less than a degree in `t`, so the rate is under `1/t` in MAGNITUDE.** `estimateHeatingRate` clamps the fitted slope to `±1/t`.

⚠️ **Both sides, and the second one is not decorative.** A stale _cooling_ slope is exactly as expired as a stale heating one, and capping only the heating side lets it through as free headroom — which raises the current. Measured on the one-sided version: a −1 K/min slope survived 7 minutes of silence, where the bound is 0.143, and jumped 50 → 65 A at a reading of 53 where the rule it replaces holds.

⚠️ **It is not free, and the PR carries both halves.** Over the frozen 150-plant grid the cap _alone_, against the old rule, takes crossings of 55 from **24 to 26** — it stops over-stating the rate, and the old rule had been buying margin by accident. The setpoint law more than pays that back (16, a strict subset). Do not read the final 16 as the cap being harmless on its own.

⚠️ **Only the `rate` branch.** `bounded` is already derived from elapsed time, and capping it as well breaks `check-charge-auto.ts` §2 — _"a bounded rate that puts the cliff inside the horizon must still close"_ — which is a shipped safety assertion.

## "Too few readings" is a bound, not an absence

`batt_temp_hi` is **whole degrees**, logged on change. A pack sitting still therefore produces _no samples at all_, and an early design read that as "cannot see" and descended anyway — ratcheting a stable 51 °C charge to the floor **because** it was stable. On the DC2 replay the rate loop never ran once; every one of the 73 ticks was that blind descent.

The estimator returns three things instead of two:

|  | when | the controller does |
| --- | --- | --- |
| `unknown` | less than 5 min of history — early in a session, or after a restart | at or above 54 °C, descend by the silence's own deficit; below, hold and change nothing |
| `bounded(R̄)` | enough time, fewer than 3 distinct whole degrees — so T stayed inside a band that many degrees wide, and **cannot** have moved faster | treat `R̄` as the rate |
| `rate(R)` | a least-squares slope over the window | use it |

The span is measured **to now**, not to the newest sample: samples arrive only when the reading changes, so measuring between them would make the stillest pack look like the one we know least about.

⚠️ **And the window is anchored.** The same mistake has a second timescale: a pack holding one whole degree emits nothing at all, so after ten minutes the window simply _empties_ and the answer flips back to `unknown` — firing exactly when the controller **succeeds**, because a current low enough to hold the temperature steady is a current that stops the reading ticking. Measured on the shipped modules before the fix: 74 A → 35 A in eight minutes on a pack whose own history proves it is not heating. So the estimator keeps the newest sample from _before_ the window as an anchor, and `src/charge/auto.ts` keeps one such sample in the ring rather than trimming it away.

⚠️ **The blind descent is sized from the silence, not from a constant** — substituting the `1/t` bound into `headroomKelvin` at the setpoint leaves `REACTION_MIN / t` kelvin of deficit, so this branch and the cap above rest on one measurement rather than two guesses. With no samples at all there is no bound to read and it takes the full `MAX_STEP_A`: a pack reading ≥ 54 with no history whatsoever is the least safe thing the branch sees.

⚠️ **The frozen grid cannot arbitrate that choice and must not be quoted as if it could.** The branch only runs while the span is under `RATE_MIN_SPAN_MS`, and the silence cannot exceed the span, so on the grid the deficit always saturates and a fixed `MAX_STEP_A` is byte-identical at every feasible candidate. The evidence is the argument plus `check-charge-auto.ts` §14, which drives it in the non-saturated regime.

## The numbers, and where each comes from

|  | value | why |
| --- | --- | --- |
| `TARGET_C` | 54 °C | The setpoint, from Daniel: he watched the pack sit at 54 for a long time without touching 55 with the controller off, so the equilibrium exists. ⚠️ A reading of 54 means a true [54, 55), which is why nothing may RAISE from here and why the deadband is not applied at or above it. |
| `REACTION_MIN` | 12 min | `HORIZON_MIN` renamed and aimed at 54 rather than 55. ⚠️ Still coupled to `RATE_WINDOW_MS`: it must cover the estimator's own lag (half the window) plus the descent. Every A1-feasible point in the sweep sits at 10 or 12. |
| `AMPS_PER_KELVIN` | 2 A/K | **The gain.** ⚠️ Not a thermal model — it turns an error into a step, and its only job is to be small enough not to oscillate against the estimator's ~5 min lag. Chosen by the sweep below: the fewest crossings _and_ the least chatter of any feasible point. |
| `MAX_STEP_A` | 15 A | ⚠️ **Not a preference.** Every feasible point in the sweep sits here, and capping at 5 A crosses the cliff on 28-30 of the 150 frozen plants against 16 — a proportional law that cannot move faster than the pack is a slower ratchet, not a gentler one. |
| `MIN_STEP_A` | 1 A | The bike accepts 1 A, verified against the manual sheet. The dash's own dial moves in 5 A; the loop is finer than the dial on purpose. |
| `QUANTISATION_K` | 0.5 K | Half a least count of a whole-degree sensor. **Derived, not chosen**, and applied only _below_ the setpoint. |
| **`MIN_COMMAND_A`** | **35 A** | ⚠️ **The one knob that matters.** Capping below this is worse than not acting: the cliff's saw-tooth averages a measured **35.3 A** duty-weighted (1.30 min/SOC-point), so break-even is `0.53 × 72.6 / 1.30 = 29.6 A`, and a 25 A floor would be **18 % slower than doing nothing**. |
| `RATE_WINDOW_MS` | 10 min | ≥3 periods of the longest (1–3 min) saw-tooth, so the slope is bulk drift rather than oscillation. Fitting to the saw-tooth over-predicts the real climb by **3.5×**. |
| `AUTO_TICK_MS` | 60 s | The input changes every 1.5–2.5 min on a steady charge; updating faster adds bus frames and dash flicker for nothing. ⚠️ Not a guarantee: on 2026-09-09 the service stalled for six minutes and logged nothing at all, so the replays index by timestamp rather than by tick. |

### The sweep, and why these three

`AMPS_PER_KELVIN ∈ {2,3,4,5,6,8} × MAX_STEP_A ∈ {5,8,10,15} × REACTION_MIN ∈ {5,8,10,12}`, 96 points, scored over the frozen 150-plant grid and every replay. **Six are feasible** — no plant added, ≤ 24 crossings, worst time cost ≤ 6 min — and all six sit at `MAX_STEP_A = 15` with `REACTION_MIN` 10 or 12.

| candidate       | crossings | new plants | worst reversals       | worst time |
| --------------- | --------- | ---------- | --------------------- | ---------- |
| **2 / 15 / 12** | **16**    | **none**   | **3** (none over 5 A) | 4.6 min    |
| 6 / 15 / 12     | 16        | none       | 4                     | 4.6 min    |
| 8 / 15 / 12     | 16        | none       | 5                     | 5.0 min    |
| 5 / 15 / 12     | 17        | none       | 5                     | 4.1 min    |
| 6 / 15 / 10     | 17        | none       | 4                     | 3.9 min    |
| 3 / 15 / 12     | 16        | none       | 6                     | 4.5 min    |

Against the rule this replaces — **24 crossings and 14 reversals** — the chosen point is 16 and 3. Its DC1/b\*2 trace is what a proportional controller should look like, next to the 5 A ratchet's:

```
62,53,47,37,35,37,39,41,43,45,47,49,51,53,…      gain 2, 1 A resolution
67.6,62.6,57.6,52.6,47.6,42.6,47.6,52.6,…        the 5 A ratchet it replaces
```

⚠️ **Chatter is scored against the shipped rule, not against a number someone liked.** The 5 A ratchet reverses **14 times** on DC2/b\*2 and no assertion in the suite ever noticed, because the old reversal check scored `RECOVERY_PLANT` alone — the one plant where it reverses once. `check-charge-auto.ts` §6 now scores every replay and pins the worst against that 14, with the constants it was measured at.

## At the setpoint, a bound is not evidence of heating

⚠️ **Without this the headline behaviour does not exist.** `bounded` is strictly positive by construction — it says only _"the reading did not move"_ — so feeding it into a headroom already clamped to at most 0 makes every tick at a reading of 54 a step down. A pack sitting perfectly still at 54 for fifteen minutes was still being ratcheted, and `NEAR_CEILING` fired **0 times in 6 770 ticks** of the frozen grid.

That is #163's _"descend because it is stable"_ one level up, and this document argues against it two sections above. **Only a fitted slope can establish that a pack at the setpoint is heating.** With the fix, `NEAR_CEILING` fires **417 times in 6 770 ticks** — 417 of the 623 ticks at a reading of 54 — and the frozen grid's crossings are unchanged at 16.

A pack past **55** is unaffected: that branch runs first and on temperature alone, needing no rate at all.

⚠️ **What no logged episode we hold can show.** There is no tick in any captured series where the reading is 54 _and_ the fitted slope is ≤ 0 — on 2026-08-08 the window still remembers the climb to 55, so the slope is positive and the rule correctly reduces. The `rate ≤ 0 at exactly 54` case is therefore asserted on a synthetic ring, and the honest statement is that the bike has not yet shown it. What the bike _has_ shown is the `bounded` case, which is the common one.

## Superseded: the two tiers at 53 and 54, and what survives them

#181 replaced a single ceiling with `NO_RAISE_FROM_C = 53` and `STEP_DOWN_FROM_C = 54`. Both constants are gone, replaced by the setpoint. **The measurements that justified them are not, because every one of them is still true** — they are what the `min(headroom, 0)` clamp now rests on, and re-deriving them would cost a session.

⚠️ **A whole-degree sensor cannot see the last degree.** A reading of 54 means the pack is anywhere in **[54, 55)**, and a rule measuring from the _reading_ over-states the time left by up to `1/R` minutes:

| observed rate | time-to-cliff says | worst true time left |
| ------------- | ------------------ | -------------------- |
| 0.050 K/min   | 20.0 min           | 0.20 min             |
| 0.100 K/min   | 10.0 min           | 0.10 min             |
| 0.125 K/min   | 8.0 min            | 0.08 min             |

**Nothing on this bus resolves that**: every pack-temperature signal is integral — `batt_temp_hi`, `batt_temp_lo`, `pack_temp_avg`, both `_vcu` variants and all twelve per-module readings. The only fractional thermal signals are the motor, the inverter and the coolant probes. That is why **nothing may raise at or above the setpoint** and why the 0.5 K deadband stops below it.

**What changed is the conclusion drawn from it, not the fact.** #181 read "a reading of 53 can be a true 53.99" as "never raise from 53"; the setpoint reads it as "53.99 is still below 54, and the cliff is a further degree away". Daniel watched the second reading hold on the bike — the pack sat at 54 for a long time without touching 55 — and the frozen grid says the trade cost no crossing.

**Also recorded, and not re-litigated here:** applying the correction _everywhere_ (targeting `reading + 1` at all temperatures) was tried under #181 and rejected — safer on every axis but a **colder** equilibrium, 52.47 °C against 53.01, which is the opposite of what both changes are for.

⚠️ **The simulated plant barely reaches the state any of this is about**, then or now. Measured on the rule this replaces, over the frozen 150-plant grid: 2 380 ticks at a reading of 53 or 54 and **not one** with a fitted slope at or below zero. Under the setpoint rule it is **2 072 and 13** — better, because the pack now sits at the setpoint instead of being ratcheted past it, but still 0.6 %: its packs are always rising or pinned at the floor. The real pack gets there by oscillating across the boundary — a limitation of the model's _shape_, not its constants. So the arbiter is logged `batt_temp_hi` (`scripts/charge-auto-episode.ts`), and `check-charge-auto.ts` §10 names the three assertions #181 shipped that the setpoint deliberately reverses.

## Fail-safe

**Any unknown holds, and a hold commands nothing.** Stale or implausible `batt_temp_hi`, no DC session, a session state older than 5 s, an absent `fast_dc_limit_max_a`, the controller switched off, or the rider having moved the dial: in every one of those the bike charges exactly as it does today.

That is the whole safety posture, and it is what makes the feature bounded: **it can only ever improve on the status quo, never worsen it.** `scripts/check-charge-auto.ts` §1 asserts all nine branches hold and that none of them produces a current.

### Taking it back

⚠️ A stand-down lasts the **charge**, not the session's memory of it, and clearing it is **one tap**. While stood down the effective mode is still `automatic`, so a plain on/off toggle would read "switch off" — the opposite of what the rider wants — and taking the controller back would mean tapping off and then on, through a label that says the wrong thing. The charge tab's button therefore has three states, and when the reason is `RIDER` it reads _"take the current back"_ and sends `mode=automatic`, which is what clears the flag.

⚠️ **The reason moves with the flag, in both directions.** Standing down and being taken back each refresh it immediately rather than waiting for the next 60 s tick — otherwise the button spends up to a minute offering the wrong action in exactly the window this is about.

⚠️ **The rider wins, but only when it is the rider.** A charge current set by hand from the phone stands the controller down, unconditionally — that path is unambiguous. A `dc_charge_limit_selected_a` event is **not**: the bike answers our own `0x120` commit with a `0x121` carrying the amps we just asked for, so on 2026-09-09 five of six automatic commands in one session stood the controller down 1 ms after their own echo, and Daniel tapped "take the current back" six times before giving up. The rule is therefore narrower: **only a setpoint that differs from the last current this Pi put on the bus is the rider.**

- Exact equality is safe because it is exact — across 21 matched sends that day the echoed byte was identical to the commanded one every time, including 44 A, which is not on the dash's own 5 A grid.
- If the rider dials to exactly the value we commanded, nothing stands down and nothing changes on the bike: they asked for the current already flowing, and "switch off for this charge" is still one tap away.
- ⚠️ **A setpoint equal to the ceiling never stands the controller down.** The one setpoint event of that whole day which no Pi command caused was 75 A — the ceiling — at session teardown, i.e. the setting resetting on unplug. A rider dialling to maximum is indistinguishable from that reset, so it is not honoured; they still switch the controller off in one tap.
- ⚠️ **The clearing is not a guarantee.** `lastSentAmps` is cleared by `forgetSession()` on a `charge_manager_state` edge — but that signal is logged on change, and on 2026-09-09 it recorded `2` at 12:19:56 and did not record again until 15:50:56, across a whole DC session. So the edge can simply not fire, and a value can outlive an unplug inside one process life. It fails safe: a stale value only ever suppresses a stand-down for a current we really did command.

⚠️ **And the value is recorded BEFORE the frames go out.** `sendChargeCommand` awaits twice, 5 ms either side of the `0x121`, and the bike's answer lands inside that window — measured 3-10 ms after our `0x120`. Recorded afterwards, the controller has already stood itself down on its own command. `check-charge-auto.ts` §12 drives the real write runner against a stub channel whose `send()` fires the echo synchronously, because a fake sink replaces the very function whose ordering is the bug and would pass either way.

## What wakes this tile

The charge tab's sentence — _"Warming towards 54 °C too fast to catch — easing the current down. Commanding 62 A."_ — is the Pi's own phrasing, fetched from `/charge-auto`. It is **never polled**: `ws.ts` heartbeats a full snapshot every 5 s, so a derive bound naively to a signal's identity would turn into a 0.2 Hz poll of an HTTP endpoint. The tile re-reads the endpoint on three edges and nothing else.

⚠️ **The reason alone was enough for v1 and is not enough for this rule.** The rule #181 shipped changed reason almost every tick, so watching `charge_auto_reason` kept the whole sentence current for free. The setpoint rule does not: it sits in one reason — `CLOSING`, `SETTLED`, `NEAR_CEILING` — for many ticks while the commanded current moves 1-15 A on each one. Daniel found this on the road on 2026-09-10, the first DC sessions under it: the bike's current really was coming down and the tile still read "Commanding 62 A", with a page reload the only fix (issue #200). So the tile watches `charge_auto_target_a` as well, which `runTick` records after every command that lands.

⚠️ **The amps on screen come from the endpoint, never from that signal.** `charge_auto_target_a` is a wake-up and not a display value, because it **outlives the session that produced it**: `forgetSession()` nulls the controller's own `commandedAmps` and records nothing, so the signal keeps the last session's number in `liveState` and in the browser's store indefinitely. Rendered directly it would print a current the present charge has never commanded — a false claim about the motorcycle, which is the direction `public/lib/bounds.js` exists to rule out.

⚠️ **A tick that moves both is TWO patches and two fetches, and that is correct.** `runTick` records the reason, `await`s the command, then records the amps, and `src/ws.ts` turns every change batch into its own patch. The first fetch reads `automatic.state()` while the command is still in flight and gets the _old_ `commandedAmps`; the second is what makes the tile right. Two round trips 60 s apart is the true worst case.

⚠️ **The third edge is the session boundary, and no signal marks it.** `forgetSession()` runs on a `charge_manager_state` edge and records nothing at all, so for up to one 60 s tick `/charge-auto` answers with the _previous_ session's reason (it does not reset `context.reason` either) and `commandedAmps: null`, while both signals still hold the previous session's values. Nothing patches, so nothing can wake — reachable on any re-plug at the same charger quick enough that no tick intervenes. `onChargeSessionEnd()` therefore clears the tile's `loaded` flag and its two guards, alongside the two sibling charge controls, and the derive treats "the tile just became commandable" as its own wake-up so the next session re-reads the Pi.

The two ways a guarded derive loses a change — a read behind an early `return`, and a guard consumed above its gate — are general enough that they live in `docs/dashboard-decisions.md` § "A guarded derive, and the three ways to lose the change". `scripts/check-charge-auto-live.ts` holds all of this without a browser.

⚠️ **`refresh()` has no in-flight guard**, and it now has three triggers. Not reachable at 60 s spacing; the one place two can overlap is the session edge, where the render's `!loaded` fetch and the just-commandable one race — both GET the same endpoint and apply the same payload, so the cost is a duplicate round trip rather than a wrong tile. Recorded as a known bound rather than guarded, because a guard would be code for a race nothing can currently produce.

## What it is allowed to do

Commands go through the existing `/vcu-write` `charge-current` action and nothing else, so they inherit `SERVICE_WRITE_ENABLED`, the bus lease, the live-session check, the opcode and ceiling chosen off the live bus, and one audit-journal line each. **One transmit path.** A consequence worth stating: on a Pi that has not opted into writes this controller is inert, and that is correct.

`CHARGE_AUTO_ENABLED=0` is the kill switch a phone toggle cannot reach; the dashboard toggle is in-memory only, like the fan's, because the Pi loses power with the bike.

## What the replay shows, and what it cannot

Three real stops of 2026-09-07 (arrival temperature, ambient and SOC band all measured) × four plants — as fitted, half the cooling, twice the cooling, ambient +10 °C:

- **Never peaks above the do-nothing baseline. 12/12.**
- **Never causes a crossing the baseline did not have. 12/12.**
- Worst time cost **+4.6 min**; best saving **−8.1 min**.
- DC2 finishes **8.1 minutes sooner** and stays under the cliff — and neither a controller stuck at the ceiling nor one stuck at the floor can do that, which is the assertion that keeps the rest honest.

⚠️ **The limit, and it is not small.** The plant is the two-anchor model from one day, and the controller is designed precisely not to depend on it. So this shows the rule behaves across a 4× spread of cooling — the "works for one day's `b`" failure it exists to avoid — and it shows **nothing about the real bike**. Only a live charge does that.

⚠️ **The replays alone could not see over-throttling at all.** Under the fitted constants, equilibrium at full current is `ambient + 83.7 K`, so every stop in the 2026-09-07 set is doomed to cross 55 °C whatever the controller does — which makes "throttled a charge it should have left alone" _unrepresentable_. Six mutations survived the check until two **cold plants** were added, on which full current never approaches the cliff and the right answer is to do nothing: the check now asserts zero cap events and no time cost on those. A third plant arrives hot on a cold day and cools, which is the only thing that exercises giving the current back.

⚠️ **The 2026-09-09 episodes are OPEN-LOOP, and the check says so where they are used.** Replaying that day's logged `batt_temp_hi` shows what the rule would have _decided_ seeing that history — never what would have _happened_, because a different current changes the pack's trajectory and the log cannot say how. The plant grid is the closed-loop half. The two things they do settle are the two Daniel asked for: at 16:03:08, with the pack reading 50 and unmoved for 7.7 minutes, the rule gives current back rather than taking 5 A away; and seeded at the 45 A he found, three degrees below the setpoint, it climbs.

⚠️ Buying "never crosses the cliff" **costs time on the stops that would have got away with it**. DC3 arrived at 42 °C and never reached 55; the controller still throttles it and pays a few minutes. That is the trade, it is bounded, and the check asserts the bound rather than pretending it is zero.
