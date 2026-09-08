# Pack internal resistance

Why the BMS's own figure is not usable, what replaced it, and the measurements behind it.

Code: `public/lib/pack-resistance.js` (the van-free estimator) and `public/lib/pack-resistance-live.js` (the van state consumers read). Check: `scripts/check-pack-resistance.ts`. Issue: #144.

## The BMS's estimate is unusable

`pack_resistance_mohm` is `0x206` b0-1, the BMS's own ΔV/ΔI estimate. Across the **full 15.4 M-row history** it has **301 rows**:

|                                  | rows       |
| -------------------------------- | ---------- |
| ≤ 0                              | 123 (41 %) |
| ≥ 1000 mΩ (max 54 869 = 54.9 Ω)  | 46         |
| physically plausible (50–400 mΩ) | ~114       |

It also freezes: 2430 mΩ held across five rows for 62 minutes, zeros held for 17 days. And it produced **no rows at all** across the 52-minute DC charge on 2026-09-07.

**The sparsity is the BMS, not the logger.** The signal has no deadband (`registry.ts`), and in `obd-garage/captures/2026-08-02_bms_90s.log` frame 0x206 arrives **90 times in 90.00 s — exactly 1 Hz — with b0-1 reading `0` in all ninety**. Log-on-change correctly emits ~1 row. An earlier reading of this blamed a deadband; that was wrong.

`obd-garage/DC_CHARGE_LIMITS.md` §"High-pack-resistance warning" had already diagnosed the mechanism: it is ΔV/ΔI, and a dead-flat current plateau makes ΔI ≈ 0. A steady DC charge is exactly that plateau, so the estimate is worst precisely where it would be most useful.

It is **still logged** — it is what the BMS said, and it still plots on `grafana/dashboards/battery-cells.json`. Nothing on screen is computed from it.

## What replaced it

A rolling least-squares fit of `pack_v` on `pack_a`, with a measured R(T) curve as the fallback. Every answer carries a provenance: `measured`, `modelled`, or `assumed`.

**A sample is a (V, A) pair from ONE 0x200 frame.** Both come from that frame (`src/can/decode-bms.ts`), one frame's values are coalesced into one WebSocket patch (`src/can/signals.ts`), and `ws.ts` sends or drops a patch whole — so co-presence in one message is what proves same-frame provenance. Pairing across frames biases the slope toward zero by about 4 mΩ; that error is how the first version of this measurement got 64 mΩ where strict pairing gives 64.5.

**The buffer fills at ~5–6 Hz, not the bus's 20 Hz, and the sample is conditioned on both values having changed.** A patch carries a signal only if it passed its deadband, and `pack_v` moves about a third as often as `pack_a`: only **28.2 %** of frames yield a pair. A 30 s window holds a median of **42** pairs and never more than **88**.

### Gates

| gate | value | why |
| --- | --- | --- |
| window | 30 s |  |
| least samples | 20 | below this a slope is arithmetic, not evidence |
| least current spread | 40 A | precision goes as σ_V/(σ_I·√n); below ~40 A the answer moves with the window |
| fit quality | relative standard error < 15 % | see below |
| sanity | 20–400 mΩ | a decode or arithmetic fault, nothing else |
| measured hold | 20 s | a rider who stops accelerating must not read `measured` through a motorway cruise |

**A band on the VALUE was tried and rejected.** `[60, 120]` mΩ rejects **18.9 %** of qualifying windows below 60 and 2.1 % above 120 — and neither tail is noise:

| window class | n    | median relative SE | median pack temp |
| ------------ | ---- | ------------------ | ---------------- |
| R < 60 mΩ    | 375  | 3.8 %              | **52 °C**        |
| 60 ≤ R ≤ 120 | 1571 | 2.4 %              | 48 °C            |
| R > 120 mΩ   | 42   | 2.8 %              | **28 °C**        |

The low tail is a hot pack and the high tail a cold one, both fitting as well as the middle. A band on the answer throws away the physics. The standard-error gate does not: it keeps 95 % of windows, and the median is flat at every threshold (64.9 / 64.9 / 64.8 / 64.6 mΩ at 5/10/15/20 %), so the gate protects against pathological windows without shifting the answer.

## The measurement

**2026-09-07, Villach → Zadar. 1681 windows, 30 s wide, 10 s apart, strict same-frame pairing.** Pooled median **64.5 mΩ**, p25 61.3, p75 69.9.

Independently re-derived by a second agent with its own pipeline: 64.5 mΩ, p25 61.0, p75 70.8.

### R against pack temperature — the modelled fallback

| pack °C | windows | median R |
| ------- | ------- | -------- |
| 25–29   | 24      | 115.4 mΩ |
| 30–34   | 82      | 95.3     |
| 35–39   | 122     | 80.8     |
| 40–44   | 178     | 69.8     |
| 45–49   | 566     | 64.5     |
| 50–54   | 573     | 61.0     |

Linearly interpolated at the bin midpoints, **endpoints held flat rather than extrapolated**. The curve is convex — per-bin drops of −20, −15, −11, −5, −4 mΩ — so no single slope fits it, which is why the table ships instead of a formula.

**Validated range 27.5–52.5 °C.** Below it the model **under-reports**: real windows at 20–24 °C sit near 135 mΩ against the held-flat 115.4. A cold-start tile therefore understates heat.

A 55–59 °C bin exists (n=9, 60.3 mΩ) and is excluded as thin. It is consistent with the trend; an earlier pass that used carried-forward pairing put it at 73.5 mΩ and looked like a derate anomaly, which was an artefact of that pairing and not a property of the pack.

### It is temperature, not SOC

Pack temperature and SOC correlate across a ride day (r = −0.33), so the curve above could have been SOC in disguise. It is not:

| within pack 45–54 °C | median R |     | within SOC 40–70 % | median R |
| -------------------- | -------- | --- | ------------------ | -------- |
| SOC 10–24 %          | 63 mΩ    |     | pack 40–44 °C      | 70 mΩ    |
| SOC 25–39 %          | 64       |     | pack 45–49 °C      | 65       |
| SOC 40–54 %          | 63       |     | pack 50–54 °C      | 61       |
| SOC 55–69 %          | 63       |     |                    |          |
| SOC 70–84 %          | 62       |     |                    |          |
| SOC 85–99 %          | 59       |     |                    |          |

**R is flat across the whole SOC range** (~6 %, and ~1.4 mΩ in the re-derivation) and falls monotonically with temperature. Keying the fallback off `batt_temp_hi` is right; an SOC term would be noise. This also answers a question asked separately: from a heat-generation standpoint there is no meaningfully worse end of the SOC range to fast-charge at.

### Against the datasheet

The pack is **81s2p** (`HYPERMILING.md` §1; `DC_CHARGE_LIMITS.md` §9.4), so the `IMP06160231P32B rev A/2` figure of 2.4 mΩ/cell gives **97 mΩ at 25 °C** against a measured ~115 at 27.5 °C. About 20 % high, which is expected: the datasheet is a fresh-cell typical, this pack has 18 440 km on it, and the measurement includes busbars, contactors and cabling.

## `assumed`, and when it appears

With no measurement **and** no `batt_temp_hi`, R is **65 mΩ** — the pooled median — under provenance `assumed`, so `packResistance()` never returns null and no consumer needs a null branch.

This is reachable on a real bike, not just in theory: `src/can/pack-temperature.ts` leaves `batt_temp_hi` **permanently unlogged** when `CUSTOM_BMS_CONFIG` is set and 0x660 never arrives. Before this change every dependent tile went dark in that configuration, silently.

`batt_temp_hi_vcu` is deliberately **not** used as the fallback: under exactly that config it is the clamped view — a flat 35 °C through 35–54 °C — which the table would map to a confident 85 mΩ. A wrong number wearing the `modelled` label is worse than an admitted assumption.

65 errs low against a cold pack. That understates heat on the informational tiles and is the conservative direction on the safety-relevant one: R enters `sagPerCellMv` as `I·R/81`, so too high an R inflates the sag and makes `restingMinCellMv` read optimistic.

On a fresh connection, before the first `batt_temp_hi` arrives, the tiles briefly read `assumed R`. That is honest — at that instant nothing better is known — and it clears on the first temperature. An earlier draft carried a 10 s grace meant to hide it; the grace could never fire, because `valueOf` keeps returning the last value once a signal has arrived, so the only route to `assumed` is a signal that has never arrived at all. The dead branch is gone rather than repaired.
