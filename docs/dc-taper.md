# The DC taper, and what the pack does above 80 % SOC

Measurements behind `src/charge/soc.ts` and the session-ahead veto in `src/charge/auto-curve.ts`. Everything here comes from one decrypted ride log covering **2026-09-07 → 2026-09-13**, which is the whole field record of the v2 controller plus the three pre-controller stops of 09-07.

Provenance: `~/Documents/cool-eva-route/data/ride-logs/cool-eva-2026-09-13.celog`, a full dump rather than a day file — 74.4 M readings from 40 563 segments, of which **126 could not be decrypted and are lost** (0.31 %). Decrypt it with `scripts/decrypt-log.ts --out evidence/scratch-2026-09-13.db`; `evidence/*.db*` is gitignored.

⚠️ **That recipe on its own gives you half of it.** Re-run for #235, the 09-13 file alone rebuilds to **39 258 150 readings from 21 255 segments, 63 lost** — the counts above are the 09-12 and 09-13 dumps together, so decrypt both if you want to reproduce them. It also reaches back further than the heading says: rows start 2026-08-02. The DC data is still 09-07 → 09-13 — `fast_dc_target_a` does appear on 08-26, 08-27, 09-06 and 09-08, but every one of those ten rows reads **0**, so none of them is a session. And it needs `--max-old-space-size`: `decrypt-log.ts` holds a whole file's readings in one array and dies with a V8 OOM at the default heap.

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

## The first SOC sample, and why it is a crossing

`estimateSocRate` returns a **lower** bound because every sample in the ring is a **crossing instant** — the moment the reading _became_ that value — so between the oldest in-window sample and now the pack advanced at least `newest − oldest` points. Break that and the estimate over-states, which shortens the horizon and suppresses more steps down. Two things could break it, and this section is what #235 measured before deciding not to guard either.

### The first-ever reading, which is not a crossing

`record()` notifies when `prev === undefined` (`src/can/signals.ts`), so a process's **first-ever** `soc` reading is delivered as a change even though nothing crossed. If `rememberSoc` kept it, the span measured from it would be shorter than the span the pack actually spent advancing.

What keeps it out is an ordering, not a guard: `src/index.ts` runs `channel.start()`, then `await loadStaticFiles(join(ROOT, "public"))`, and only then `startChargeAutomatic` — and that middle call is a **serial** `await readFile(path)` per file under `public/` (`loadStaticFiles` in `src/http/static.ts`). The channel therefore records a `soc` long before the controller subscribes, and the first change the controller sees is a real crossing.

Measured over the whole log, with `charge_auto_mode` as the subscribe instant — in the **enabled** branch `publishMode` is the third statement after `onChange(...)` and the two between it (`setInterval`, `unref`) record nothing, so the row is that instant to within a microsecond. ⚠️ The **disabled** branch records the same signal with no listener at all (the `record` under `if (options.enabled === false)`), which is 1 of the 77 lives. Line numbers are deliberately not quoted here: the ones in an earlier draft of this section were stale before it was committed, because the commit that added the ⚠️ to `src/index.ts` moved the call it cited. Grep for `const chargeAutomatic = startChargeAutomatic`:

|  |  |
| --- | --- |
| named process lives carrying a `soc` row | **146** (147 named sessions exist, one has none) |
| lives that started the controller | **77** |
| lives where `soc`'s first record came **before** the subscribe | **77 of 77** |
| margin | **530-1282 ms, median 672** |
| lives that began **inside a DC session** | **3** — 09-12 09:45 at 42 %, 09:48 at 47 %, 09:52 at 53 % |
| …of those, where the listener saw the first `soc` record | **0** (margins 668, 667, 668 ms) |

`soc`'s own first row lands 14-440 ms after its life's first logged row, and `0x200` is 20 Hz, so the bus would have to go silent for over half a second at start-up for this to invert.

⚠️ **The ordering is evidence, the milliseconds are not.** `ts` is `Date.now()` and this Pi steps its own clock, which is why durations elsewhere in this repo use `monotonicNow()`. The **ordering** conclusion rests on `seq`, the per-life write counter, not on the stamps; the 530-1282 ms range is quoted because its tightness across 77 independent boots is itself the evidence that no clock step landed inside one. (`min(seq) = 0` for all 147 named sessions, so none of the 63 unreadable segments removed a life's opening rows.)

⚠️ **So this is "not reached on the shipped start-up ordering", not "unreachable".** Three ordinary changes would remove the margin silently: making `loadStaticFiles` concurrent, a smaller `public/`, or moving the `startChargeAutomatic` call above it. None would fail a check. `src/index.ts` therefore carries a ⚠️ at the call site, and `rememberSoc` says so **in the journal** when it does keep such a sample rather than guarding against it — #222 already carries two guards it had to document as unreachable, and a third would be worse than a line of prose that fires.

### A downward crossing, which sits a point high

Falling through a whole percent puts the sample at `p + 1` rather than at `p`, so a ring that dips and then climbs over-states the same way. It does not happen here: **304 of 304** consecutive `soc` pairs inside a DC session are exactly **+1** — no jump of two, and no step down, at any SOC (237 of them below the 88 % knee; 5 pairs spanning a restart excluded, since a life's first row is logged unconditionally). Gaps between those 304 crossings run **25.3 s min, 28.2 s p10, 40.1 s median, 100.0 s p90, 407.2 s max** — so the p10 gap is 2.13 %/min, the median 1.50 and the p90 0.60, which is where `scripts/soc-trajectory.ts`'s constant rate comes from. ⚠️ The below-88 census of 237 pairs is a **different population** with a 36.2 s median and a 1.66 %/min median rate; quote one or the other, never a gap from one beside a rate from the other.

A DC session is cut here as a run of `fast_dc_target_a > 0` rows no more than 10 min apart, which is coarser than the `pack_a` segmentation at the top of this file. The census is insensitive to that: both rows of every pair counted lie inside one run, and the alternative cut changes which sub-minute handshake blips count as a session, not which crossings are `+1`.

### What either one would cost

At most **one whole count over the claimed span**: the reading can be a point behind the true SOC and no more. With `SOC_MIN_SPAN_MS` at five minutes that is **0.2 %/min**, 12 % of the median rate. `scripts/check-soc-rate.ts` §3 asserts that bound on rings built to break the precondition, and asserts they really do over-state — a probe that stopped constructing the case would otherwise pass quietly.

### Two paths into the ring that the start-up argument does not cover

⚠️ `record()` updates `lastLogged` **before** it notifies, and the plausibility gate is downstream in `rememberSoc`. So an out-of-range reading (`0xFF`) is rejected with a warn — and the _next_ reading, unchanged, is now a change against `lastLogged = 255`, is notified, and enters the ring without a crossing behind it. **Bounded** by the same one count. The journal line covers it only at the start: `firstSocMayNotBeACrossing` tests `isSocPlausible(latestValue("soc"))`, so a garbled byte recorded before the controller subscribed still counts as "nothing usable on record" and the line fires — but the flag is one-shot, so the same thing happening in the middle of a session is silent.

⚠️ **An in-range glitch is unbounded and nothing catches it.** `isSocPlausible` accepts anything in 0-100 with no rate gate, so a garbled byte of 20 during a 60 % charge enters the ring directly; as the oldest in-window sample it yields `(61 − 20) / 10 min = 4.1 %/min`. Not observed — every `soc` row in this log is an integer in 9-100, and the 304-for-304 census says the signal does not jump — but it is a real hole in the "lower bound, and an exact one" claim and it is not the one #235 was about.

## What the session-ahead veto changes, tick by tick

Driving the real `decideChargeCurrent` over each session's logged rings, with the commanded current the controller actually held at each tick, rings cut at `session_id` edges:

**519 ticks · 502 identical · 17 where the veto condition holds · 12 that change a commanded current · 0 in any session that reached 55 °C.**

Every one of the seventeen is in a session that peaked at 47, 50 or 50 °C, and the earliest are at **SOC 70-79** — below any threshold a flat SOC gate would have had.

⚠️ **Open-loop.** These say what the rule would have _decided_ seeing that history, never what would have _happened_: a different current changes the pack's trajectory and the log cannot say how. The closed-loop half is `scripts/check-charge-auto.ts` §18.
