# Turning the headlight off — the persistent current-threshold route

There is a **second** way to switch the headlight off over the bus, distinct from the `0x2F` io*set force in [headlight-diagnostic-control.md](headlight-diagnostic-control.md), and **it persists across power cycles**. It works by lying to the VCU about the beam's fault window: write the beam's maximum-current threshold \_below* what the beam actually draws, and at the next beam initialisation the VCU declares the circuit faulted and brings the beam up off.

This corrects the "the avenue is closed" verdict in [dash-command-channel.md](dash-command-channel.md): that is true of the _non-diagnostic_ channel, but false once a diagnostic session is on the table — there are two diagnostic routes, not one.

## The mechanism

VCU-Safety (`0xA8`) decides the beam is healthy only while its sensed current sits inside a `[MIN..MAX]` window. Three stored calibration parameters (the service tool's PARAM table, group `LIGHTS`, bank 1, all uint16, mA):

| idx | param                                | factory |
| --- | ------------------------------------ | ------- |
| 240 | `BEAM_MAX_CURR_TH`                   | 7500 mA |
| 241 | `BEAM_HILO_CURR_TH` (low/high split) | 3750 mA |
| 242 | `BEAM_MIN_CURR_TH`                   | 1500 mA |

Drop `BEAM_MAX` below the real draw (this bike: ~3600 mA) and the beam current is now "over max". The VCU reads that as an over-current fault and refuses to drive the output — storing **`B1012` HIGH BEAM / `B1009` LOW BEAM OPEN CIRCUIT** (the "low circuit amps" complaint a rider sees on the dash). Raising `BEAM_MIN` above the draw is the mirror-image bulb-out route.

Reads are ReadDataByCommonID (`22 <id_hi> <id_lo>`), writes are WriteDataByCommonID (`2E <id_hi> <id_lo> <value_be>`), where `id = (bank << 12) | idx` and bank = 1 — so `BEAM_MAX` is `0x10F0`. Both sit behind the same `0x10`/`0x27` session + SecurityAccess as the io_set route (`calc_key` = swap-adjacent-bits(seed) − `0x3E5F4542`, confirmed again here).

## On-bike results (2026-08-27, this Eva Ribelle) — CONFIRMED WORKING

Run from the Pi with `scripts/beam-threshold.ts`. Bike parked, key on, headlight on, not charging.

1. **Recon.** Thresholds all read factory (7500 / 3750 / 1500); live beam sense (io_get control 18) read **3633 mA** — inside the window, so the beam is on and un-faulted, as expected.
2. **Write `BEAM_MAX_CURR_TH := 1810 mA`** (half the measured draw). Write accepted, read-back confirmed 1810. **But the beam did NOT cut mid-session** — the sense still read 3673 mA with the draw now sitting _above_ the 1810 max. So the over-max threshold is **not** a continuous live cutoff.
3. **Key cycle.** Key off ~5 s, key on. **The beam came up OFF, with a beam-fault warning on the dash** — sense now reads **0 mA**. This is the whole point: the threshold is enforced at **beam initialisation**, not continuously, which is why the original rider report was of the light being off _after_ a restart.
4. **Restore.** Writing all three back to factory read back clean. The beam stayed off for the rest of that power-on (the fault had latched), then a final key cycle **brought the beam back on and the fault self-cleared** — no explicit ClearDiagnosticInformation was needed on this bike.

## How this compares to the io_set route

|  | io_set force (control 17) | threshold write (`BEAM_MAX`) |
| --- | --- | --- |
| Service | `0x2F` InputOutputControl | `0x2E` WriteDataByCommonID |
| Effect | immediate, beam drops at once | takes effect at next beam init (key cycle) |
| Duration | decays in <40 ms — needs a ~5 ms re-assert loop | **persists across power cycles** until written back |
| Side effect | none stored | stores `B1009`/`B1012`, shown on the dash |
| Undo | stop re-asserting / StopSession | `--restore` (factory thresholds); fault self-clears next clean key cycle |

Neither is a _broadcast_ frame and neither is non-diagnostic — both need the VCU-Safety session + SecurityAccess. A true no-diagnostic, works-while-riding "off" still points at hardware (tapping the low-beam switch input), as [dash-command-channel.md](dash-command-channel.md) notes.

## The beam is not special — every light has this window

The beam's `[MIN..MAX]` fault window is one instance of a pattern. `src/vcu/param-file.ts` (Energica's own `params.ecf`) gives **every VCU-current-sensed light** a min/max current-threshold pair, all on VCU-Safety (`0xA8`), bank 1, WORD/mA — so the same `0x2E` write faults any of them off at the next init. `scripts/beam-threshold.ts` covers all of them: `--light <name>`, `--all-off`, `--write`, and a per-circuit restore recipe.

**These are already writable through the app's shipped, gated path — no ban crossing.** `writeTargets()` (`src/vcu/write-targets.ts`) returns the five curated targets _plus a generated target for every other non-duplicate parameter_, so `BEAM_MAX_CURR_TH` (what the dashboard's headlight button writes) and each `*_CURR_TH` below can be set **by name** through the compare-and-swap / read-back / table-gate / stationary-safety-gate / audit machinery. The scratch probe here exists to measure the live **draw** and confirm the **sense** drops (the `io_get` read the shipped path deliberately can't do) — not because the write is otherwise unreachable. The generated targets carry the datatype's full range and a loud "NOT researched" warning; the beam is the only light with a researched off-value (1810 mA) and a purpose-built UI section so far.

| Circuit        | MIN idx / name               | MAX idx / name               | factory MIN/MAX | group   |
| -------------- | ---------------------------- | ---------------------------- | --------------- | ------- |
| Beam           | 242 `BEAM_MIN_CURR_TH`       | 240 `BEAM_MAX_CURR_TH`       | 1500 / 7500     | LIGHTS  |
| Front position | 243 `POSLIGHTS_MIN_CURR_TH`  | 244 `POSLIGHTS_MAX_CURR_TH`  | 50 / 300        | LIGHTS  |
| Rear position  | 251 `RPOSLIGHTS_MIN_CURR_TH` | 252 `RPOSLIGHTS_MAX_CURR_TH` | 15 / 500        | LIGHTS  |
| Stop / brake   | 245 `STOPLIGHTS_MIN_CURR_TH` | 246 `STOPLIGHTS_MAX_CURR_TH` | 50 / 300        | LIGHTS  |
| Indicators     | 235 `INDICATOR_MIN_CURR_TH`  | 236 `INDICATOR_MAX_CURR_TH`  | 200 / 500       | BLINKER |

**All five are now on-bike-proven (2026-08-28, this Eva Ribelle).** Each circuit came up off after writing its `MAX` below the window and a key-cycle — front and rear position dark with the key on, the stop lamp dark on a brake squeeze, the indicators dead when signalled. This bike's live values and the off-value that worked:

| Circuit        | live MIN / MAX (this bike) | wrote MAX          | off? |
| -------------- | -------------------------- | ------------------ | ---- |
| Beam           | 1500 / 1810¹               | 1810 (prior sess.) | ✓    |
| Front position | 50 / 300                   | 10                 | ✓    |
| Rear position  | 15 / 500                   | 5                  | ✓    |
| Stop / brake   | 50 / 300                   | 25                 | ✓    |
| Indicators     | 1000 / 2000                | 500                | ✓    |

¹ Beam `MAX` already read **1810, not the 7500 factory** — the shipped app's "Disable the headlight" from a prior session was still in effect, and the beam sense read 0 mA (off).

Cautions, now with the on-bike answers (the tool prints them):

- **The factory mA are the catalogue base (table 16406), not this bike.** Confirmed live: **indicators read 1000/2000, not the catalogue 200/500** — so `--restore` (catalogue) would be wrong for the blinkers; use the printed live-value recipe. Front/rear/stop matched catalogue on this bike.
- **idx 251/252 = `RPOSLIGHTS` — CONTEST RESOLVED.** Writing `idx 252 := 5` and key-cycling brought the rear position lamp up off, so the slot drives the rear position light (`param-file.ts` is right); it is **not** `table-catalog.data.ts`'s `LIGHTS_DUMMY_WORD3/4`.
- **Only the beam's current sense is known** (io_get control 18); the other four were verified by eye. With no sense the tool sizes the write as `MAX := MIN × 0.5` (below the floor), which faulted all four off.
- **Normally-off circuits** (stop, indicators) latch the fault only when energized — confirmed: nothing visible until the brake was squeezed / the signals run. `STOPLIGHTS_INITIAL_TEST=1`, `INDICATORLIGHTS_INITIAL_TEST=0`. Each stores its own open-circuit DTC.

**State left on the bike (2026-08-28):** all five circuits **disabled at the owner's request** — the bike runs with every light off and the open-circuit DTCs stored. Undo any circuit with its live-value recipe above (e.g. `--light indicator --write min 1000 --write max 2000`), then a clean key-cycle to self-clear the DTC.

## Verifying the other four on-bike (runbook — executed 2026-08-28)

This is the procedure that proved the four above; keep it for re-runs and other bikes. The beam was proven by measuring its draw (sense 18), writing `MAX` below it, key-cycling, and watching it come up dark. The other four have **no confirmed current sense**, so their verification is by eye: force the threshold low, key-cycle, and confirm _that specific light_ is off. Do them **one at a time** (stop and indicators can share a key-cycle — they need different actuation to observe) so a stored DTC is traceable to one circuit. Bike on its stand, key on, clear of moving parts.

Suggested order — always-on circuits first (easiest to see), normally-off last:

1. **Stop the service** so it releases `can0`: `sudo systemctl stop cool-eva`.
2. **Recon all five, read-only, and write the numbers down:** `sudo node --experimental-strip-types scripts/beam-threshold.ts --all`. This is the source of truth for the restore recipe (the tool also prints one per circuit). **Abort on `rearpos` if idx 251/252 read as implausible mA** — that is the contested-identity check; garbage means the slot is `LIGHTS_DUMMY`, not `RPOSLIGHTS`, and must not be written.
3. **Force one circuit off.** With no sense the tool falls back to `MAX := MIN × 0.5` and warns; or set it explicitly below the light's real draw, e.g. `--light frontpos --write max 20`. The write must read back equal or the tool refuses.
4. **Key-cycle** (off ~5 s, on). The threshold is enforced at **init**, not live — mid-session the light stays as it was, exactly as the beam did.
5. **Observe the specific light**, and expect a lighting fault on the dash:
   - `frontpos` / `rearpos` — the position lamp should come up off.
   - `stop` — squeeze the brake; the stop lamp should not light (or lights then faults).
   - `indicator` — signal each side; expect no lamp / hyper-flash. `INITIAL_TEST=0`, so the fault may only latch once you actually signal.
6. **Restore** with the printed live-value recipe (`--light <name> --write min <n> --write max <n>`), _not_ `--restore` for anything but the beam (that writes catalogue factory, which may differ from this bike). Key-cycle; the light should return.
7. **Clear the DTC if it does not self-clear.** On the beam this bike self-cleared after restore + a clean key cycle; if a code sticks, the shipped app's Service page `clear-dtcs` (or the vendor tool) clears it.

**Capture per light, to seed a future UI:** this bike's live `MAX` (the restore target), the off-value that worked, and whether the fault self-cleared. Those are the three things the beam has and the others don't.

## Relation to this repo's `0x2E`/`0x27` ban

cool-eva walls off `0x2E`, `0x27` and `0x2F` on purpose — `param-codec.ts` is read-only _by construction_. `scripts/beam-threshold.ts` deliberately crosses that line, same footing as `scripts/headlight-off.ts` and `probe-charge-stop.ts`. It is a scratch probe, not shipped: it always reads back and re-checks the live draw, and `--restore` is first-class precisely because the write is persistent. This doc records how the lights are controlled; it does not implement it in the app.
