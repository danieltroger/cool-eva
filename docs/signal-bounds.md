# Signal bounds — what range each reading can physically be in

Every reading the dashboard draws is gated against a range first. This file is where the ranges come from and why each one is the number it is.

**Where they live.** Beside the signal, as `bounds` on its `SignalDef` in `src/can/registry.ts`. `scripts/generate-signal-bounds.ts` writes them into `public/lib/generated-bounds.js`, which is committed because the dashboard has no build step and cannot import a `.ts` module. `npm test` runs that generator with `--check` and fails if the committed copy is stale.

**They were in a table 500 lines away until #227**, in `public/lib/bounds.js`'s `BY_KEY`, alongside a hand-maintained list of every signal that had been forgotten. Both are gone.

## Plausibility bounds — `lib/bounds.js`

The gate exists because the real data is not clean. Across 7.6 M logged readings (Apr–Aug 2026) the bike has produced `coolant_in` at −242 °C in 59 450 rows and `coolant_out` at 988 °C in 40 351 rows — an open/flaky PT100, not noise — plus rarer `0xFFFF` sentinels on the cell voltages, −32767 on GPS altitude, and `high_beam` briefly reading 193. Rendering those raw is how you end up watching "−242 °C" on a coolant tile at 90 km/h, and a single one of them destroys a sparkline's autoscale for as long as it stays in the window.

The gate **rejects rather than clamps**. Clamping invents a plausible number and hides a real fault; dropping the sample keeps the last good value on screen and lets the tile say "fault" — which is the actionable thing, because on this bike an out-of-range coolant probe is a wire to go and wiggle.

Order of consultation in `boundsFor()`: the generated per-signal table, then the cell-voltage pattern, then `COUNTER_KEYS`, then `BOOLEAN_GROUPS` (flags before units, because their unit is `""` — which would otherwise fall through to unbounded and let `high_beam=193` render as "on"), then `BY_UNIT`.

### Why cell voltages are gated no tighter than the decoder

`CELL_VOLTAGE_PATTERN` gets `[1000, 5000]`, the same band the decoder uses (`MIN`/`MAX_PLAUSIBLE_CELL_MV` in `src/can/decode-bms.ts`), and deliberately not tighter. A tighter client gate is actively harmful here. The decoder's band is wide on purpose — "far wider than this pack's own configured limits, so no real cell, even a badly damaged one, can fall outside it" — and anything this rejects does not reach `signalState`, so `CellStrip` goes on drawing the last good bar. A cell collapsing to 1400 mV would then be invisible on the one screen whose premise is that a single cell out of 81 ends the ride. The server has already dropped the `0xFFFF` sentinel and the 8192 mV pad; this is defence in depth, so it should agree rather than second-guess.

### The charge manager's numeric bounds (2026-08-20)

The same miss `dc_charge_limit_selected_a` had, arrived at from the other direction: these signals do reach a rule, but the rule is `BY_UNIT`'s "A" fallback of `[-1000, 1000]`, and every one of them is a plain u8. No value a byte can hold is rejectable, so the gate was decorative. Each bound is derived from something, not guessed:

- **127** is `MAX_DC_CHG_CURRENT`'s FIELD range. Parameter 258 is a BYTE S that Energica's own option data masks with 0x7F (`src/vcu/write-targets.ts`), so the value field is 0…127 whatever the sign column says, and `fast_dc_limit_max_a` is that parameter read back off `0x625`. This bike holds 75.

  **⚠️ NOT 80.** 80 is this project's WRITE POLICY — the highest value Energica ever shipped a variant at, which is why `scripts/check-vcu-params.ts` refuses to write 81 and annotates 127 as "the datatype's own ceiling is NOT the policy's". A plausibility gate is about what the field can legitimately carry, not about what we are willing to write into it. Bounding at 80 would render a dealer write, or a differently-optioned bike, as a dead SENSOR rather than as the new value — defeating the one reason this key is logged, which is to notice the day the parameter changes. It would also have this key disagree with `dc_charge_limit_selected_a` about what counts as a fault for the same underlying parameter, which is the mistake the two DC voltages below are given identical bands to avoid.

- `fast_dc_limit_a` is `0x620` b0, bounded by that configured max, so it inherits the 127.
- `fast_dc_target_a` is the current the VEHICLE ASKS FOR, bounded in turn by the live limit the station offers — but the two frames run at 10 Hz and 20 Hz, so across a step edge the request reads up to 12 A above the limit for a frame or two (50 such frames in the corpus, all within 1 s of a step). 150 covers 127 plus that skew and still rejects the 255 an all-ones payload decodes to, which is what these entries were added for.

  ⚠️ **Renamed from `fast_dc_a` on 2026-08-20**, when `0x615` turned out to be the VCU's request frame rather than the charge manager reporting. The bound is unchanged; only the reason it is 150 rather than 127 is now stated in terms of a request. See `docs/charge-manager.md`.

- `fast_dc_target_v` and `fast_dc_limit_max_v` (`0x615` b0-1 and `0x625` b0-1) are 16-bit DC voltages whose decoders gate the high byte to `0x01`, so each can only emit 256…511 V while `BY_UNIT`'s "V" fallback is `[-50, 900]`. Both take `pack_v`'s `[0, 450]`: all three are voltages for the same 81-series pack, and a second witness must not be looser or the two disagree about what counts as a fault. ⚠️ `fast_dc_target_v` **replaced `charge_manager_pack_v`, and its value changed** — that key was documented as "the SAME QUANTITY as `pack_v`" and it is not, it is a request running a median 13.4 V above the pack.

- `charge_manager_error_src` and `charge_manager_error_code` (`0x610` b1 and b2-3) are a fault SOURCE and a fault CODE, so like `freeze_frame_dtc` they are identifiers and the whole field is legitimate — `[0, 255]` and the full signed 16 including the negative half, whose sign is the manufacturer's rather than ours. Only two of each have ever been seen; bounding round those would reject every fault this bike has not had yet, which is the entire reason the pair is logged.
- `ac_supply_limit_a` is SUPPLY-side — a cable or EVSE rating, not the bike's. It has only ever read 8, 10 and 13 A here and the bike's own AC charger stops at ~14.3 A, but a bound drawn round either of those would reject a legitimate reading at a bigger outlet. The ceiling comes from the STANDARD rather than from this bike: IEC 61851's control pilot cannot encode more than 80 A, so above that it is not a supply rating at all.

These are the second line of defence, not the first. `src/can/charge-manager.ts` checks frame invariants on `0x610`, `0x615`, `0x620` and `0x625`, so an all-ones payload still REACHES those decoders and they refuse it — the value never gets as far as this file. Both layers are wanted, because they fail differently: the invariant catches a sender that has stopped talking, and these catch a decode that is wrong in a way no invariant can see, since a byte read at the wrong offset still arrives in a frame with a perfectly good b1 = 0x01.

### The blank-unit trap, in three variations

A signal with a blank unit in a group that is not a `BOOLEAN_GROUP` reaches no rule at all and renders whatever arrives — the one outcome this file exists to prevent. Three keys were caught by it separately and each needs bounds of its own:

- `fast_dc_contactor` — a 1/0 flag in `charge`, which is not a `BOOLEAN_GROUP` and must not become one, because `mains_v` and `dc_a` live there. Its unit is `""` precisely so it cannot fall into `BY_UNIT`'s numeric ranges.
- The charge manager's flags and raw state bytes (`dc_charging`, `ac_charging`, `bms_leak_detect_inhibit`, `charge_type`, `charge_manager_status`, `charge_manager_state`) — same group, same blank unit. The two raw state bytes are gated to a byte rather than to the values they have been seen to take: `0x610` b0 has produced seven values and b7 nine across 29 sessions, and the point of logging them raw is to catch a state nobody has seen yet; a bound drawn round today's set would reject exactly that.
- `speed_redundant_a_raw` / `_b_raw` (`0x125`) — raw counts, blank unit, non-boolean group. There is no scale to bound them by (see `src/can/drive.ts`), so the bound is derived from the one thing that is known: at the measured ~109-117 counts per km/h this bike's 200 km/h top speed is at most ~23 400 counts, so 40 000 cannot reject a real reading and does reject the wild value a wrong offset or width would produce.

The opposite failure, a unit fallback that is too tight, has its own examples. `psu_12v_mv` and `psu_12v_lowpower_mv` are in mV, and `BY_UNIT`'s mV fallback is `[0, 5000]` because it was written for cell voltages — a healthy 12 704 mV rail would fall straight through it and be drawn as a dead sensor. 20 000 mV is well above anything a 12 V system produces and well below the 65 535 a decode failure would show. `dc_charge_limit_selected_a` is named because `BY_UNIT`'s "A" fallback of `[-1000, 1000]` would happily draw a misread opcode byte as 147 A.

`abs_warning_lamp` is the reverse again: **⚠️ not** a 1/0 flag, despite living in `diag` with a blank unit. Energica's `A_WARN_LAMP` is `byte 4 mask 0x0C >> 2` — TWO bits, so 0…3 — and the mask is kept as the vendor wrote it rather than narrowed to the one bit this bike has been seen to use. Without its own declared bounds the group-wide boolean rule would gate it to `[0, 1]` and reject lamp states 2 and 3 as a dead sensor, precisely when the lamp has something to say.

`freeze_frame_dtc` is an IDENTIFIER, not a measurement, so the whole 16-bit space is legitimate (P0514 is 0x0514 = 1300, and a U-code reaches 0xFFFF). 0 is meaningful too: it is the bike's own way of saying no freeze frame is stored.

`COUNTER_KEYS` exists because `dtc_count` (0…127, PID 01) and `warmups_since_clear` (0…255, PID 30) share the `diag` group with the 154 generated `dtc_*` flags but are counts, not flags — the group-wide 1/0 rule would reject every value above 1 as a sensor fault, gating out exactly the stored-code count that the Faults tab's OBD cross-check exists to show, precisely when there is something to cross-check. (The service sheet carried a tile until 2026-08-20 that put the Hub's ACTIVE `dtc_*` flags beside PID 01's STORED count — two numbers `Counters()` says measure different things and always disagree — and left the reader to make of that what they would. It was removed as a duplicate of the Faults tab, which is strictly more: it names the codes, carries their history, and runs a real cross-check of PID 01's counter against the length of mode 03's list, saying so when those two disagree. Note that is a DIFFERENT pair of numbers, so nothing was 'moved' — the tile's juxtaposition simply had no reading worth keeping.) `dtc_stored_count` reads 39 on this bike today.

`buttons` joined `BOOLEAN_GROUPS` on 2026-08-16. Today their decoder can only emit 0 or 1 (it returns `bit()`), so the gate rejects nothing — it is there for the same reason `controls` is, which is that `high_beam` once read 193. A decoder that later returned the masked byte instead of the bit (`handlebar & 0x20` is 32, not 1) would otherwise paint a pressed button as an ordinary number, and a button tile that lights on 32 but not on 1 is exactly the kind of quiet wrong answer this file exists to stop.

### `km_per_kwh_can` — why not the same band as the hub's pair

`0x10B` carries the VCU's own consumption: the same two quantities as `km_per_kwh` / `kwh_per_100km`, down a different path, and deliberately NOT given the same band. The hub's pair is smoothed; this one is instantaneous at 10 Hz, and an instantaneous km/kWh is unbounded above by construction — coast or regen for a moment and you cover distance on no net energy at all. Replaying the 2026-08-02 lap through this gate at the hub's `[0.5, 200]` rejected 159 of 448 readings, a third of a healthy signal drawn as a dead sensor, which is this file's own failure mode.

Those readings are real, not decode noise: the peak, 3379.3 km/kWh, pairs with 0.030 kWh/100 km in the same frame, and 3379.3 × 0.0296 = 100 exactly as the reciprocal requires. So the honest bound is the whole range the field can still express once the decoder has dropped the ≥ 65000 saturation clamp — 6499.9 and 64.999. Wide, but a narrower one here would be a guess about the bike rather than about the decode, and only the decode is knowable from this side. The 100 m averages get the same band, read unsigned and saturation-guarded the same way.

---

## What has no bound, and why

A signal that reaches no rule and declares no `bounds` **fails the build**. The alternative to a bound is not silence: it is `unbounded`, beside the signal, saying which kind of unboundable it is. `scripts/generate-signal-bounds.ts` enforces that, and also fails on a signal declaring both, and on an `unbounded` that has since gained a rule — the rot the hand-maintained list it replaced could never see.

| kind | why no number is honest |
| --- | --- |
| `counter` | Monotonic. Any ceiling is arbitrary, and the counter that outgrew it would be drawn as a dead sensor on a working bike. |
| `raw-word` | A multi-byte flag or state word, read for its bits. A `[0, 1]` would reject every frame where anything is set. |
| `index` | An index into a structure whose size is the real bound — **where that size is documented nowhere**. |
| `unresolved` | The decoder itself says the scale or the meaning is unconfirmed, so any bound would state a claim this repo has refused. |

⚠️ **`index` is the category that has to be read carefully, and the sentence it replaced was wrong.** `docs/dashboard-decisions.md` used to say of this group _"the structure's size is the real bound"_, naming `cell_lowest_v_idx`. It is the real bound only when the repo knows it. For `cell_lowest_v_idx` / `cell_highest_v_idx` the memory ids are documented and the **index space is not**, anywhere; `lmu_temp_high_idx` / `lmu_temp_low_idx` carry no comment at all, and `LmuTemperatureSensor` exists — so if they index a _sensor_ rather than a module, a `[1, 11]` drawn from `LMU_COUNT` rejects real readings. They stay `index` for that reason, not for lack of effort. `cells_connected` is the one that graduated: `decode-bms.ts:143-145` measured it at 81 series positions with lower values meaning a dropped module, so it is `[0, 81]`.

### 🚨 `lmu_cell_mux` must never be given a bound

It is a single byte, which by the rule below would make it `FIELD_U8`. It is the exception, and the reason is worth more than the rule:

> `decode-bms.ts:452` — _"Always log the selector itself, valid or not. Without it, 'byte 0 isn't the LMU number after all' and 'the frames never arrived' both show up as zero per-cell signals … It also makes the rotation visible: watch `lmu_cell_mux` in the debug view and you can see whether it really walks 1…11 or sits on one module."_

A bound sends an invalid selector to `faultState`, and `store.js` then holds the **last good value** in `signalState`. The rotation would go on looking healthy in the debug view while byte 0 had stopped being the LMU number — destroying the exact diagnostic the signal exists for. It is `raw-word`.

## The rule for single-byte raw words

A raw word read as **one byte** gets `FIELD_U8`; a multi-byte one stays `unbounded: "raw-word"`. The line is not about how likely a widening is — it is about what the entry records. `[0, 255]` records a **checkable fact**: this decoder reads one byte, visible in the source and falsifiable against it. `[0, 4294967295]` on a `readUInt32LE` records nothing a reader could check or a mutation could break.

⚠️ Neither can reject anything the decoder produces today. They are kept on the precedent `front_brake_pressure_bar` already carries — _"this gate can only catch a future widening of the field — worth having anyway"_ — and `lmu_cell_mux` above is the one place where that trade is the wrong way round.

## The bounds added by #227, and where each number comes from

**`bms_remaining_energy_wh` → `[0, 30_000]`.** The one bound here that can fire against a real decode failure rather than only a field widening, and the reason it exists is an **asymmetry**, not an incident:

- It is a **u24** (`decode-bms.ts:288`, `readUIntBE(0, 3)`) — field range 0…16 777 215 Wh.
- `residual_energy_wh` is the **same physical quantity** (`decode-bms.ts:271-272`: the BMS's own figure in 1 Wh steps against the VCU's in 2 Wh steps) and has been gated `[0, 30_000]` all along.
- **The dashboard prefers the ungated one.** `public/lib/derive.js:211` is `positiveOrNull("bms_remaining_energy_wh") ?? positiveOrNull("residual_energy_wh")`, and `??` falls through only on `null`, so the gated twin is never consulted while the ungated one returns a number. That feeds `rollingRangeKm()` and the hypermile range readout.

Where 30 000 comes from: this pack is **~21 kWh** — stated at `src/can/registry.ts` on `0x661` itself, at `docs/can-decode-findings.md:1436` and at `docs/fan-control.md:135`, and cross-checked by the 58 Ah at `decode-bms.ts:139-141`. 30 000 Wh is ~1.43× nominal: generous enough that no real reading can fail it, tight enough to reject 99.8 % of a u24. `scripts/check-flag-bounds.ts` asserts the **two twins' bands are equal**, so "match the twin" is a ratchet rather than a comment that rots.

⚠️ **What the gate does and does not buy.** It does not restore `??`'s fallthrough: `store.js:307-310` keeps the last good value on rejection, so `valueOf` stays non-null and `derive.js:211` still never reaches the twin. What it buys is that the corrupt reading never enters `signalState`, so the range readout holds the last good BMS figure instead of an impossible one. ⚠️ And it holds it **silently** — `rollingRangeKm` → `remainingWh()` → `valueOf` never consults `faultState`, so only the ALL page's raw tile says "fault".

**`avg_consumption_wh_km` → `[-3276.8, 3276.7]` and `inst_consumption_wh` → `[0, 6553.5]`** are field widths (`signed16(…)/10` at `ble/protocol.ts:159`, `u16le(…)/10` at `decode.ts:80`). ⚠️ Neither can reject a sentinel — every value the field holds is inside the band. A physical band derived the way `km_per_kwh_can`'s was, by replaying a lap and counting rejections, would be strictly better and is not done here.

**`gps_fix` → `[0, 3]`.** `src/gps/decode.ts:126` is `frame[2] & 3`: a two-bit field, so 0…3 by construction — the same call, for the same reason, as `abs_warning_lamp` and `drive_vsm_b3`. It had been filed as an index; it is a fix-quality enum.

**`gps_satellites` → `[0, 31]`**, for the identical reason one line further down the same decoder: `(frame[7] >> 3) & 31` is a documented five-bit mask. ⚠️ It was filed as an `index` in an earlier draft of this change, which applied the mask argument to one of a neighbouring pair and not the other.

**`remaining_ah` stays `unresolved`.** The field width `[0, 6553.5]` is available and is not taken: `decode-bms.ts:139-142` says what the value _means_ is unconfirmed — remaining capacity or a coulomb counter — and the two have different ceilings. Bounding a quantity the repo says it cannot identify would be writing down a claim it has refused. `bms_remaining_energy_raw` is `unresolved` for the neighbouring reason: _"there is no scale worth committing to"_.
