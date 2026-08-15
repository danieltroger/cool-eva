# Hypermiling view — recommendations

Design notes for a range-maximising view, written from the BMS's own configuration and the LiBAL Application Engineering Manual. The frame decodes referenced below are all implemented in `src/can/decode-bms.ts`; the reverse-engineering notes and the OEM manuals they came from are local-only and not in this repo.

**Division of labour:** the backend logs _measured_ values only. Every derived quantity below is the frontend's job. Nothing here should become a logged signal.

---

## 1. The core insight: range is set by one cell, not by the pack

The pack is 81 series positions (11 LMUs: four with 8 cells, seven with 7). The BMS cuts discharge on the **minimum cell voltage**, not on pack voltage or SOC. Everything else is an average that hides the one cell that actually ends the ride.

Two consequences worth building the whole view around:

- **Cell spread is range you already paid for and cannot use.** `cell_spread_mv` (ΔV, `0x205`) is the gap between best and worst cell. When the worst cell hits the floor, the rest of the pack still holds that much unusable charge. On this bike the weak cell is **#68** and the strong one is **#20** — note this is the _opposite_ of what the original decode said before the BMS config was read; bytes 2 and 3 of `0x203` were swapped.
- **SOC is the wrong gauge near empty.** It comes from coulomb counting plus an OCV model, and the OCV table in the config was never re-characterised for the P32B cells. Below roughly 20 % the view should stop leading with SOC and lead with min-cell headroom instead.

---

## 2. "How close am I to cutting out" — do it properly

The naive version (`cell_min_mv − cutoff`) will cry wolf on every hard acceleration. Three things make it honest:

### a) Compensate for sag

Voltage under load is not voltage remaining. Sag is roughly ohmic:

```
sag_mv_per_cell  ≈ pack_current_a × pack_resistance_mohm / 81
cell_min_rest_mv ≈ cell_min_mv + sag_mv_per_cell        (while discharging)
```

`pack_resistance_mohm` is `0x206` bytes 0–1; `pack_current_a` is `0x200` bytes 6–7 (check the sign convention in `decode.ts` — it's signed, charge vs discharge). Amps × milliohms gives millivolts directly, so the units work out with no scaling factor.

This matters more than it sounds: at 100 A with a 100 mΩ pack that's ~123 mV per cell of pure sag — comparable to the entire margin you're watching. Show **both**: instantaneous (what the BMS sees, what will actually trip) and sag-compensated (what you actually have left).

### b) Show the dwell, not a binary alarm

`DischargeModeUnderVoltageCutOffTimer` is **60 s**. The minimum cell must stay below the threshold for a full minute before the contactors open. A dip during a hard pull is not a cut-out. Show a dwell bar that fills while under threshold and drains when back above — that turns a scary flicker into actionable information ("you have 45 s of this left").

### c) `allowed_discharge_a` is the earlier and better warning

`0x202` bytes 4–5 is the BMS's own live current limit. It falls **before** the voltage floor is reached, and it also drops for cold, heat and low SOC. Voltage headroom tells you where the cliff is; allowed-current tells you the BMS is _already_ throttling you. As a headline "am I being limited" indicator it beats voltage.

Note this is the one signal that can never go stale — see §6.

---

## 3. Efficiency: where the energy actually goes

### Resistive loss is a first-class hypermiling lever

```
i2r_loss_w        = pack_current_a² × pack_resistance_mohm / 1000
i2r_loss_fraction = i2r_loss_w / (pack_kw × 1000)
```

At 100 A / 100 mΩ that's ~1 kW thrown away as heat. Because it scales with **current squared**, halving your current quarters the loss — which is the single most direct visualisation of why gentle riding wins. A live "% of pack output being burned as heat" readout is more motivating than a Wh/km number that only settles over minutes.

This also ties into the watercooling project: that 1 kW is exactly what the loop has to remove, so the same number explains both range and coolant ΔT.

### Consumption

- `inst_consumption_wh` (`0x025`) is the bike's own instantaneous figure — good for a needle, too twitchy for decisions. Show a rolling median alongside.
- **Use `0x661` bytes 0–2 for remaining energy once the new config is flashed** — 1 Wh resolution, versus the 1 kWh field on `0x205` and the bit-15-flagged word on `0x10A`. Far better for a range-remaining estimate.
- Range estimate: rolling Wh/km over the last few km, applied to remaining Wh. Show the horizon used ("at your last 5 km"), because a single number invites false precision.

### Regen you are not capturing

`allowed_regen_a` (`0x202` bytes 6–7) against the configured ceiling of 120 A. It derates at high SOC and at temperature extremes. If you top out at 100 % and head down a mountain, regen is unavailable and you'll be on the brakes — worth surfacing _before_ the descent, not during. The configured curve in the current config: full 120 A from 10 °C to 45 °C, tapering to zero at 55 °C, and on the cold side nothing below −10 °C.

---

## 4. Temperature

- `0x660` gives **which** LMU is hottest and coldest (indices), plus average pack temperature.
- `0x664` carries per-LMU battery temperature (BAT1) multiplexed by LMU number — the first time module-level temperature is available. Caveat: **LMU 6 and LMU 8 have no battery temperature sensor enabled**, so they will never report one. That is configuration, not a fault.
- Cold pack means higher resistance, which means more I²R loss and more sag, which means less range _and_ an earlier cut-out. With coolant in/out already logged, a "pack efficiency vs temperature" view is directly reachable and would justify the watercooling loop empirically.

---

## 5. Suggested layout

**Primary (always visible)**

1. Min-cell headroom above cut-off — instantaneous and sag-compensated, with the dwell bar
2. Allowed discharge current vs the 400 A ceiling — the "am I limited" bar
3. Rolling Wh/km with the averaging horizon stated
4. Remaining energy in Wh, and range at the current rolling rate

**Secondary**

5. I²R loss as % of output
6. Cell spread ΔV, with min/max cell index (min is the one that matters)
7. Hottest LMU index + average pack temp; coolant in/out ΔT
8. Regen headroom — allowed regen vs 120 A

**On demand**

9. Per-cell voltage strip, 81 bars, weakest highlighted — once the new config is flashed
10. Error/warning flags, only when non-zero

---

## 6. Traps

- **Don't trust `0x665` blindly.** It's the configured cut-off broadcast as a _literal constant_, because the BMS exposes no memory address for its own configuration thresholds (the CAN memory map is 82 entries, all live measurements or command registers). It's stamped in at config-build time and cannot drift from the config it ships in — but it _can_ be desynced by editing limits in the Diagnostic Software GUI without regenerating the file. If `0x665` and observed cell voltages ever disagree, suspect a stale config, not a decode bug. `allowed_discharge_a` never has this problem.
- **Don't average the per-cell frames across LMUs.** `0x662`/`0x663`/`0x664` are three separate messages and the BMCU advances to the next module between them. Always key cells off the LMU number in the _same_ frame.
- **Don't treat 0 mV as a cell reading.** LMUs 5–11 have only 7 cells, so the cell-8 slot is meaningless for them.
- **`charge_state` is a bitfield, not an enum.** `1` = Discharge, `2` = Charge, `16` = Idle. Testing `!== 1` for "charging" flags Idle as charging.
- **Rate mismatch.** `0x200`/`0x203` are 20 Hz, `0x202` 10 Hz, `0x205`/`0x206`/`0x660`/`0x661`/ `0x665` 1 Hz. Anything combining a 20 Hz and a 1 Hz signal is only as fresh as the slow one — don't present a 1 Hz-derived number as instantaneous.
- **Sag compensation is a model, not a measurement.** `pack_resistance` is the BMS's own estimate and lumps in cabling and contactors. Treat the compensated figure as an aid, never as the authority on whether you're about to cut out — the instantaneous value is what trips the BMS.
