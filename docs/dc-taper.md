# The DC taper, and what the pack does above 80 % SOC

Measurements behind `src/charge/soc.ts` and the session-ahead veto in `src/charge/auto-curve.ts`. Everything here comes from one decrypted ride log covering **2026-09-07 → 2026-09-13**, which is the whole field record of the v2 controller plus the three pre-controller stops of 09-07.

Provenance: `~/Documents/cool-eva-route/data/ride-logs/cool-eva-2026-09-13.celog`, a full dump rather than a day file — 74.4 M readings from 40 563 segments, of which **126 could not be decrypted and are lost** (0.31 %). Decrypt it with `scripts/decrypt-log.ts --out evidence/scratch-2026-09-13.db`; `evidence/*.db*` is gitignored.

## How a session is found, and two ways to get it wrong

Both of these produced published numbers that had to be withdrawn, so they are written down rather than left as method.

⚠️ **`pack_a > 1` is not a DC session.** It is current _into_ the pack, which is also an AC trickle and every downhill's regen. An early pass counted a 9½-hour overnight AC charge and several descents as DC stops, which pulled the "mean heating rate" of every SOC band towards zero. A span is a DC session only if a `fast_dc_target_a > 0` **row** falls inside it — tested against rows, so no forward fill can carry one in from the session before.

⚠️ **A forward fill needs a session boundary, and a staleness limit must not be applied to a log-on-change signal.** Filling across an unplug spread a 75 A request over a later session. Then guarding it with a 120 s staleness limit deleted `fast_dc_limit_a` outright — it is written once at 80 A and never again — which silently emptied the free-current table. The working shape: segment on `pack_a` alone (20 Hz, genuinely dense, 120 s limit), then inside each session fill every other key from empty with no limit.

⚠️ **And the crossing instant is a row, not a grid point.** On 2026-09-10 `soc` first reads 80 at 10:50:04, when `batt_temp_hi` had read 44 for 111 s; 45 arrives 24 s later. A 30 s grid takes the 45 and reports the session's rise after 80 % as +2 K when it is **+3**.

That leaves **15 DC sessions**.

## The taper envelope

`fast_dc_target_a` (`0x615` b2) is what the vehicle asks the station for — a request, not a readback: `docs/charge-manager.md` establishes it leads the delivered current by 0.03-2.40 s in all eight captured ramps, with r = +0.9951 against `pack_a`.

⚠️ **The envelope is a MAXIMUM, so the filter is loose on purpose.** A tick where the station or the controller was holding the current down can only pull a value _down_, never up. Screening for "nothing was binding" therefore discards evidence in the unsafe direction — and understating the envelope makes the taper look as if it bites earlier than it does, which shortens the horizon and suppresses more steps down. The filter is: every tick of a DC session with the pack under 55 °C (the cliff's own 19.5 A saw-tooth is not a taper).

| SOC                      | ≤ 87 | 88  | 89  | 90  | 91  | 92  | 93  | 94  | 95  | 96  | 97  | 98  | 99  | 100 |
| ------------------------ | ---- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **loose (shipped)**      | 73   | 70  | 65  | 62  | 60  | 58  | 53  | 49  | 45  | 41  | 37  | 32  | 29  | 5   |
| strict "nothing binding" | 73   | 70  | 65  | 62  | 56  | 55  | 51  | 47  | 43  | 41  | 36  | 32  | 29  | —   |
| sessions contributing    | 8-10 | 8   | 8   | 8   | 8   | 7   | 7   | 7   | 7   | 6   | 5   | 5   | 5   | 1   |

The strict filter is **1-5 A low at SOC 91-97**, and the bite point moves one SOC point later at 60 A and at 45 A under the loose one. `src/charge/soc.ts` carries the loose row, made monotone from the top.

**`≤ 87 → 75` is a deliberate pad.** The data says 73 across 8-10 sessions there; padding _up_ makes the taper look further away, which lengthens the horizon and suppresses fewer steps.

### ⚠️ The 73 A cap is not a law any more

`docs/charge-manager.md` § `0x615` b2 states the request "reads 73 in 30 265 frames and has never once read 74 or 75, across all 941 765 frames". **This log supersedes that.** `fast_dc_target_a` reads 74 once and 75 twice, and both 75s are _held_ rather than ramp transients:

- **2026-09-12 09:37:33 → 09:44:00, 6.4 min at 75 A**, with `pack_a` at 74.7-75.0 A throughout.
- **2026-09-13 17:07:02 → 17:11:50, 4.8 min at 75 A.**

Both at a station whose `fast_dc_limit_max_a` read 80 rather than the usual 75. Nothing in the controller hardcodes a vehicle cap, and nothing should.

### Open: the station-power confound

`docs/charge-manager.md` shows the request is very close to `min(73, round(0x620 b3 × 1000 / 348))` whenever the station's power is what binds. `0x620` b3 is not decoded here, so a taper attributed to the pack could in part be a station ramping its own output down. The envelope is a maximum across many sessions and several chargers, which blunts this, and the rule it feeds can only ever _suppress_ a reduction — but it is not eliminated, and a session at a single charger should not be read as a pack measurement.

## What the pack does thermally, by SOC

637 overlapping 8-minute windows, `batt_temp_hi` only, windows touching 55 °C excluded.

| SOC band | windows | mean dT/dt | worst dT/dt | hottest start |
| -------- | ------- | ---------- | ----------- | ------------- |
| 30-60 %  | 176     | +0.420     | **+1.125**  | 54            |
| 60-75 %  | 121     | +0.271     | +0.750      | 54            |
| 75-80 %  | 41      | +0.143     | +0.500      | 54            |
| 80-85 %  | 49      | +0.041     | +0.250      | 54            |
| 85-90 %  | 37      | −0.017     | +0.125      | 54            |
| 90-95 %  | 49      | −0.072     | **0.000**   | 54            |
| 95-100 % | 144     | −0.120     | 0.000       | 54            |

Of the 279 windows at SOC ≥ 80, **18 heat at all**; the worst five are +0.250 K/min and every one of those is at 43-45 °C.

### ⚠️ The gap that killed the first design, and it is the important part of this file

A first plan for #201 proposed "above 80 % SOC, never step down below the setpoint", on the strength of the table above. Split the same band by how much was actually flowing and the evidence evaporates:

```
SOC >= 80, reading >= 47 °C,  0-45 A : n=155  worst  0.000 K/min   (max 45.0 A)
SOC >= 80, reading >= 47 °C, 45-60 A : n= 21  worst +0.125 K/min   (max 58.7 A)
SOC >= 80, reading >= 47 °C, 60-80 A : NONE
```

**There is no window in the corpus with SOC ≥ 80, a reading of 47 °C or above, and more than 58.7 A flowing.** Every time this pack has been high _and_ hot, either the controller or the taper had already brought the current under 60 A. A flat SOC threshold would have licensed 73 A in a regime that has never been observed, and no amount of moving the threshold fixes that — which is why the shipped rule has no SOC threshold at all and instead only ever _suppresses_ a reduction the shipped law had already decided on.

## The rise from crossing 80 % SOC to the end of the session

Measured from the exact `soc` row, not a grid point.

| session     | T at crossing | peak after | rise   | minutes | max A after | controller at the crossing |
| ----------- | ------------- | ---------- | ------ | ------- | ----------- | -------------------------- |
| 09-07 14:06 | 54            | 55         | +1     | 6.0     | 73.2        | off                        |
| 09-07 16:22 | 54            | 55         | +1     | 13.7    | 67.7        | off                        |
| 09-09 10:31 | 54            | 55         | +1     | 30.7    | 64.8        | throttling (65 A)          |
| 09-09 14:02 | 54            | 54         | 0      | 11.2    | 72.6        | throttling (35 A)          |
| 09-10 10:47 | 44            | 47         | **+3** | 33.9    | 74.0        | on, nothing commanded      |
| 09-10 16:17 | 54            | 54         | 0      | 0.7     | 35.0        | throttling (35 A)          |
| 09-10 16:59 | 52            | 52         | 0      | 8.3     | 32.0        | off                        |
| 09-11 11:01 | 54            | 54         | 0      | 34.0    | 34.8        | throttling (35 A)          |
| 09-12 09:43 | 49            | 50         | +1     | 28.4    | 72.6        | throttling (71 A)          |
| 09-13 12:04 | 49            | 50         | +1     | 17.8    | 69.7        | throttling (68 A)          |
| 09-13 17:07 | 43            | 45         | +2     | 37.6    | 72.8        | on, nothing commanded      |

⚠️ **Read the last column before the rise.** The two rows crossing at 49 °C were both being actively throttled at the crossing, so they are not evidence about what full current would have done. The only unthrottled crossings below the setpoint are at 43, 44 and 52 °C. Every session that reached 55 was **already reading 54** when it crossed 80 %.

## The two field reports, in the log

### 2026-09-13 12:04 — nrg AVIN 4052, the second report

Arrived 60 % / 44 °C; the station advertised `fast_dc_limit_max_a` = **80 A**.

| tick | SOC | `batt_temp_hi` | asking | v2 reason | v2 commanded |
| --- | --- | --- | --- | --- | --- |
| 12:04:44 | 60 | 44 | 73 | NO_HISTORY | — |
| **12:11:44** | 75 | **48** | 73 | CLOSING | **76** |
| 12:12:44 | 77 | 49 | 73 | CLOSING | 70 |
| 12:13:44 | 79 | 49 | 71 | CLOSING | 68 |
| 12:14:44 | 80 | 49 | 69 | CLEAR | 70 |
| 12:15:44 | 82 | 50 | 66 | CLOSING | 64 |
| 12:19:44 | 84 | 50 | 60 | CLOSING | 59 |
| 12:19:54 | 84 | 50 | 60 | — | Daniel switched it off |
| 12:21 → 12:32 | 86 → 95 | **50, 50, 50, 50, 50, 50, 50, 49, 49, 49, 49** | 52 → 18 | off | — |

Three things fall out of the last twelve minutes:

1. **Unthrottled from 84 % at 50 °C, the pack did not gain a degree** — it sat at 50 for eight minutes and then cooled, with the ceiling back at 80 A.
2. **The first command was inert.** v2 steps from `commandedAmps ?? ceiling` = 80, so "76 A" was a step down into a current the vehicle was not asking for; it asked 73 before and after.
3. `CLOSING` fired at a reading of **48**. 49 arrives four seconds later, at 12:11:48.

Rings from this session are the fixtures in `scripts/charge-auto-episode.ts` (`SEPTEMBER_13_*`), and `scripts/check-charge-auto.ts` §16 asserts the veto suppresses exactly these ticks.

### The same shape, twice more

**2026-09-12 09:43** — throttled 78 → 76 → 71 → 64 → 57 → 55 from 74 % at 47-50 °C, `CLOSING` again first firing at a reading of 48 (10:05:58). Switched off at 10:11:49 at 86 %; the pack then **held exactly 50 °C for fifteen minutes at up to 73 A** and ended at 47.

**2026-09-10 16:59** — switched off at 92 % / 53 °C; the pack cooled to 51.

### ⚠️ 2026-09-11, and what "correct v2" costs

Two DC sessions, 10:17-10:57 (28 → 73 %) and 11:01-11:43 (74 → 100 %). The second spent **34 minutes at the 35 A floor**, reason `NEAR_CEILING`, from 74 % SOC to full.

This is **not** an argument for any change here, and it must not be quoted as one. The pack read 54 throughout, which is where every rule in `src/charge/auto-curve.ts` is supposed to act — and it reached 55 anyway, at **11:02:33**, with `pack_a` collapsing to 19.8 A. It is recorded because it is the price tag of the controller working as designed, and it is why the session-ahead veto is inert at and above the setpoint.

Two corrections about that session, both of which were published wrong before being checked:

- It is **not one session**: DC delivery stopped at 10:56:23 and resumed at 11:00:31.
- The gap is **neither a plug-out nor a continuous session**. `charge_manager_state` never left `0x23`, so `forgetSession()` did not run — but `session_id` steps 106 → 107 across it, which is a **service restart**: the process died and took the ring with it, and `BLIND_DESCENT` at 11:00:59 proves the ring was empty. There are around a hundred restarts in the week, several of them inside DC sessions. ⚠️ **Any replay over this log must cut its rings at `session_id` edges as well as at delivery gaps**, or it replays a history the controller never had.

## A negative result, so nobody re-derives it

⚠️ **`allowed_regen_a` — the BMS's own charge-current limit — reads 0 for the entire DC session**, and only comes back (80 A) after the plug is pulled. The DC path bypasses the BMS, so the obvious "ask the pack what it will accept" signal does not exist on this bus. `fast_dc_target_a` is the only witness.

⚠️ **`bms_remaining_energy_wh` did not arrive in any of these sessions**, so a remaining-energy route to "how long is left" is not available either. The SOC rate is what there is.

## What the session-ahead veto changes, tick by tick

Driving the real `decideChargeCurrent` over each session's logged rings, with the commanded current the controller actually held at each tick, rings cut at `session_id` edges:

**519 ticks · 502 identical · 17 where the veto condition holds · 12 that change a commanded current · 0 in any session that reached 55 °C.**

Every one of the seventeen is in a session that peaked at 47, 50 or 50 °C, and the earliest are at **SOC 70-79** — below any threshold a flat SOC gate would have had.

⚠️ **Open-loop.** These say what the rule would have _decided_ seeing that history, never what would have _happened_: a different current changes the pack's trajectory and the log cannot say how. The closed-loop half is `scripts/check-charge-auto.ts` §18.
