# Lifetime battery statistics

The VCU keeps statistics covering the whole life of the pack — charge counts, cumulative charge, average temperature, state of health — and **nothing broadcasts them**. They come only from a freeze-frame read over KWP, so they are not a log-on-change signal and never can be. `obd-garage/DC_CHARGE_LIMITS.md` §10.6 proves the negative twice: a complete DC session on the bus with no counter stepping, and a cross-boot comparison in which none of the four moves.

Issue #56 named where they live and #156 asked for them on screen. This is what they mean, what is settled, and what is not.

## The two readings this repo has

|  | 2026-08-08 | 2026-09-08 |
| --- | --- | --- |
| source | `capture-20260808-182129`, a passive recording of the factory tool's own session | `read-freeze-frame.ts --lifetime`, ours |
| fixture | `scripts/captured-freeze-frames.ts` | `scripts/captured-lifetime-reads.ts` |
| `V_ODOMETER` | 17 472.9 km | 18 440.5 km |
| `B_SOH` | 100 % | 100 % |
| `B_AVG_CELL` / min / max | 3510 / 3485 / 3528 mV at 19 % SOC | 4226 / 4219 / 4239 mV at 99 % SOC |
| `TotalExchangedAh` raw | 624 512 | 658 112 |
| `CompletedCharges` | 946 | 1018 |
| `CompletedACCharges` | 901 | 969 |
| `CompletedDCCharges` | 14 | 17 |
| `AvgBattTemp` | 33.0 °C | 29.4 °C |
| `AvgDOD` raw | 2875 | 25 658 |
| trailing byte | `FF` | `05` |

**967.6 km apart**, and that is what makes the rest of this document possible. One reading of a counter says nothing about its scale; two say a great deal.

⚠️ The values quoted in #56's comment as coming off the dealer software's display — 62 451,2 Ah, 946 / 901 / 14, 33 °C, 17 472,9 km — **are the 2026-08-08 reading**. They are not an independent second source. That matters twice below.

**And the 2026-08-08 fixture is this bike, at that instant, confirmed off the bus.** `rides.db` has `odometer_can_km` reaching exactly **17 472.9** at 16:21:28 UTC and not moving again until 19:44:16; the capture is timestamped 18:21:29 CEST = 16:21:29 UTC, one second after it settled. The broadcast odometer and the freeze frame agree to the last digit at the same moment, on a bike parked 3 h 23 m around it.

## `TotalExchangedAh` — the scaling is refused, and why

Energica's own equation for infokey 80 is `f(x)=x*0.1`, and their tool applies it: the 2026-08-08 raw of 624 512 is what produced the "62 451,2 Ah" on the dealer screen. **This repo does not apply it**, and `src/diagnostics/infokey-table.ts` records the refusal on the field itself.

### Why ×0.1 is impossible

Between the two readings the counter advanced **33 600 raw over 967.6 km**. At ×0.1 that is 3360 Ah, or **3.47 Ah/km**.

This bike's own log says otherwise. Summing monotone runs of `remaining_ah` over the same window, ignoring reversals below a threshold to keep log-on-change jitter out:

| reversal filter | discharged | charged | Ah/km |
| --------------- | ---------- | ------- | ----- |
| 0.2 Ah          | 462.0      | 469.1   | 0.472 |
| 1.0 Ah          | 456.0      | 463.1   | 0.463 |
| 5.0 Ah          | 434.7      | 445.4   | 0.441 |

**~0.47 Ah/km of gross pack throughput**, barely moving with the filter and the same in both directions.

⚠️ Only the top row is implementation-independent. A reviewer repeating this with their own reversal filter got 0.473 at 0.2 Ah — the headline — but 0.423 and 0.405 where the table says 0.463 and 0.441, because "ignore reversals below X" admits more than one reasonable definition. The 7.4× does not depend on which. ×0.1 claims **7.4× more charge than the pack actually moved**. That is not a judgement about a plausible consumption figure; it is more amp-hours than this bike's own logged pack current delivered over the same kilometres.

⚠️ **This measurement cannot be re-derived by any check.** `rides.db` is not in the repo and never will be. `scripts/check-lifetime-stats.ts` carries the 0.472 as a constant pointing here; this document is the primary evidence.

The query, so it can be repeated:

```sql
-- window: from the first odometer sample >= 17472.9 km to the end of the log
select ts, value from reading r join signal s on s.id = r.signal_id
where s.key in ('remaining_ah', 'odometer_can_km') order by ts;
```

Two cautions for anyone repeating it. The Pi steps its own wall clock, so a handful of rows carry timestamps in 2060 — drop anything outside the window's own months. And `rowid` order is **not** chronological here: the null-session rows interleave with sessions 1-50.

### Why ×0.01 is not verified either

Solving for the scale needs the counter's semantics, and those are unknown. Splitting the same up-moves by `speed_kmh` and cross-checking by integrating `pack_a` puts regen at **~65-90 Ah**, about 17 % of traction draw — so what a charger actually delivered over the window is **~370-395 Ah**, and that is an upper bound, since `speed_kmh` is log-on-change and misclassifies some traction as stopped.

Against 33 600 raw:

| what the counter might count | measured Ah | implied scale | ×0.01 says 336 Ah | ÷64 says 525 Ah |
| ---------------------------- | ----------- | ------------- | ----------------- | --------------- |
| one direction of throughput  | ~460        | 0.0137        | −27 %             | +14 %           |
| what the charger put in      | ~370-395    | 0.0110-0.0118 | **−9 to −15 %**   | +33 to +42 %    |
| both directions summed       | ~920        | 0.0274        | −63 %             | −43 %           |

**Two unknowns multiply — the scale and the semantics — and the data does not separate them.** ×0.01 is the roundest member of a band about 0.008 to 0.027 wide; against the likeliest semantics it fits roughly three times better than ÷64, and there is still a 10-15 % residual nobody can explain. That is not a decode. `AvgDOD` is refused for less.

### The ÷64 reading, and how firmly to hold it

Both raws are exact multiples of 64, and so is the advance. Under a uniform model that is about 1 in 4096 — on **n = 2**. ⚠️ The advance is _implied_ by the two values, not independent of them; it is asserted in the check because a third reading would break it for free, not because it is a third observation.

The coherent framing is `raw = count << 6`: the low six bits are structurally zero and the meaningful quantity is `raw / 64`, which makes the counter tick in whole amp-hours. The tempting alternative — "the LSB is 1/64 Ah" — is refuted by the very observation that suggests it, since a 1/64-Ah accumulator would land on arbitrary values.

**The refusal does not rest on this.** ×0.1 was already impossible and ×0.01 already unverified before anyone noticed the multiples of 64. If a third reading kills ÷64, the scaling stays refused.

### What is shown on screen

The raw count, with both candidates in the units a rider can weigh — full packs, and kilometres per pack, against a `remaining_ah` ceiling measured at **64.0 Ah** on this bike:

```
charge moved   658 112 raw
               ≈6581 Ah at ×0.01 — ≈103 full packs, ≈179 km each
               ≈10283 Ah at ÷64 — ≈161 full packs, ≈115 km each
               Energica's own ×0.1 would be ≈65811 Ah — ≈1028 full packs, ≈18 km each …
```

### What would settle it

**Two reads of component 52 bracketing a single charge session**, with the Pi logging through it. The delta against that one session's measured amp-hours gives the scale _and_ the semantics at once, which is the pair that currently multiplies. It would also test the multiples-of-64 reading for free: the delta should be a multiple of 64.

Today that means two service stops, since the read needs the script (below). An in-service read would make it a two-tap operation from the phone — which is the argument for #156's second half.

## The charge counters

969 AC + 17 DC = 986 against a total of 1018. The 32 that classify as neither are **not a decode fault**, and the two readings are what show it: the residue was **31** on 2026-08-08 and **32** on 2026-09-08, so it grew by exactly one while 71 of 72 new charges classified normally. A slow, small category — aborted sessions, or charges from before the subtotals existed. Not identified.

All four numbers are shown. Three that visibly fail to add up read as a bug in cool-eva rather than a fact about the bike.

**On 1018 being a lot for a 64 Ah pack.** 68 AC increments in the month between the two readings, over 967.6 km — one every 14 km. The likeliest reading is that the AC counter counts **charger cycles rather than plug-ins**: a bike left plugged in at home tops up, rests and re-charges. 🟡 The log is _consistent_ with that and does not settle it — in the same window `charger_enabled` rose 43 times against `bms_state_charge` rising 28, so the charger does cycle more often than the pack enters charge, but the Pi is not awake for every charge, so neither count is complete.

## `AvgDOD` — refused, with one candidate named

Energica's equation is `f(x)=x@&255`, which is not arithmetic in any language. `src/diagnostics/infokey-table.ts` refuses it for every field, and this is the only field that uses it. Two readings people reach for:

|                | 2026-08-08 (raw 2875) | 2026-09-08 (raw 25 658) |
| -------------- | --------------------- | ----------------------- |
| `x & 255`      | **59**                | **58**                  |
| `x >> 8 & 255` | 11                    | 100                     |

An average over ~1000 charges moving by one point in a month is what an average does; 11 → 100 is not. **And Energica's own tool rendered the first one as 59 %** — the #56 comment is dated 2026-08-16, four days before the fixture holding raw 2875 landed in this repo (`7d38404`, #99), and this repo's decoder has never emitted 59 for that field. So the tool screen is an independent witness, not our own arithmetic coming back to us.

Still shown as a candidate rather than a decode: the high byte (11 → 100) is unexplained under either reading.

## `AvgBattTemp` is not a lifetime average

33.0 °C → 29.4 °C across 72 charges. For a cumulative mean over the 946 charges before it, those 72 would have to average **−17.9 °C**, and it gets more absurd for a larger prior count. It tracks the season instead. Labelled "a recent average, not a lifetime one" on screen, next to counters that genuinely are lifetime ones.

## The trailing byte

Every `0x17` reply carries one byte after the fields. It counts **cycles since the record was stored**: five components advanced by exactly +1 across one interval with every other byte of the payload frozen, so it moves at most once per cycle and is not a count of how often the fault happened.

⚠️ **What a "cycle" is remains unresolved.** That interval held _both_ a VCU reset (`ECUReset 11 02`) and a key-off/key-on, and the counters moved **+1, not +2** — so either a reset does not count or the two collapsed into one. Until a reset with no key cycle around it separates them, "cycle" means at least one of those two things happened.

⚠️ **Not an OBD aging counter.** Those count fault-_free_ cycles and reset on recurrence. `P0A07` is permanently present on this bike — the coolant pump is wired to the heated-grip output, so its driver sits open — and its byte climbs anyway.

⚠️ **No ceiling has been observed.** It read `FF` on all 29 replies captured before the clear at the end of the 2026-08-08 capture — `14 FF FF` at 19:04:28.391939, the only one in the archive, and small counts after; that `FF` was inferred to be a ceiling, never watched being reached, and no record has been seen ageing out. `docs/diagnostics-and-checks.md` has the evidence.

It stays outside every field. The check asserts each reply is header + shortlist + exactly one byte, so dropping it from the arithmetic makes all four wrong by one.

## Component 60 — `P1052 BATTERY STATISTICS INFO3`

The third of the trio #56 names, and it carries nothing. Its shortlist is empty in Energica's own data (`src/diagnostics/fault-infokeys.ts`) and the bike agrees: the 2026-09-08 reply is a Single Frame, `57 01 00 3C 05 05` — header, trailing byte, no fields. A decode result, not a gap. It is not read by this feature.

## `57 00` — no stored record

Component 54 answered two bytes, `57 00`: the micro saying it has nothing on file for that component. Its frames are timestamped 13:16, two minutes before the capture file that holds components 53 and 60 opened — 54 is not in that batch (`for c in 51 52 53 60`), so the reading that fits is that it came from the capture still running before `read-freeze-frame.ts` bounced the interface, i.e. from the file #160 is about losing. An inference: the reporting session named a file for 53 and 60 and not for this one. Not a refusal and not a third outcome. ⚠️ `src/diagnostics/freeze-frame.ts` files it under `unrecognised` because it is shorter than the 5-byte header — the bytes are kept, but the meaning is not named. Naming it is a change to that decoder's outcome union and belongs with the freeze-frame channel rather than with this feature.

## How a reading is taken

```
sudo systemctl stop cool-eva
node --experimental-strip-types scripts/read-freeze-frame.ts --lifetime --save
sudo systemctl start cool-eva
```

`--save` writes `vcu-params/lifetime.json`, which `GET /lifetime-stats` serves and the All tab shows with the age of the reading.

⚠️ **`can0` has to be up ACTIVE, and on this Pi it normally already is.** The bring-up is deliberately not repeated here, because the instruction that matters is _read the link before typing anything_: stopping the service does not take the interface down, so on an `OBD_ENABLED=1` Pi the three `ip link` commands are unnecessary — and running them anyway kills every other socket on the bus, which is how the frames for this feature's own first read were lost. The commands, and how to tell ACTIVE from listen-only (it is the **absence** of `LISTEN-ONLY`, not a field that says so): `docs/diagnostics-and-checks.md` §13 and `docs/can-capture.md`.

⚠️ **The stop is for socket ownership, not because the bike refuses.** Two testers on one bus are resolved by whichever frame lands first — these micros answer on one id with no request tag — and the script opens its own socket while the service holds one. Whether the _service itself_, as the single tester, can run this read in-process is #156's second half.

⚠️ **Do not bounce the link if the frames matter.** That is how the 2026-09-08 frames for components 51 and 52 were lost: the interface went down, the capture unit's `Restart=on-failure` / `RestartSec=5` opened a new file five seconds later, and the two reads fell in the hole. Issues #160 and #171. ⚠️ **The "start an independent `candump` first" workaround that used to stand here is retired**: since `candump -D` the capture rides through a bounce in the same file, so a second capture would only duplicate it. What a bounce still costs is the time the interface is actually down — nothing can capture through that — so the advice not to bounce stands on its own. `docs/can-capture.md`.

## Reading it in-service

`POST /lifetime-read` reads components 51 and 52 from inside the running service, behind the same gate and the same single-flight as a parameter sweep, and stores what comes back. The stopped-service script still works and writes the same file; this is the same read, shared (`src/vcu/lifetime-read.ts`), not a second one.

### Why the service can be the tester

The script needs the stop for **socket ownership** — two testers on one bus, answered on one id with no request tag. When the service is the single tester that reason is gone, and the transport was built for it: `src/vcu/multiframe-transfer.ts` is documented as safe to call straight off the CAN listener, and `src/can/obd-dtc.ts` already answers a First Frame from inside the frame handler in production, today, for OBD mode 03.

### The poller is parked, and that is the point

The 2 Hz OBD poller is **not** under `src/vcu/bus-lease.ts` and cannot be — the lease is per operation and that loop runs forever. It is also the documented cause of this channel's 25-70 % completion rate: `docs/can-decode-findings.md:1196` measures it sharing the bus and `:1206` has the tell — a completed transfer had **zero** mode-01 replies interleaved and a failed one **50+**.

So `holdObdPoller` parks it, and parking it is not merely hazard mitigation: it is what gives an in-service read the quiet bus (of _our_ traffic — the bike's own broadcasts are still there) that a stopped-service script gets for free.

- **An acknowledgement, not a flag.** It resolves only once the loop has parked, because a boolean set from an HTTP handler cannot unwind a trouble-code transfer four retries deep.
- **Parked at three points** — the top of the loop, between PIDs, and between the three trouble-code modes. Every one of those calls is awaited and `obd-dtc.ts` settles before resolving, so "parked" implies nothing of ours is in flight at each of them. That keeps the worst wait at one mode's **3.98 s** rather than a whole round's 14.2, and the common case at one PID timeout, since 119 rounds in 120 are PIDs only.
- **Fail-safe.** A loop that never parks means the hold times out and the read is refused. There is no arrangement in which it falsely grants a busy bus.
- ⚠️ **And the hold is capped by the loop, not by the holder.** A leaked hold would take speed, rpm, the temperatures, the 12 V rail, the trip counters and the whole stored-DTC list off the dashboard **and out of the log**, with a healthy-looking journal, on a bike parked where there is no reception. That is worse than anything the hold prevents, so the poller resumes on its own past the cap and says so.

### What it measures about itself, and why the obvious instrument is worthless

The question this path exists to settle is whether the service's listener can answer a First Frame in time. That is a property of this process's event loop, and **a timestamp taken inside the frame handler cannot see it** — the handler runs after libuv has already delayed it, so a `monotonicNow()` pair there brackets our own arithmetic and reads tens of microseconds under every load, including the loads where the loop is the problem. It would print `0.04 ms` and be written down here as proof.

Two instruments instead, both stored, neither trusted alone:

|                                          | what it sees         | needs                                              |
| ---------------------------------------- | -------------------- | -------------------------------------------------- |
| **kernel arrival → our flow control**    | the real number      | the kernel's own stamp, `src/can/frame-arrival.ts` |
| **worst event-loop delay over the read** | an independent bound | nothing threaded anywhere — `perf_hooks`           |

The kernel has been stamping every frame all along: `src/can/socket.ts` opens the channel with receive timestamps on and `src/types.d.ts` declares `ts_sec`/`ts_usec`. Nothing read them until this.

⚠️ **The stamp is `CLOCK_REALTIME`** — the clock `src/gps/clock.ts` steps with `date -u -s`, because this Pi has no RTC. So this is the one duration in the repo deliberately not taken with `monotonicNow()`, and `arrivalLatencyMs` refuses rather than answers when the result is negative or over five seconds. A clock step during a ~100 ms read is vanishingly unlikely; a silent −40-minute flow-control gap in this document is not a risk worth carrying.

⚠️ **And an absent stamp is not zero.** Nothing has ever read these fields and no laptop can verify this build of `socketcan` populates them, so a missing stamp is reported as _"the kernel supplied no arrival timestamp"_ — never as `0.0 ms`, which is exactly what success would look like. **The first thing to check on the first real run is that the number is not that.**

### What is proven, and what the first run has to answer

`scripts/check-lifetime-read.ts` drives the whole read against `scripts/simulated-vcu-micro.ts` — session, request, First Frame, our flow control, Consecutive Frames, reassembly, decode, store — through the real client and the real reassembler, with the captured 2026-09-08 payloads as what the double serves. Both components segment, so the flow control genuinely goes out.

⚠️ That proves the client is well-behaved against the framing this repo believes in. It proves **nothing** about the timing: the double emits no kernel stamp and answers in 2 ms on an idle laptop. The number comes from the bike, once, and until then this path ships with the stopped-service script as its fallback.

- **Under ~10 ms** — the design is sound and this section records the measurement.
- **Tens of ms** — that is the negative result, quantified, and `--lifetime --save` remains the way to take a reading.

Named up front as the thing to suspect if it is bad: `better-sqlite3` is this repo's one sanctioned synchronous API, and a log write landing between a First Frame and its answer is precisely the "nothing may sit between" that `multiframe-transfer.ts` forbids. It is mitigated by _when_ this runs — parked, gated, bus quiet, log-on-change at its floor — but it is the first place to look.

## What the store keeps, and why it keeps bytes

`vcu-params/lifetime.json` holds the **payloads**, not the rendered numbers. The decode is an inference and this repo has already changed its mind about one field's scaling; storing today's reading of the bytes would freeze it into a file nobody would think to re-examine. Bytes re-decode. `src/vcu/lifetime-store.ts`.

Two writes are **refused**: one where nothing answered, and one carrying fewer replies than the file already holds. Taking a reading needs the service stopped and `can0` up ACTIVE, so "the bike was asleep" is the likeliest run of all, and letting it overwrite the file would destroy payloads that cost a trip to the garage. ⚠️ **Every run is archived anyway**, refused or not, as `lifetime-<timestamp>.json` — refusing the overwrite without keeping the bytes is how #160 lost a set of them.

A reading where only one component answered is stored and labelled `complete: false` rather than discarded — `src/vcu/snapshot-store.ts` rule 3, for the same reason.
