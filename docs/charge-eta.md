# Charge ETA — when the bike gets there

The Charge tab's "to N %" tile. `public/lib/charge-eta.js` is the arithmetic, `public/views/charge-eta.js` the tile, `scripts/check-charge-eta.ts` the check. Nothing runs on the Pi for this: `soc`, `pack_kw` and `charge_soc_limit_pct` are already on the wire.

**Energy ÷ power**, not SOC-step timing. That is a measured choice, not a preference — see below.

## Why not time the SOC steps

The first design timed the intervals between whole-percent `soc` transitions and took the median of the last three. The argument for it was real: `soc` is whole percent, so a rate taken by **differencing two levels** carries ±1 point of quantisation, and over a small move that is most of the answer. (That is not hypothetical — it produced a 4× wrong charging rate in an overnight control script on 2026-09-19 and would have raised the bike's charge current for nothing.)

But the alternative it was being defended against was the wrong one. **Energy ÷ power has no SOC term at all**, so it was never exposed to that error. Replayed against the archive's own charging runs, predicted ÷ actual:

|                      | median   | p10  | p90  |
| -------------------- | -------- | ---- | ---- |
| energy ÷ power, AC   | **1.00** | 0.96 | 1.04 |
| step median-of-3, AC | 0.92     | 0.89 | 1.07 |

Unbiased, with half the dispersion, and it needs no ring, no listener, no new signal and no state that a service restart destroys.

## What a SOC point costs

**~199 Wh**, by integrating `pack_kw` across the archive's charging runs. Two independent passes: **AC n=10 median 198.8, DC n=34 median 199.7**, measured between SOC _transition instants_ so no level-differencing enters; and an earlier per-run pass at DC n=31 median 196, AC n=5 median 185. The shipped constant is **199**.

⚠️ **It is a compromise, and the residual bias is SOC-dependent.** Per band, DC rises monotonically 188.6 Wh (20–29 %) → **208.1 (80–89 %)**, so 199 runs ~4 % optimistic exactly where a charge limit sits. The tile is good to roughly ±5 % — minutes on AC, seconds on DC. A per-band table would buy that back and is not worth the fit.

⚠️ **It is not `residual_energy_wh ÷ (soc/100)`.** That field is **discharge-side**: it says what the pack will give back, and charging a point costs more than discharging one returns. It implies 16.0 kWh — 160 Wh a point — and using it makes the ETA ~18 % optimistic before any taper. `soh` reads 100.0 in all 320 archive rows, so the gap is charge/discharge accounting, not degradation.

⚠️ **Nor is it the 21.5 kWh nameplate**, which is the gross figure and is wrong the other way.

The constant is stated **per point** rather than as a capacity on purpose: calling it a capacity is what invited both of those errors, and it invites the next reader to "improve" it by recomputing `remainingWh() / soc` live — which reintroduces a SOC-dependent bias for nothing. For the record, that ratio drifts 15.29 → 16.22 kWh from empty to full (6.1 %, and flat at the top).

**Corroboration:** 199 Wh ÷ 230 W (1 A at 230 V) = 52 min a point, and the archive's slowest real charge runs **38.4 min/point at `pack_kw` 0.3**, which the same arithmetic puts at 40. They agree to a couple of minutes a point.

⚠️ **`bms_remaining_energy_wh` reads 0.0 in all 317 archive rows on this bike.** `remainingWh()` in `public/lib/derive.js` prefers it and falls through to `residual_energy_wh` because `positiveOrNull` rejects a zero. Any statement about "the pack's own remaining-energy field" on this bike is about the second one.

## The boundary is at target 100, and nowhere else

Predicted ÷ actual, **indexed by the target asked for**:

| target    | DC median | AC median |
| --------- | --------- | --------- |
| 60 %      | 0.97      | 1.03      |
| 80 %      | 0.90      | 0.98      |
| 88 %      | 0.81      | 0.95      |
| 90 %      | 0.82      | 0.96      |
| 95 %      | 0.79      | 0.94      |
| 99 %      | 0.68      | 0.92      |
| **100 %** | **0.39**  | **0.78**  |

One discontinuity, between 99 and 100. So every target up to 99 gets a **point estimate**, and only 100 gets a **lower bound** — "not before HH:MM".

⚠️ **The 99 → 100 step itself is thin evidence, and an earlier draft of this file overstated it.** Re-derived: **7 up-steps exist archive-wide, all AC, none DC** — 0.2, 0.8, 1.0, 3.3, 14.7, 15.6 and 78.5 min, three of them not charging at the time. Charging-only the median is ~14.7 min against 98 → 99's ~6.9, i.e. **about 2×**, not the "5–15×" this file used to claim — and the "DC 7.5 and 24.1 min" it cited **do not exist**: there are no DC 99 → 100 transitions in the archive at all. The bound is still right, because the predicted/actual table above is computed over the whole approach to each target and drops from 0.92 to 0.78 on AC at 100. The last step's own durations are simply too few to carry the weight the earlier wording put on them.

⚠️ **This is not `SOC_RATE_TRUSTED_BELOW` (88).** That constant is in `src/charge/soc.ts` and says in its own comment that it was measured for a **trailing-rate DC controller**. Borrowing it would refuse a real time for targets 90–99 — exactly the range `charge_soc_limit_pct` sets. A different instrument measures its own boundary.

⚠️ And the sentence "every measurement above the knee runs 2–4× long", which an earlier draft of this feature carried with a ⚠️ on it, is **false**. It came from reading the table above indexed by where the prediction was made rather than by its target. Recorded here because a wrong fact wearing a correction's costume is the expensive kind.

## No correction factor

DC runs 0.79–0.90 of actual below the boundary, which looks like a factor worth applying and is not. DC's 18 % is **2.4 minutes**, because a DC charge to 90 % takes 18; AC's 4 % is 6.4 min on a 214-min wait. It is not a scale error anyway — 0.97 at target 60 decaying to 0.68 at 99 is the taper leaking in, which a median factor cannot represent — and the pain is in the dispersion (DC p10 −15 min), which a factor cannot touch either.

## When it says nothing

No SOC · no target · already at or past it · `pack_kw` below **0.1 kW**.

That floor is one rule covering three things — not charging, a stalled charge, and a discharging pack — because they are the same question: is enough going in to divide by. It is a floor rather than a zero test because 0.02 kW returns a forty-day ETA, which is not an answer. ⚠️ It is also the stall rule, and it has to be: `charge_manager_state` does **not** move during a stall (it stayed put through all five of the archive's longest).

## Smoothing `pack_kw`

Median over 60 s from the store's ring, falling back to the newest reading below 3 samples.

⚠️ **`pack_kw` does not reach the browser at 20 Hz.** `notifyChange` sits inside `record()`'s deadband branch, so the patch stream is the ride log's row stream, gated at 0.05 kW — measured **DC 28 rows/min, AC 7.2, AC p10 0.5**. A 60 s window can legitimately hold **zero** samples, and the fallback is correct rather than a concession: silence on a log-on-change signal means the value is unchanged, not missing. Peak-to-peak inside 60 s is 3–5 %, so the window is not doing much work on DC either — it is there to stop a taper step jumping the readout.

## How the replay judges itself

A prediction may use only the samples that existed at the instant it is made — no look-ahead.

⚠️ Stalls are excluded as **predictions, not runs**, by the tile's own `pack_kw` floor, so both sides use one definition. Excluding whole runs would have thrown away over half the corpus and, more importantly, would have hidden the taper the boundary exists for: of the outlier intervals, those at soc ≥ 95 and 88–94 are the taper, a third below 88 still have `pack_kw > 0.2`, and only about 15 of 38 are genuine stalls.
