# GPS gaps: what CAN can and cannot fill

Why the ride map has holes, how much riding is in them, and which of it the raw CAN captures could put back. Opened from Daniel's question on 2026-09-20: _"for the segments where we don't have GPS data cuz the BLE connection dropped — it's not recoverable from our CAN dumps?"_ Issue #309.

Measured against `rides.db` at **mtime 2026-09-19 18:15:07 CEST** (shared mutable — other tracks re-import it, so every figure here carries that vintage), the 79 captures in `~/Documents/cool-eva-route/data/ride-captures/`, and the journal export in `~/Documents/cool-eva-route/data/pi-journals/`. No coordinates appear in this file, deliberately — same rule as `docs/route-map.md`.

## The short answer

**No — and the premise was wrong twice over.**

1. **GPS is not BLE-only.** Position has been on CAN `0x410` since #22 (2026-08-02), decoded live by the service through the same pure decoder the BLE path uses. A wedged Bluetooth adapter costs odometer, trip, range and fault data (#299 measured exactly that) but **no position at all**.
2. **The holes are mostly not lost position.** 270 of 316 dark windows — 330 hours — are a **parked bike**: `gps_lat` carries a 0.00003° (~3.3 m) deadband, so a stationary bike logs nothing and there is nothing to recover.
3. **Where position really is missing, the bus is usually missing it too.** On the five days we hold captures, **5.8 km of 56.0 dark km (10.4 %) had a usable fix on the bus that never reached the log.** The single largest gap in the archive — 42.1 km — had **zero** fixes on the bus.

So a backfill importer is possible but small, and it is not the fix.

## How much riding is unmapped

|                                                                       | km        | of 4 739.4 ridden |
| --------------------------------------------------------------------- | --------- | ----------------- |
| dark windows > 20 s (neither `gps_lat` nor `gps_epoch_s`)             | **145.9** | **3.1 %**         |
| ⤷ of which time-attributable (ordinary 0.1 km counts inside a window) | 101.8     | 2.1 %             |
| ⤷ of which restart-boundary (real distance, unplaceable in time)      | 44.1      | 0.9 %             |
| upper end, counting every restart-boundary increment archive-wide     | ~205      | ~4.3 %            |

**The width of that range is itself the finding.** The archive cannot currently say to better than a factor of ~1.4 how much riding is unmapped, because `odometer_can_km` timestamps are not comparable across a service restart. See [The distance measure is an open problem](#the-distance-measure-is-an-open-problem).

## What the dark windows actually are

316 windows, classified from `rides.db` alone before any capture is opened:

| class                                                                      | windows | km        | hours |
| -------------------------------------------------------------------------- | ------- | --------- | ----- |
| **(a) stationary** — parked, distance deadband; nothing missing            | 270     | **0.0**   | 330.3 |
| **(f) service restart** — `session_id` changes across the window           | 11      | **113.4** | 573.6 |
| **(e) stream alive, no usable fix** — `gps_satellites` logged, no position | 33      | **29.9**  | 107.7 |
| needs a capture to decide                                                  | 2       | 2.6       | 0.6   |

⚠️ **(a) is the headline for anyone reading the map.** A 63-minute "GPS gap" on 2026-09-18 resolves to 2 `gps_lat` rows against **3 799 `gps_epoch_s` rows**, 0.0 km of odometer advance and a peak speed of 8.5 km/h. The service had position for the whole hour. The map is not missing a ride; the bike was standing still.

✅ **(e) is confirmed at the source.** Satellite counts logged _inside_ dark windows: **0 × 165 rows, 3 × 146 rows**, and only 57 rows at 4 or above. `src/gps/decode.ts#decodeUtc` gates on `satellites >= 4`, so the receiver simply did not have a fix to give — on either transport.

## What the captures say, for the days we hold them

Every dark window on 2026-08-02/03/04 and 09-18/19 was tested against the raw bus: a per-minute census over the window **interior** (never the boundary minute, or the minute in which the signal returns votes for recovery — review finding S7), then the **real** `GpsMessageDecoder` over the candidates, requiring **two mutually consistent anchored fixes** before calling anything recoverable.

| verdict                                                          | windows | km      |
| ---------------------------------------------------------------- | ------- | ------- |
| **recoverable — a fix was on the bus and never reached the log** | 7       | **5.8** |
| no fix on the bus — nothing to recover                           | 6       | 46.5    |
| no local capture covers the interior                             | 1       | 0.9     |

**5.8 km of 56.0 — 10.4 %.** ⚠️ **Do not extrapolate this to the archive.** One window (42.1 km) is 75 % of the sample and recovered nothing; a rate estimated from that is a rate estimated from one event.

### The worked example — 2026-09-18, 42.1 km, and why none of it comes back

The archive's single largest dark window, 12:08:12Z → 13:36:48Z, decomposed from the capture and the journal together:

| true CEST     | event                                                                     | source              |
| ------------- | ------------------------------------------------------------------------- | ------------------- |
| 14:08:12      | last GPS row — window starts                                              | rides.db            |
| 14:08 → 15:34 | bus at **~80 000 frames/min**, `0x410` **entirely absent** for 87 minutes | capture, per-minute |
| 15:34         | `0x410` returns — GPS sub-frames present, **fix count 0**                 | capture             |
| 15:35         | `0x410` **seed only** (81 × `00 FF`, 0 × `1A`)                            | capture             |
| 15:36         | first usable fix — 21 frames with fix ≠ 0 and ≥ 4 satellites              | capture             |
| 15:36:48      | first GPS row — window ends                                               | rides.db            |

The log resumed in the same minute the bus had something to give it. **A capture cannot fill what was never transmitted**, and for 87 minutes nothing was.

⚠️ **`rides.db` alone called this window (f) restart**, because `session_id` changes inside it. The capture shows the restart was not the cause — the hub had no GPS either side of it. **A restart and a hub outage coincide often enough that `session_id` must not be read as the cause.**

### Independent transports, common source

For the whole of a separate 843 s window the same day, the BLE side cycled `connected` → `no frames for 30 s` → `reconnecting`, and `session confirmed — telemetry streaming` landed at **17:08:13** — the same second `1A` returned on CAN, and the same second the `gps_epoch_s` gap ended. The two transports are independent paths; **the hub that feeds both is not**. That is the mechanical reason CAN cannot cover for BLE: when the source stops producing, both go quiet together.

🔎 The `00 FF` seed heartbeat is the sharper outage detector than "no `1A`": `src/can/gps.ts` documents it at ~0.9 Hz independent of any BLE session, so its absence says the emitter was silent rather than fixless. Seed returned at 17:08:05.142284 and the first `1A 00` at 17:08:13.630791 — 8.5 s of _hub alive, GPS subsystem not reporting_, which is its own state.

## 90 % of the evidence is still on the Pi

`CARD-LISTING.tsv`: **625 capture files, 88.0 GiB on the card, 80 verified on the Mac, 545 card-only (83.1 GiB)** across 27 capture days against the 5 held here. `MANIFEST.README.md` records why — _"The pull stopped because the bike left the LAN, not because it finished."_

**89.9 of the 145.9 dark km (62 %) is on days whose captures have never been pulled.** Both windows that `rides.db` alone could not classify fall on card-only days. Finishing the pull (#288, #289) is the only thing that turns that distance into evidence — and it is the one recommendation here that does not depend on any contested number.

## Aligning a capture to the log

Three traps, all of which cost a review round:

1. **candump stamps are the Pi's local clock (CEST); `rides.db` is UTC.** Measured: `stamp − satellite UTC` = 7 200 s on 9 459 frames, 7 201 on 2 794, 7 198 on 34 in one capture.
2. **Stamps are not monotonic within a file and not comparable across files.** Three clock sources move them — `cool-eva … clock: … stepped to <ISO>` (matches the first post-jump frame to the millisecond), `systemd-timesyncd … Initial clock synchronization` (to microseconds), and the boot-time `System time advanced to timestamp on /var/lib/systemd/timesync/clock` restore that makes a fresh boot start _behind_, which is why three 2026-09-18 capture filenames land 12 s apart across three different boots. **Filename order is not time order.**
3. **So anchor on the satellite UTC in the `1A FE` sub-frame**, which is absolute and needs no reconciliation at all. Everything in the table above was matched that way.

`INDEX.txt`'s `journalctl --list-boots` table carries full boot ids, and their first 8 hex are the capture filename suffix — so capture ↔ boot needs no Linux box. ⚠️ Journal retention starts **2026-09-15 04:12 CEST**; the August captures cannot be reconciled against a journal at all.

## The distance measure is an open problem

Four measures were tried. All four are wrong, each in a direction now named — recorded here because "just bracket the odometer" is the obvious idea and the next reader will have it too.

| measure | failure |
| --- | --- |
| in-window `max − min` | **under** — a dark window contains few rows by construction |
| bracket `[last row ≤ start, first ≥ end]` | **over** — 153 of 307 brackets overlap their neighbour's, spanning 44.9 km |
| per-increment with a `Δ ≤ 1 km` filter | **under** — deletes ~93 km of restart-boundary distance, which is exactly the subject |
| session-partitioned | **over** — 17 session pairs overlap in odometer range by −548.8 km |

Why the filter fails: `odometer_can_km` has **no deadband** (`src/can/registry.ts:550`), so it logs every 0.1 km. A Δ > 1 km therefore means ten-plus counts were never written — the logger was down — which is _dark by construction_. 44 of the 49 such increments sit at a `session_id` boundary (93.3 km) and 41 have dt < 10 s (89.8 km); 2 km in 3 s is not a bike, so the **timestamps** are wrong across a restart, not the odometer. The remaining 5 increments (10.4 km) are not at a boundary and are unexplained.

❌ **A "does the jump persist N rows later?" test does not discriminate** and must not be used: it is monotone in the horizon and saturates, because the odometer is a monotonic counter and the bike keeps riding — 17 of 49 "persist" at a 5-row horizon, 34 at 20, **49 of 49 at 100 and at 500**. It measures the horizon, not the jump.

❓ **Open:** a distance measure that survives restart boundaries. It needs the timestamp defect fixed first, which is not specific to GPS — it silently affects any per-window quantity computed from `reading`.

## What to do instead

1. **Finish the card pull** (#288, #289). 62 % of the unmapped distance is unmeasurable until it lands, and no other number here can move without it.
2. **Draw the gaps on the map.** `scripts/route-track.ts` carries lat and lon forward onto each other with no time limit, and `gps_speed_kmh`/`gps_course_deg` are emitted on the `1A 00` sub-frame _regardless of fix_ — so a no-fix stretch draws a **stale-position stack plus a long join**, not a hole. A window with real odometer advance and no fix should read as "no fix here, N km, M min", never as track. `docs/route-map.md` already splits rides on a 30-minute GPS hole and already records under "Known limitations" that km comes from the odometer so distance stays right where the track does not.
3. **A backfill importer is worth ~10 % of the dark distance** on present evidence, which is real but small, and the estimate rests on one event. Re-measure after the pull before building it.
4. **Fix the restart-boundary timestamps.** That defect is what makes the headline a range instead of a number.
